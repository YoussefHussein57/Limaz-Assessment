# F12 - Card webhook intake

**The assessment's section 10, the optional bonus.** Card transactions arrive
as signed webhooks and become expenses that go through the same policy rules
as everything else.

Built only after the mandatory core was finished, verified and tagged
`v1.0.0-core`, which is what the brief asks: *"do this only once the core
works."*

---

## 1. What the assessment asks for, and where each part is

| What section 10 says | Where it is |
|---|---|
| The provider sends a webhook when a transaction settles | `POST /v1/webhooks/card-transactions` |
| Each one becomes an expense that goes through the same policy rules | `WebhookProcessorService` calls `ExpenseSubmissionService.submit` - the same entry point `POST /v1/expenses` uses |
| It signs each request with a per-company secret, HMAC-SHA256 over a timestamp and the raw body | `webhook-crypto.ts`, verified over `request.rawBody` |
| It retries until it gets a 2xx, so the same event can arrive more than once | 202 after the commit; `@@unique([companyId, providerEventId])` |
| It cannot send your API key | The route is `@Public()` and authenticates on the signature alone |
| Work out which company it belongs to without trusting the payload | The company comes from the integration whose secret verified it |
| Make sure each transaction becomes exactly one expense | `externalId = transactionId`, under the existing idempotency constraint |
| Process events asynchronously (BullMQ is one option) | A PostgreSQL inbox and a `FOR UPDATE SKIP LOCKED` worker |
| Explain what happens when your queue is down | §9 below |
| Explain how you would find events the provider never delivered | §9 below |

---

## 2. The delivery contract

```
POST /v1/webhooks/card-transactions
x-limaz-webhook-id: whi_<22 chars>
x-limaz-timestamp:  <unix seconds>
x-limaz-signature:  <64 lowercase hex>
content-type: application/json

{
  "id": "evt_8f2c1",
  "type": "transaction.settled",
  "createdAt": "2026-11-20T09:15:02Z",
  "data": {
    "transactionId": "txn_5531",
    "cardholderId": "emp-7",
    "amount": 12500,
    "currency": "SAR",
    "merchant": "City Taxi",
    "category": "TRANSPORT",
    "spentAt": "2026-11-20T09:15:00Z"
  }
}
```

The body is the provider's shape, verbatim from the assessment. The field
names are **not renamed on the way in**; `cardholderId` becomes our
`employeeId` and `transactionId` becomes our `externalId` in exactly one place
- the processor - so the translation is a line of code rather than a
convention spread across four files.

**Signed material:** `${timestamp}.${rawBody}`

Three headers rather than one combined `t=...,v1=...`, because each then has
one job and a reviewer can construct a request by hand without parsing
anything.

### Responses

| Status | Meaning |
|---|---|
| `202` + `ACCEPTED` | Committed to the inbox. **No expense exists yet** |
| `202` + `DUPLICATE` | Already received. Nothing further was created |
| `202` + `IGNORED` | Authenticated, stored, and deliberately not processed - an event type this service does not handle |
| `400` | Malformed JSON, or a payload field that is not what it claims |
| `401` | Signature, timestamp or webhook id not accepted. **One shape for every cause** |
| `409` | This event id already describes a different payment |
| `413` | Larger than the body limit |

**202, not 201.** The event is stored; no expense exists. "Created" would be a
lie told by a status code, and a provider dashboard showing it for an event
that policy will REJECT is worse than no status at all.

---

## 3. Why the signature is verified over the RAW bytes

This is the single most important line in the feature.

```ts
// main.ts
NestFactory.create(AppModule, { rawBody: true })
```

`JSON.parse` followed by `JSON.stringify` is **not** the identity function. It
normalises whitespace, drops insignificant formatting, re-encodes unicode
escapes and renders `1.0` as `1`. Any one of those changes the bytes, and an
HMAC is over bytes.

A verifier built on the parsed object therefore:

- **fails every pretty-printed delivery**, intermittently, depending on how
  the provider happened to serialise that request
- **can be made to verify a body that differs from the one the application
  then acts on**, which is the serious half

F12-T19 is the test that pins it: the same object, delivered with
`JSON.stringify(event, null, 2)`, is refused.

