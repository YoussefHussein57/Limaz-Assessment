-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('MANAGER', 'PLATFORM_ADMIN');

-- CreateEnum
CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'ROTATING', 'REVOKED');

-- CreateEnum
CREATE TYPE "ExpenseDecision" AS ENUM ('APPROVE', 'REVIEW', 'REJECT');

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('APPROVED', 'REJECTED', 'PENDING_REVIEW');

-- CreateEnum
CREATE TYPE "ReviewState" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ReviewOutcome" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RuleCode" AS ENUM ('AMOUNT_LIMIT', 'FREQUENCY', 'BLOCKED_CATEGORY');

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policies" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "autoApproveLimitMinor" INTEGER NOT NULL,
    "frequencyMaxCount" INTEGER NOT NULL DEFAULT 3,
    "frequencyWindowMinutes" INTEGER NOT NULL DEFAULT 60,
    "blockedCategories" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "companyId" UUID,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "keyHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "merchant" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "spentAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decision" "ExpenseDecision" NOT NULL,
    "status" "ExpenseStatus" NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "policySnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_hits" (
    "id" UUID NOT NULL,
    "expenseId" UUID NOT NULL,
    "ruleCode" "RuleCode" NOT NULL,
    "decision" "ExpenseDecision" NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_hits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL,
    "expenseId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "state" "ReviewState" NOT NULL DEFAULT 'OPEN',
    "outcome" "ReviewOutcome",
    "resolvedByUserId" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "policies_companyId_key" ON "policies"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_companyId_idx" ON "users"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "api_keys_companyId_idx" ON "api_keys"("companyId");

-- CreateIndex
CREATE INDEX "expenses_companyId_employeeId_spentAt_idx" ON "expenses"("companyId", "employeeId", "spentAt");

-- CreateIndex
CREATE INDEX "expenses_companyId_spentAt_idx" ON "expenses"("companyId", "spentAt");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_companyId_externalId_key" ON "expenses"("companyId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_id_companyId_key" ON "expenses"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "rule_hits_expenseId_ruleCode_key" ON "rule_hits"("expenseId", "ruleCode");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_expenseId_key" ON "reviews"("expenseId");

-- CreateIndex
CREATE INDEX "reviews_companyId_state_idx" ON "reviews"("companyId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_expenseId_companyId_key" ON "reviews"("expenseId", "companyId");

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_hits" ADD CONSTRAINT "rule_hits_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_expenseId_companyId_fkey" FOREIGN KEY ("expenseId", "companyId") REFERENCES "expenses"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- CHECK CONSTRAINTS - added by hand
--
-- The Prisma schema language cannot express CHECK constraints, so these are
-- appended here. They are not cosmetic: each one makes a state that the
-- business rules forbid physically impossible to store, from ANY writer -
-- the application, a migration, or someone typing into psql.
--
-- Documented in docs/features/F01-database-and-seed.md and covered by tests
-- F01-T10 through F01-T12 and F01-T17.
-- =============================================================================

-- A MANAGER must belong to a company; the PLATFORM_ADMIN must not.
--
-- Without this, a MANAGER row with a NULL company_id would make every tenant
-- filter read `WHERE company_id = NULL`, which matches nothing in SQL - or, in
-- carelessly written code, gets dropped and matches everything.
ALTER TABLE "users"
  ADD CONSTRAINT "users_role_company_check"
  CHECK (
    (role = 'PLATFORM_ADMIN' AND "companyId" IS NULL)
    OR
    (role = 'MANAGER' AND "companyId" IS NOT NULL)
  );

-- An expense's final status must be reachable from its policy decision.
--
-- A decision other than REVIEW is final the moment it is made: no review is
-- opened, so no manager can change it. Only a REVIEW decision has a status
-- that is allowed to move.
ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_decision_status_check"
  CHECK (
    (decision = 'APPROVE' AND status = 'APPROVED')
    OR
    (decision = 'REJECT' AND status = 'REJECTED')
    OR
    (decision = 'REVIEW' AND status IN ('PENDING_REVIEW', 'APPROVED', 'REJECTED'))
  );

-- Money is stored in minor units and cannot be negative.
ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_amount_non_negative_check"
  CHECK ("amountMinor" >= 0);

-- A review is either fully open or fully resolved - never half of each.
--
-- The assessment requires a record of who resolved each review, when, and how.
-- This makes a resolved review with no recorded reviewer unstorable rather
-- than merely discouraged.
ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_state_resolution_check"
  CHECK (
    (
      state = 'OPEN'
      AND outcome IS NULL
      AND "resolvedByUserId" IS NULL
      AND "resolvedAt" IS NULL
    )
    OR
    (
      state = 'RESOLVED'
      AND outcome IS NOT NULL
      AND "resolvedByUserId" IS NOT NULL
      AND "resolvedAt" IS NOT NULL
    )
  );

-- Policy settings must be physically meaningful.
ALTER TABLE "policies"
  ADD CONSTRAINT "policies_sane_values_check"
  CHECK (
    "autoApproveLimitMinor" >= 0
    AND "frequencyMaxCount" >= 1
    AND "frequencyWindowMinutes" >= 1
  );
