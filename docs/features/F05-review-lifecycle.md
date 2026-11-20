# F05 - Review lifecycle, manager resolution and concurrency

**Status:** Implemented, awaiting project-owner approval
**Date:** 2026-11-20
**Depends on:** F00, F01, F02, F03, F04
**Blocks:** F06, F07

## Objective

A company manager lists the reviews their company owes a decision on,
inspects one with its expense and every policy reason, and approves or
rejects it. Exactly one resolution ever wins, the automated decision is never
rewritten, and the audit trail names the manager who actually acted.

## No migration

F01 already provided every invariant this feature needs.

```sql
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_expenseId_companyId_fkey"
  FOREIGN KEY ("expenseId", "companyId") REFERENCES "expenses"("id", "companyId")
```

A review's `companyId` is **not** an independent copy that could drift from
its expense's. It is half of a composite foreign key, so a row naming two
different tenants is physically unstorable (ADR-011). That is why the
conditional UPDATE can put the tenant guard in its own `WHERE` clause and
trust it.

```sql
CHECK ((state='OPEN'     AND outcome IS NULL     AND "resolvedByUserId" IS NULL     AND "resolvedAt" IS NULL)
    OR (state='RESOLVED' AND outcome IS NOT NULL AND "resolvedByUserId" IS NOT NULL AND "resolvedAt" IS NOT NULL))
```

A half-resolved review is unstorable too: the database refuses a partial
update rather than relying on application code to write all three fields.

---

## The API

| Route | Who | What |
|---|---|---|
| `GET /v1/reviews` | manager | OPEN reviews for their company, newest first |
| `GET /v1/reviews/:id` | manager | one review, its expense, every reason, the snapshot |
| `POST /v1/reviews/:id/resolve` | manager | `{ "decision": "APPROVE" \| "REJECT" }` |

`POST ... /resolve` answers **200**, not Nest's default 201. It creates
nothing - it transitions a review that already exists - and the retry contract
depends on it: a replayed resolution returns 200 having written nothing, which
would be incoherent if the first call had claimed to create a resource.

### Authorization is one decorator

```ts
@Roles('MANAGER')
@Controller('v1/reviews')
```

| Caller | Result | Why |
|---|---|---|
| Manager, own company | allowed | - |
| Manager, another company | **404** | the tenant predicate is in the query |
| **Company API key** | **403** `caller_type_not_allowed` | `@Roles` implies a human caller; a key has no role |
| **Platform admin** | **403** `insufficient_role` | not a MANAGER |
| Unauthenticated | 401, or 403 at the CSRF layer | never reaches the handler |

**The platform admin is denied rather than assumed.** Reviewing a company's
spending is that company's business, and no approved contract grants an
administrator that authority. None of this is new code - the F02 guards
already answer these questions.

CSRF is inherited too: `CsrfGuard` runs first on every state-changing request
that is not API-key authenticated, so resolution requires `x-limaz-client` and
a matching `Origin` exactly as login does.

---

## Pagination

Keyset, ordered `(createdAt DESC, id DESC)`, bounded at 100 with a default
of 50.

**Offset was rejected on a concrete failure, not on taste.** The default
listing is OPEN reviews, and that set *shrinks while it is being read* -
every resolution removes a row, the rows after it shift up, and page 2 begins
past the ones that moved. The manager silently never sees them. Offset here
drops work.

### The cursor is a pair, and the first reason given for that was wrong

The cursor carries `(createdAt, id)` for two reasons:

1. **`createdAt` is `Timestamptz(3)` - one millisecond of resolution.** Any
   bulk insert, import or backfill can produce ties, and a cursor on
   `createdAt` alone would skip or repeat whichever rows share that instant.
2. **`id` is a UUIDv7, which is *approximately* time-ordered.** Its timestamp
   and `createdAt` come from different sources and need not agree, so ordering
   by `id` alone would not match the `createdAt DESC` the API promises.

The original justification written here was that rows created in one
transaction share a `createdAt`, because the column defaults to
`CURRENT_TIMESTAMP` which is transaction-start time. **That is false** -
Prisma supplies the value per row from the client, so the default never fires.
A test asserted it and failed. The exposure is real; that explanation of it
was not (AI_LOG 31).

### It survives the cursor row disappearing

```ts
OR: [{ createdAt: { lt: c } }, { createdAt: c, id: { lt: id } }]
```

The cursor is compared as a **value**, never looked up as a row. Prisma's own
`cursor` option does a lookup and would break once that review is resolved and
leaves the OPEN set - which here is the normal case, not an edge case.