### The separator is load-bearing too

`${timestamp}.${rawBody}`, not `${timestamp}${rawBody}`. Without the dot,
timestamp `1` with body `23{...}` and timestamp `12` with body `3{...}`
produce the same signed string (F12-U31).

---

## 4. Why the signing secret is encrypted, when every other credential is hashed

`ApiKey` and `Session` store only a SHA-256 hash, and ADR-006 defends that at
length. It works because the server is **handed** the credential and only has
to decide whether it matches.

HMAC cannot work that way. The provider never sends the secret - it sends a
MAC computed **with** the secret, and checking it means computing the same
MAC, which needs the key material itself. There is no digest that can stand
in: HMAC keyed with `sha256(secret)` is a different function from HMAC keyed
with `secret`, so it would simply never match.

So the secret has to be recoverable, and the real question is *by whom*:

| Option | Verdict |
|---|---|
| Plaintext column | A database dump is a set of working signing keys |
| **Encrypted column, key in configuration** | **Chosen.** A dump is inert without `WEBHOOK_ENCRYPTION_KEY` |
| External KMS or HSM | The correct production answer, and an entire subsystem the assessment does not ask for |

This is genuinely weaker than hashing, and it is recorded as **R-35** rather
than presented as equivalent.

### AES-256-GCM, and the company id as additional authenticated data

GCM is **authenticated**: a tampered ciphertext fails the tag and `decrypt`
throws. With CBC it would decrypt to garbage, which would then be used as an
HMAC key, which would fail to verify - and the failure would look exactly like
"the provider is sending bad signatures". Somebody would spend an afternoon on
the wrong side of the problem.

The company id is passed as AAD. It is not encrypted; it is **bound**. Moving
company A's ciphertext into company B's row - the injection somebody with
database write access would actually try - makes the tag check fail
(F12-U13).

---

## 5. Which company a delivery belongs to

The assessment is explicit: without trusting the payload, and the provider
cannot send our API key.

```
x-limaz-webhook-id  ->  selects WHICH secret to verify against
the signature       ->  decides whether the request is genuine
the integration row ->  says which company that secret belongs to
```

The delivery id is **untrusted lookup input**. It is public - it is shown in
full on the company page - and knowing it grants nothing: an attacker who
names another company's delivery id is checked against that company's secret,
which they do not hold (F12-T17).

The body is never consulted for tenancy. There is no company field in the
event schema at all, so there is no field to ignore (F12-T41).

### Constant work for an unknown delivery id

An unknown id would otherwise return after one indexed SELECT while a known
one additionally decrypts and computes an HMAC - and the difference in timing
says which delivery ids exist. So the HMAC runs either way, against a dummy
secret. The same reasoning as `PasswordService.dummyHash`, applied to the
other credential.

---

## 6. The three timestamps, which are not the same thing

Conflating them is the classic webhook bug.

| | What it is | What bounds it |
|---|---|---|
| **Signature timestamp** | When this HTTP request was signed | `WEBHOOK_TOLERANCE_SECONDS`, default 300 |
| **Transaction time** (`spentAt`) | When the money was spent | A4: 90 days back, 5 minutes forward. Also the frequency window |
| **Processing time** | When a worker evaluated it | Recorded. Never used to decide anything |

A payment from last Tuesday, redelivered this morning because the provider was
down, is **legitimate**: an old transaction time with a fresh signature.
Rejecting it because `spentAt` is old would drop real expenses. Accepting a
week-old *signature* would make a captured request replayable for a week.

The future bound is not symmetry for its own sake: without it, a captured
request signed years ahead stays replayable until that date arrives
(F12-T21).

---

## 7. Two different deduplication guarantees, and why both are needed

```
DELIVERY deduplication     @@unique([companyId, providerEventId])
  stops a redelivered event being PROCESSED twice

EXPENSE idempotency        @@unique([companyId, source, externalId])
  stops two different events about one transaction creating two expenses
```

Neither subsumes the other. The first is about the provider's retry loop; the
second is about the payment. An event id identifies a *delivery*; a
transaction id identifies a *payment*, and the assessment's guarantee is that
each **transaction** becomes exactly one expense - so `externalId` is the
transaction id, not the event id.

