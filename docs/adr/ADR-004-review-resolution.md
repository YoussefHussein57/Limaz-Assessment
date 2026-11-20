# ADR-004: Review resolution, final status, and concurrent resolves

- **Status:** Accepted, 2026-11-19
- **Assessment question:** 4
- **Implemented in:** F05
- **Related risk:** R-04

## Context

An expense whose decision is `REVIEW` opens a review. A manager approves or
rejects it, which sets the expense's final status. Two managers may act on the
same review at the same moment; exactly one must win, and the other must be told
clearly.

## Decision

### Two separate fields, not one

| Field | Values | Mutable? | Meaning |
|---|---|---|---|
| `Expense.decision` | `APPROVE`, `REVIEW`, `REJECT` | **Never** | What the policy engine concluded at submission time |
| `Expense.status` | `APPROVED`, `REJECTED`, `PENDING_REVIEW` | Yes, once | The final outcome |

Merging them would lose the answer to "what did the policy originally say?",
which is a basic audit question. Resolving a review changes `status` only.

### Resolution is a single conditional UPDATE

```sql
UPDATE reviews
   SET state = 'RESOLVED',
       outcome = $3,
       resolved_by_user_id = $4,
       resolved_at = now()
 WHERE id = $1
   AND company_id = $2
   AND state = 'OPEN'
RETURNING expense_id;
```

The tenant guard and the concurrency guard sit in the **same** `WHERE` clause.
Checking the tenant separately would open a time-of-check-to-time-of-use gap
between the check and the update.

This requires `company_id` to exist on `REVIEW` (denormalised from the expense,
assumption A9). Consistency is guaranteed because a review row is only ever
created inside the same transaction that creates its expense, from the same
authenticated context.

### Review update and expense update share one transaction

Both statements run inside one transaction. If anything fails between them, the
whole transaction rolls back.

**This is the answer to "what if it fails after the review update but before the
expense update?": nothing is observable.** Neither write is visible to any other
transaction until `COMMIT`, so there is no state in which the review is resolved
while the expense is still pending. That intermediate state only exists if the
two writes are split across separate transactions or separate HTTP calls, which
is exactly the mistake this design avoids.

### When `rowCount` is zero

| Situation | Response |
|---|---|
| Already resolved, by **this** manager, with the **same** outcome | `200 OK` with the existing resolution - a legitimate retry |
| Already resolved, by anyone else or with a different outcome | `409 Conflict` with `resolvedBy`, `resolvedAt`, `outcome` |
| Review belongs to another tenant, or does not exist | `404 Not Found` (ADR-003) |

The `200` case matters: if the process commits and then dies before responding,
the client retries, and the manager who genuinely resolved the review would
otherwise receive a confusing `409` for an action that succeeded.

## Isolation level

`READ COMMITTED`, the PostgreSQL default. `SERIALIZABLE` is not required here.

When two transactions target the same row, the second blocks on the row lock.
When the first commits, PostgreSQL re-evaluates the second's `WHERE` clause
against the updated row (the EvalPlanQual mechanism). The second therefore sees
`state = 'RESOLVED'`, its condition fails, and it affects zero rows.

That re-check is precisely what makes `UPDATE ... WHERE state = 'OPEN'` safe at
`READ COMMITTED`.

## Audit record

Every resolution stores `resolved_by_user_id`, `resolved_at` and `outcome`. The
reviewer always comes from the authenticated session, never from the request
body.

## Failure modes

| Failure | Effect | Mitigation |
|---|---|---|
| Tenant checked outside the `WHERE` | TOCTOU window allows a cross-tenant resolve | Single-statement guard, verified by an integration test |
| Two separate transactions | Review resolved while expense stays pending | One transaction, verified by a test that injects a failure between the writes |
| Reviewer read from the body | Audit trail can be forged | Reviewer taken from the session; a body-supplied reviewer is stripped by the DTO whitelist |

## Test strategy

- Integration: resolve once, assert review state, expense status, and the audit
  fields.
- Integration: inject a failure after the review update and assert the review is
  still `OPEN` and the expense still `PENDING_REVIEW`.
- Concurrency: two managers resolve simultaneously; assert exactly one `200`,
  exactly one `409`, and one audit record naming the winner.
- Integration: company A attempts to resolve company B's review, assert `404`
  and that the review is untouched.
- Integration: retry by the same manager with the same outcome returns `200`.

---

## Implemented in F05

The decision above stood. Four things it did not pin down:

### `clock_timestamp()`, not `now()`

The SQL in this record says `now()`. That returns the **transaction start**
time, and under contention a resolution transaction may have waited on the
row lock for some time before its UPDATE ran. The audit field is meant to
record when the manager's decision took effect, not when their request opened
a transaction, so `clock_timestamp()` is used instead.

The value is computed **once**, in a `FROM (SELECT clock_timestamp() AS at)`
clause, and written to both `resolvedAt` and `updatedAt` - two separate calls
would return two different instants and the columns could disagree.

`updatedAt` is set explicitly because Prisma's `@updatedAt` is applied by the
client and a raw statement bypasses it. Without that line the column would
silently keep its creation value.

### Zero rows has a FOURTH case

The table in this record lists three. There is a fourth, and it must not be
folded into the others: the review exists, belongs to this company, and is
still `OPEN` - yet the conditional update matched nothing. That is a
contradiction, not a retry, and it answers **500**. Reporting success there
would be the worst available answer.

### Exactly one TRANSITION is not exactly one 200

The `200`-on-retry in this record means two concurrent identical requests from
the same manager produce **two 200 responses and one state transition**. That
satisfies the assessment, which requires exactly one successful state
transition; the replay path performs **no writes at all**.

F05-T34 asserts it by comparing `updatedAt` before and after, rather than by
trusting the status code.

### No advisory lock, deliberately

F04 added one for the frequency count. It is not used here, and the
difference is worth stating: F04's invariant is a COUNT across many rows - a
read-then-write over a *set*, which no row lock can protect because there is
no single row to lock. This invariant is one row's state transition, which a
row lock plus PostgreSQL's predicate re-evaluation protects exactly. An
advisory lock here would serialise unrelated reviews for no gain.

### The negative control

Removing `AND state = 'OPEN'` from the mutation while keeping the in-memory
check makes both competing managers succeed; the second overwrites the
first's outcome, reviewer and timestamp, and **nothing raises an error**.
Measured in F05-NC1, with both halves running in real transactions - which is
the point: a transaction gives atomicity and isolation, not protection from a
lost update.