A forged cursor cannot cross tenants: `companyId` is in the same `WHERE` from
the session, so a bad cursor can only move a caller inside their own rows. A
malformed one is a **400**, not a silent reset to page one - silently starting
over makes a client paging a long list loop forever without being told why.

### Query shape, measured not claimed

`include` is widely assumed to compile to one joined query. It does not
always. The measurement:

```
--- statements per page: 4 for 5 rows, 4 for 50 rows ---
```

Ten times the rows, the same number of statements. The count is bounded by
the **shape** of the query and not by the number of rows, which is what "no
N+1" actually means. The figure is 4, not 1, which is exactly why the claim is
not made anywhere.

---

## Resolution

```sql
UPDATE "reviews"
   SET state = 'RESOLVED', outcome = $3,
       "resolvedByUserId" = $4,
       "resolvedAt" = resolution.at,
       "updatedAt"  = resolution.at
  FROM (SELECT clock_timestamp() AS at) AS resolution
 WHERE id = $1 AND "companyId" = $2 AND state = 'OPEN'
RETURNING "expenseId";
```

Then, **in the same transaction**:

```ts
tx.expense.updateMany({
  where: { id: expenseId, companyId, status: 'PENDING_REVIEW' },
  data: { status: ... },
});
```

If that affects anything other than exactly one row, the whole transaction
rolls back.

### Why the predicate must be in the mutation

Reading the review, checking `state === 'OPEN'` in memory, then updating is a
lost update waiting to happen. Both managers read OPEN, both pass the check,
both write, and the second silently overwrites the first's outcome, reviewer
**and** timestamp.

**A transaction does not fix this.** Transactions give atomicity and
isolation, not protection from lost updates: two transactions can both read
the row and both write it, because nothing conflicts until the writes
themselves and by then the decision was already made in application memory.

What fixes it is the predicate inside the UPDATE, and the mechanism is
specific: the second statement blocks on the row lock the first holds, and
when the first commits PostgreSQL **re-evaluates the second's WHERE against
the updated row** (EvalPlanQual). The row is now RESOLVED, the predicate
fails, and the statement affects zero rows.

That re-check is the entire reason this is safe at `READ COMMITTED`.

### Why no advisory lock, unlike F04

| | F04 - frequency | F05 - resolution |
|---|---|---|
| Invariant | a COUNT across many rows | one row's state transition |
| Can a row lock protect it? | **No** - there is no row to lock | **Yes** |
| Mechanism | advisory lock | the conditional UPDATE |

Adding an advisory lock here would serialise unrelated reviews for no gain.

### Timestamp semantics

**`clock_timestamp()`, not `now()` - and it records the RESOLUTION time, not
the commit time.**

Three distinct instants exist in one resolution, and only one is stored:

| # | Instant | Source | Stored? |
|---|---|---|---|
| 1 | Transaction start | what `now()` returns | **no** |
| 2 | **Statement execution** | `clock_timestamp()` | **yes - `resolvedAt`** |
| 3 | Commit | nothing produces it | **no** |

(1) can be noticeably earlier than (2) under contention, because the
transaction may have sat waiting on the row lock first. (3) is strictly after
(2): the expense update and the commit itself happen in between.

So `resolvedAt` answers *when did this manager's decision take effect on the
row*, which is the audit question. It does **not** answer *when did it become
visible to everyone else* - nothing records that.

The practical consequence worth knowing: two resolutions can commit in a
different order from their `resolvedAt` values. That does not matter here,
because only one request can win a given review, but it would matter to
anything that tried to order unrelated resolutions by this column alone.

The value is computed **once** in the `FROM` clause and written to both
columns, so `resolvedAt` and `updatedAt` cannot differ. Two separate
`clock_timestamp()` calls would return two different instants.

`updatedAt` is set explicitly because Prisma's `@updatedAt` is applied by the
client and a raw statement bypasses it. Without that line the column would
silently keep its creation value.

### Zero rows is four different things

| Situation | Answer |
|---|---|
| Review missing, or another tenant's | **404** |
| Already resolved by **this** manager with the **same** outcome | **200**, the stored resolution, **zero writes** |
| Already resolved by anyone else, or with a different outcome | **409** with the winner's outcome, timestamp and user id |
| Exists, is this company's, and is still OPEN | **500** - a contradiction, not a retry |

That last row matters. Classifying every zero-row update as a successful
retry would report success for something that never happened.

### Exactly one TRANSITION, not exactly one 200

ADR-004's retry exemption is narrow: same manager **and** same outcome. It
exists for a lost response - the transaction committed, the reply never
arrived, the client retries - and returning 409 for an action that genuinely
succeeded would send that manager investigating something that is fine.