### Payload identity excludes delivery metadata

The event's `payloadHash` covers the type and the business fields. It
**excludes** `createdAt`, the signature timestamp and the signature itself,
because a legitimate replay is signed afresh: those change while the payment
has not. Folding them in would make every retry look like a conflicting event,
and the provider could never successfully redeliver anything (F12-T51).

### Why `source` joined the expense key

A card provider's `transactionId` is chosen by somebody the company's backend
has never spoken to. A reserved prefix cannot keep the two namespaces apart,
because an ordinary client picks the **whole** `externalId` string itself and
could choose one that looks like a transaction id - deliberately or by
accident.

So the source is part of the key instead. This does **not** weaken anything:
for an ordinary caller the source is always `API`, so
`(companyId, 'API', externalId)` is exactly as unique as `(companyId,
externalId)` was, and F12-T92 asserts a company's backend still cannot create
two expenses under one identifier.

---

## 8. Durable acceptance, and asynchronous processing

### Why a table and not BullMQ

The assessment names BullMQ as "one option", and it is a good one. It is also
Redis - a second stateful service in a deployment whose entire promise is one
`docker compose up` - and a second place an accepted event can exist, which
raises the question this design avoids: *what is true if the row committed and
the enqueue did not?*

Here there is one store. "Accepted" and "queued" are the same fact, written
once, in the transaction that answers the provider.

The costs are real and are written down rather than glossed:

- **polling, not push.** An idle worker wakes every
  `WEBHOOK_POLL_INTERVAL_MS`. At this volume that is nothing; at thousands of
  events a second it would not be the right answer.
- **the database does two jobs.** Queue traffic competes with query traffic.
- **no scheduling features.** No priorities, no dead-letter queue beyond
  `status = FAILED`, and no jitter on the backoff (**R-37**).

### The claim

```sql
UPDATE webhook_events
SET status = 'PROCESSING', "claimedAt" = now(), attempts = attempts + 1
WHERE id = (
  SELECT id FROM webhook_events
  WHERE (status = 'PENDING' AND "nextAttemptAt" <= now())
     OR (status = 'PROCESSING' AND "claimedAt" < now() - <lease>)
  ORDER BY "nextAttemptAt", "receivedAt"
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING ...
```

`FOR UPDATE SKIP LOCKED` is what makes two workers unable to claim one event:
the row is locked by the SELECT, the surrounding UPDATE changes its status in
the **same statement**, and a competitor steps over the locked row rather than
waiting. Both make progress; neither gets the same event (F12-T73).

A SELECT followed by an UPDATE is the read-then-write race F04 exists to
teach. An advisory lock would also work and is what F04 uses - but that
serialises every claim through one lock, and claiming is exactly the operation
that should be parallel.

`attempts` is incremented **as part of claiming**. An event that crashes the
worker every time still advances towards its bound; counting on completion
would retry it forever.

### Crash recovery is a timestamp comparison

There is no heartbeat and no distributed lock. The claim writes `claimedAt`;
the second branch of the query above matches rows still `PROCESSING` with a
`claimedAt` older than the lease, which can only be true if the worker holding
them stopped.

---

## 9. The two questions the assessment asks to be explained

### What happens when the queue is down

The queue is a table in the same PostgreSQL the rest of the application uses,
so "the queue is down" and "the database is down" are the same event. That
collapses the interesting failure modes into one, and the answer is clean:

- **Acceptance fails too.** The insert cannot commit, so no 2xx is returned,
  so the provider keeps retrying. **Nothing is lost** - the promise a 2xx
  makes is never made.
- **In-flight processing fails.** The worker's writes roll back. The event
  stays `PROCESSING` with an old `claimedAt`, and is reclaimed when the lease
  expires.
- **On recovery, the worker resumes.** Everything due is claimed in
  `nextAttemptAt` order. No backlog is dropped, because the backlog is rows.

With a separate queue the answer would be worse: the row could commit while
the enqueue failed, leaving an event that is accepted and will never be
processed - exactly the state this shape makes unreachable.

### How to find events the provider never delivered

