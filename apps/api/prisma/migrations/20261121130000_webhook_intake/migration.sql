-- =============================================================================
-- F12 - card webhook intake (the assessment's optional bonus, section 10)
--
-- Three changes, in dependency order:
--   1. an expense SOURCE, which joins the idempotency key
--   2. one webhook integration per company, holding an encrypted signing secret
--   3. a durable event inbox, with the queue-claim index the worker needs
--
-- WRITTEN BY HAND rather than generated. `prisma migrate diff` produced this
-- shape but omitted `CREATE TYPE "ExpenseSource"` while still referencing it in
-- the ALTER TABLE below - the generated file would have failed on any fresh
-- database. See AI_LOG 54.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Expense source
--
-- The unique constraint moves from (companyId, externalId) to
-- (companyId, source, externalId). This does NOT weaken idempotency: for an
-- ordinary caller the source is always 'API', so (companyId, 'API', externalId)
-- is exactly as unique as the old key was, and a company's backend still cannot
-- create two expenses under one identifier.
--
-- What it adds is a second namespace the first cannot collide with. A card
-- provider's transactionId is chosen by somebody the company's backend has
-- never spoken to, and a reserved prefix could not keep them apart, because an
-- ordinary client picks the whole externalId string itself.
-- -----------------------------------------------------------------------------

CREATE TYPE "ExpenseSource" AS ENUM ('API', 'CARD_WEBHOOK');

-- DEFAULT 'API' is what makes this safe on a table with rows in it: every
-- existing expense came from the API, which is true by construction because no
-- other path existed before this migration.
ALTER TABLE "expenses" ADD COLUMN "source" "ExpenseSource" NOT NULL DEFAULT 'API';

-- Drop then create, not rename: the column list differs.
DROP INDEX "expenses_companyId_externalId_key";

CREATE UNIQUE INDEX "expenses_companyId_source_externalId_key"
  ON "expenses"("companyId", "source", "externalId");

-- -----------------------------------------------------------------------------
-- 2. Webhook integrations
--
-- The signing secret is ENCRYPTED, not hashed, and that asymmetry with
-- api_keys is deliberate. HMAC verification needs the key material itself -
-- the provider sends a MAC computed with the secret, and checking it means
-- computing the same MAC, which a digest cannot do.
--
-- AES-256-GCM: three columns because GCM needs all three to decrypt, so none
-- can be stored without the others. The key lives in WEBHOOK_ENCRYPTION_KEY,
-- never in this database, so a dump is inert on its own.
-- -----------------------------------------------------------------------------

CREATE TABLE "webhook_integrations" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "secretCiphertext" BYTEA NOT NULL,
    "secretIv" BYTEA NOT NULL,
    "secretAuthTag" BYTEA NOT NULL,
    "secretVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "rotatedAt" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_integrations_pkey" PRIMARY KEY ("id")
);

-- One integration per company. This UNIQUE is what makes the relation
-- one-to-one rather than one-to-many.
CREATE UNIQUE INDEX "webhook_integrations_companyId_key"
  ON "webhook_integrations"("companyId");

-- The lookup the verifier performs on every delivery, before it knows whether
-- the request is genuine. It must be an index, not a scan.
CREATE UNIQUE INDEX "webhook_integrations_deliveryId_key"
  ON "webhook_integrations"("deliveryId");

ALTER TABLE "webhook_integrations"
  ADD CONSTRAINT "webhook_integrations_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- 3. The durable event inbox
--
-- The provider retries until it gets a 2xx, so a 2xx is a promise that the
-- event will be processed. An in-memory queue cannot keep that promise across
-- a restart. This table is where "accepted" is written, in the transaction
-- that answers the provider.
-- -----------------------------------------------------------------------------

-- IGNORED is a terminal, NON-error state: a valid, authenticated event whose
-- type this service does not handle. It is accepted rather than refused
-- because the provider retries until it gets a 2xx, so refusing forever would
-- be an infinite retry loop.
CREATE TYPE "WebhookEventStatus" AS ENUM (
  'PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED'
);

CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    -- The company this event was AUTHENTICATED as, never one the body claimed.
    "companyId" UUID NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    -- Over the event type and its business payload. Excludes the delivery
    -- timestamp and the signature, which change on a legitimate replay.
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Backoff lives in this column, not in a sleep a restart would forget.
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- The worker's lease. A claim older than it belongs to a dead worker.
    "claimedAt" TIMESTAMPTZ(3),
    "processedAt" TIMESTAMPTZ(3),
    -- No foreign key, deliberately: a RESTRICT here would let an inbox row
    -- block an expense from ever being removed.
    "expenseId" UUID,
    -- Sanitised where it is written. Never a raw exception message.
    "lastError" TEXT,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);


-- DELIVERY deduplication, scoped to the company that was authenticated.
--
-- This is a DIFFERENT guarantee from expense idempotency and both are needed:
-- this one stops a redelivered event from being processed twice, while the
-- expense unique index stops two different events about one transaction from
-- creating two expenses. Neither subsumes the other.
CREATE UNIQUE INDEX "webhook_events_companyId_providerEventId_key"
  ON "webhook_events"("companyId", "providerEventId");

-- The worker's claim query: the oldest due row, or one whose lease expired.
CREATE INDEX "webhook_events_status_nextAttemptAt_idx"
  ON "webhook_events"("status", "nextAttemptAt");

-- The administrator's listing: one company's events, newest first.
CREATE INDEX "webhook_events_companyId_receivedAt_idx"
  ON "webhook_events"("companyId", "receivedAt");

ALTER TABLE "webhook_events"
  ADD CONSTRAINT "webhook_events_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