So two concurrent identical requests from one manager produce **two 200s and
one transition** (F05-T34). The assessment requires exactly one successful
state transition; the replay path performs **no writes at all**, which the
test asserts by comparing `updatedAt` before and after.

A different manager repeating the same decision still gets **409** - they did
not lose a response, they are acting on stale information and should be told.

---

## What resolution must never touch

| Preserved | Why |
|---|---|
| `Expense.decision` = `REVIEW` | What the policy concluded. A human outcome is a different fact |
| Rule hits and their detail | The evidence for that conclusion |
| `policySnapshot` | What it was judged against (A7) |
| `payloadHash`, amounts, timestamps | The submission itself |

**No policy is consulted during resolution.** A policy change between
submission and resolution changes nothing about either (F05-T29).

### The F03 response contract needed no correction

```ts
decision: expense.decision,   // REVIEW  - immutable
status:   expense.status,     // APPROVED - current
```

It already carries both facts. Resubmitting the expense after a manager
resolves it returns `decision: REVIEW, status: APPROVED`, `duplicate: true`,
with no second expense, no reopened review and nothing added to the frequency
window (F05-T30). The resolved expense still **counts** toward frequency
(F05-T30b) - otherwise approving an expense would quietly give the employee
their window back.

---

## Audit

The review row is the audit record: `resolvedByUserId`, `resolvedAt`,
`outcome`, with the CHECK constraint making them all-or-nothing. **No generic
audit framework** was built; the schema already records what is required.

The reviewer comes from the authenticated session. The DTO is `.strict()`, so
a body carrying `reviewerId`, `companyId`, `resolvedAt`, `state` or `outcome`
is **refused**, not ignored - an ignored `reviewerId` leaves the caller
believing they recorded who acted, and the audit trail then says something
nobody intended.

The response publishes the reviewer's **name and id**, never their email.

---

## Files

```
src/reviews/
  review.types.ts               response shapes, built explicitly
  dto/list-reviews.dto.ts       query validation + the keyset cursor
  dto/resolve-review.dto.ts     one field, .strict()
  review-query.service.ts       listing and details, tenant-scoped
  review-resolution.service.ts  the conditional UPDATE and the transaction
  reviews.controller.ts         @Roles('MANAGER')
  reviews.module.ts

src/app.module.ts               + ReviewsModule

test/reviews/                   60 tests across 5 suites
```

**No migration. No change to F03 or F04. No frontend change.**

---

## Known limits

- **No review reopening.** Out of scope, and the CHECK constraint would need
  rethinking to allow it.
- **No pagination over a changing `state` filter.** A cursor issued against
  `state=OPEN` and replayed against `state=ALL` positions correctly but pages
  a different set; the client is expected to keep the filter stable.
- **The 409 publishes the winner's user id**, which a determined manager could
  use to learn which colleague acted. Inside one company that is the point of
  an audit trail, not a leak.
- **No load testing**, here or anywhere in this repository.

---

## Frontend integration contracts, for F06 and F07

Nothing here is implemented in F05. These are the shapes the UI will consume.

### `GET /v1/reviews?state=OPEN&limit=50&cursor=…`

```jsonc
{
  "items": [
    {
      "id": "uuid",
      "state": "OPEN",
      "createdAt": "2026-11-20T18:00:00.000Z",
      "expense": {
        "id": "uuid", "externalId": "exp-1001", "employeeId": "emp-7",
        "amountMinor": 60000, "currency": "SAR", "merchant": "Shop",
        "category": "TRANSPORT", "spentAt": "…",
        "decision": "REVIEW",   // immutable - what the policy concluded
        "status": "PENDING_REVIEW"  // current - changes on resolution
      },
      "reasonCodes": ["AMOUNT_LIMIT"],   // codes only in the list
      "resolution": null
    }
  ],
  "nextCursor": null   // or an opaque string
}
```

### `GET /v1/reviews/:id`

Same, with `reasonCodes` replaced by full `reasons`
(`{ code, decision, detail }`), plus `policySnapshot` and `receivedAt`.

### `POST /v1/reviews/:id/resolve`

Request `{ "decision": "APPROVE" | "REJECT" }`. Response **200** with the
same shape as the detail route, now carrying:

```jsonc
"resolution": {
  "outcome": "APPROVED",
  "resolvedAt": "…",
  "resolvedBy": { "id": "uuid", "displayName": "Nour Hassan" }
}
```

### Status handling