**This system cannot, on its own, and that is worth saying plainly.** An event
that never arrived leaves no trace here. Nothing in this repository
reconciles against the provider.

What it would take, in order of cost:

1. **A gap check**, if the provider's event ids are sequential per company -
   the assessment's `evt_8f2c1` gives no reason to think they are.
2. **A reconciliation job** against the provider's "list transactions" API for
   a window, comparing against `webhook_events` and submitting whatever is
   missing through the same processor. This is the real answer, and it needs a
   provider API this integration does not have.
3. **A liveness alert**: no event from a company in N hours is either a quiet
   period or a broken integration. Cheap, weak, and genuinely useful.

Recorded as **R-38**.

---

## 10. The sandbox payment simulator

An administrator-only tool that signs a synthetic provider event and
**delivers it over HTTP to the real endpoint**.

What makes it worth having rather than a toy:

- it does **not** call `ExpenseSubmissionService`
- it does **not** insert a `WebhookEvent`
- it does **not** compute an expected decision in the browser

Every decision on the screen is read back from the event row the server wrote
after the real policy engine ran. If signature verification broke, every
preset would start failing - which is exactly the property a demonstration
tool should have.

### Three security properties

| | |
|---|---|
| **No destination parameter** | The destination is built from `API_PORT` and a constant path on the loopback interface. A caller-supplied URL would make this an authenticated SSRF primitive, and the feature gains nothing from being configurable (F12-T134) |
| **The secret never leaves the server** | The signing happens in-process. The browser could not produce a valid signature if it tried, which is what makes the invalid-signature preset meaningful (F12-T103) |
| **An explicit flag, enforced in the service** | `SANDBOX_SIMULATOR_ENABLED`, **not** `NODE_ENV`. The Docker image sets `NODE_ENV=production` everywhere including a laptop - the signal that lied once before (AI_LOG 42). Checked in the service, so a disabled sandbox answers 404 to a direct API call (F12-T151) |

### The presets send real requests

None of them disables a check. `INVALID_SIGNATURE` signs with a key the server
does not hold; `EXPIRED_SIGNATURE` signs correctly for a timestamp outside the
tolerance. Both are refused by the same verifier that protects a real
provider.

`BLOCKED_CATEGORY` refuses to run when the company blocks nothing, rather than
editing the policy to make itself work - a simulator that changed the rule it
claims to demonstrate would be demonstrating nothing.

---

## 11. What is NOT built

| Not built | Why |
|---|---|
| Event types other than `transaction.settled` | The assessment defines one. Others are accepted and ignored, which is a defined behaviour rather than a gap |
| Reconciliation against the provider | Needs a provider API this integration does not have (R-38) |
| A retry button in the UI | A retry is a delivery the provider never sent. The worker's schedule is the retry mechanism |
| Backoff jitter | One worker and a small inbox; there is no herd to spread (R-37) |
| Webhook signing key rotation with a grace window | A secret lives in one place and the provider retries, so a changeover delays a delivery rather than losing it. Two valid secrets would keep a leaked one alive for a day |
| A separate "reveal secret" endpoint | It could exist - the secret is encrypted, not hashed - and is deliberately absent. One compromised administrator session should not be every company's signing key |

---

## 12. Tests

**100 cases**, all against real PostgreSQL except the crypto unit suite.

| Suite | Cases | What it covers |
|---|---|---|
| `webhook-crypto.spec.ts` | 20 | Sealing, AAD binding, tamper detection, signature shape and constant-time comparison |
| `webhook-intake.e2e-spec.ts` | 37 | Provisioning, every signature failure mode, raw-body verification, validation, tenancy, delivery deduplication |
| `webhook-worker.e2e-spec.ts` | 20 | Claiming, the real policy engine, retry classification, the crash window, concurrent claims, namespaces |
| `simulator.e2e-spec.ts` | 23 | Real delivery, failure presets, replay, authorization, the disabled sandbox, the event history |

The signature is computed **independently** in both the test client and
`scripts/send-card-webhook.mjs`. If both sides came from `computeSignature`, a
mistake in it would be symmetric and invisible - the tests would agree with
the implementation and both would disagree with a real provider.