| Status | What the UI should do |
|---|---|
| **200** on resolve | Replace the row with the response; it is the committed state |
| **400** | A bug in the client - show a generic error and log it |
| **401** | The session expired. Redirect to `/login?reason=expired`; do not retry |
| **403** | Wrong caller or missing CSRF header. Not retryable |
| **404** | The review is gone or not this company's. Remove it from the list |
| **409** | **Another manager got there first** - see below |
| **500** | Retry once, then surface a generic failure |

### The case worth designing for: a 409 while the page was open

```jsonc
{
  "statusCode": 409,
  "error": "review_already_resolved",
  "message": "This review has already been resolved.",
  "details": {
    "reviewId": "uuid", "outcome": "APPROVED",
    "resolvedAt": "…", "resolvedByUserId": "uuid"
  }
}
```

Recommended handling:

1. Show a clear message - *"This review was already resolved."* Not a generic
   error: nothing went wrong, somebody else acted.
2. **Refetch that review** (`GET /v1/reviews/:id`) rather than trusting the
   `details`. The refetch carries the reviewer's display name; the 409 carries
   only an id, deliberately.
3. Disable both actions and render the actual winning resolution.
4. Invalidate the open-review list so the row disappears.

A 200 that arrives for a resolution the manager already made is **not** an
error and should be treated as success - that is the retry exemption, and the
body is the real resolution.

### Cache invalidation after a resolution

| Key | Action |
|---|---|
| the open-review list | invalidate - the row leaves it |
| that review's detail | replace with the response |
| any expense list (F06) | invalidate - `status` changed |
| policy settings | untouched |

### Loading and pagination

- `nextCursor` is **opaque**. Pass it back verbatim; do not parse it.
- Keep the `state` filter stable while paging. A cursor issued against
  `state=OPEN` positions correctly under `state=ALL` but pages a different set.
- `limit` above 100 is **rejected**, not clamped.
- A malformed cursor is a 400. Drop the cursor and start over.

---

## Change impact analysis

| Change | Affected | Consequence | Severity | Detected by |
|---|---|---|---|---|
| **Remove the `companyId` predicate** | every tenant | Any manager resolves any company's review. The composite FK still prevents a mismatched row, but nothing prevents resolving a foreign one | **Critical** | F05-T13, T37 |
| **Trust `reviewerId` from the body** | audit | The trail is forgeable: a manager records a colleague as having approved something. The data looks perfect | **Critical** | F05-T14 |
| **Remove `@Roles('MANAGER')`** | authorization | API keys and the platform admin gain resolution rights. A company backend could approve its own flagged spending - which is the entire point of human review | **Critical** | F05-T11, T12 |
| **Remove CSRF protection** | session callers | A hostile page can make a logged-in manager approve an expense by visiting it. The cookie is attached automatically; `HttpOnly` does nothing about that | **High** | F05-T20 |
| **Check OPEN in memory, drop it from the UPDATE** | concurrency | Lost update: both managers succeed, the second overwrites outcome, reviewer **and** timestamp, and no error is raised | **Critical** | **F05-NC1** (measured) |
| **Ignore the affected-row count** | correctness | Every request reports success, including ones that changed nothing - a 404 and a 409 both become 200 | **Critical** | F05-T13, T27, T28 |
| **Update the expense outside the transaction** | atomicity | A window appears where the review is RESOLVED and the expense still PENDING_REVIEW. If the second call fails, that is permanent and silent | **High** | F05-T39, T40 |
| **Allow resolved reviews to be overwritten** | audit | The last writer wins forever; "who approved this?" has no stable answer | **High** | F05-T28, T44 |
| **Rewrite `decision` on resolution** | audit | "What did the policy conclude?" becomes unanswerable, and an approved expense looks like one the policy never flagged | **High** | F05-T24 |
| **Re-evaluate policy during resolution** | historical integrity | A policy edit between submission and resolution silently changes the reasons shown to the manager deciding | **High** | F05-T29 |
| **Recreate the review on resubmission** | F03 contract | Every retry reopens a resolved review, and a resolved expense returns to the queue | **High** | F05-T30 |
| **Return success before COMMIT** | correctness | A client is told the review resolved, then the transaction rolls back. The UI shows a state the database never had | **Critical** | F05-T39 (the read is after commit) |
| **Use `now()` instead of `clock_timestamp()`** | audit | Under contention, `resolvedAt` records when the request opened a transaction rather than when the decision took effect - off by however long the row lock was held | **Medium** | F05-T23 |
| **Two `clock_timestamp()` calls instead of one** | audit | `resolvedAt` and `updatedAt` disagree by microseconds, which looks like a second write that never happened | **Low** | F05-T23 |
