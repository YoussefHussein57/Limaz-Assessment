# Interview defence

Five realistic questions per completed feature - ten for the webhook bonus -
with the answer I should be able to give, and the place in this repository that
backs it up.

The webhook set carries a line of Egyptian Arabic before each question saying
what the interviewer is actually probing for, which is a different thing from
what the question asks.

The questions are written to attack **our actual choices**, not textbook theory.

| Feature | Questions | Reviewed |
|---|---|---|
| [F00 - Foundation](F00-foundation.md) | 5 | Not yet |
| [F01 - Database and seed](F01-database-and-seed.md) | 5 | Not yet |
| [F02 - Authentication](F02-authentication.md) | 5 | Not yet |
| [F02.1 - UI foundation](F02.1-ui-foundation.md) | 5 | Not yet |
| [F03 - Expense submission](F03-expense-submission.md) | 5 | Not yet |
| [F04 - Policy engine](F04-policy-engine.md) | 5 | Not yet |
| [F05 - Review lifecycle](F05-review-lifecycle.md) | 5 | Not yet |
| [F06 - Manager dashboard](F06-manager-dashboard.md) | 5 | Not yet |
| [F07 - Reviews and policy settings](F07-reviews-and-policy-settings.md) | 5 | Not yet |
| [F08 - Platform administration](F08-platform-administration.md) | 5 | Not yet |
| [F11 - Manager provisioning](F11-manager-provisioning.md) | 5 | Not yet |
| [F12/F13 - Card webhook bonus](F12-card-webhook.md) | 10 | Not yet |

## Learning gaps

Recorded as they come up, so I can revise them rather than being blocked by
them.

| Date | Topic | Gap | Status |
|---|---|---|---|
| 2026-11-19 | PostgreSQL index internals | A `UNIQUE` constraint is a **B-tree**, so lookup is `O(log n)`, not `O(1)`. PostgreSQL has no hash-backed unique index by default | Noted, corrected in ADR-006 |
| 2026-11-19 | Snapshot isolation | `READ COMMITTED` takes a snapshot **per statement**; `REPEATABLE READ` takes one at the transaction's **first statement**. That difference is what makes lock-then-count correct under one and silently wrong under the other | Noted, explained in ADR-007 |
| 2026-11-19 | Docker context semantics | A `.dockerignore` pattern without `**/` matches only at the context root | Noted, fixed and guarded by F00-T12 |
| 2026-11-20 | Composite foreign keys | PostgreSQL needs a `UNIQUE` on exactly the referenced columns before they can be a foreign-key target - even when one of them is already the primary key | Noted, used in ADR-011 |
| 2026-11-20 | Prisma error translation | Prisma collapses every non-unique, non-FK database error into `P2039`. The real SQLSTATE and constraint name survive under `meta.driverAdapterError.cause` | Noted, used by the test helper |
| 2026-11-20 | React 19 types | `FormEvent` is deprecated with the note that it "doesn't actually exist". Deriving the type from `ComponentProps<'form'>['onSubmit']` cannot go stale when React changes it again | Noted, used in `login-form.tsx` |
| 2026-11-20 | `'use client'` semantics | The directive marks a **boundary**, not "this file uses hooks". A boundary cannot receive a function prop, so marking one inside an already-client tree creates a constraint with no benefit | Noted, AI_LOG 15 |
| 2026-11-20 | WCAG 1.4.11 | Non-text contrast requires 3:1 for the **visual boundary of a user interface component** - an input's edge - and does not apply to a decorative rule. One border colour cannot serve both | Noted, two border tokens |
| 2026-11-20 | `offsetParent` | It is `null` for any `position: fixed` element, so it cannot be used to test visibility of a fixed sidebar. `getComputedStyle(el).display` can | Noted, AI_LOG 17 |
| 2026-11-20 | RFC 3986 sub-delimiters | `,` and `;` are legal unencoded inside a URL password, so they cannot be treated as the end of the userinfo part | Noted, AI_LOG 14 |
| 2026-11-20 | Aborted transactions | A `23505` inside a transaction puts it in an ABORTED state: every later statement, including a plain SELECT, fails with `25P02`. The winning row cannot be read there - it needs a SAVEPOINT or a re-read after the rollback | Noted, AI_LOG 21 and `resolveLostRace()` |
| 2026-11-20 | Prisma `@@unique` DDL | It emits `CREATE UNIQUE INDEX`, not `ADD CONSTRAINT`, so the name lives in `pg_indexes` and is absent from `pg_constraint`. Same guarantee, different DDL and different catalogue | Noted, AI_LOG 21 |
| 2026-11-20 | `Date.parse` rollover | `2026-02-30` does not fail - it returns 2 March. A date must be checked against the calendar, not against whether it parsed | Noted, AI_LOG 19 |
| 2026-11-20 | Unique index rebuilds | PostgreSQL refuses to build a unique index over rows that violate it, so duplicates created while it was absent physically block its restoration | Noted, F03-T27 |
| 2026-11-20 | Lock scope vs constraint scope | An advisory lock keyed on one tuple can completely hide a unique constraint keyed on another, so a concurrency test can pass with the constraint dropped | Noted, AI_LOG 20 |
| 2026-11-20 | Postgres enum ordering | `ORDER BY` on an enum column uses DECLARATION order, not alphabetical. `RuleCode` is declared AMOUNT_LIMIT, FREQUENCY, BLOCKED_CATEGORY, so SQL and a JS `localeCompare` sort disagree | Noted, AI_LOG 26 |
| 2026-11-20 | Index existence vs index use | A composite index with the range column last is the SHAPE a range scan needs; whether the planner uses it is a separate question answered only by EXPLAIN ANALYZE on representative data | Noted, AI_LOG 28 |
| 2026-11-20 | Barrier placement | A synchronisation point inside a lock can only be reached by the lock holder, so barriers for same-key contention must sit upstream of the lock | Noted, AI_LOG 24 |
| 2026-11-20 | What a barrier proves | Releasing N requests together proves overlap, NOT that they observed the same state. Proving a read-then-write race needs synchronisation between the read and the write | Noted, AI_LOG 25 |
| 2026-11-20 | EvalPlanQual | When a blocked UPDATE is released, PostgreSQL RE-EVALUATES its WHERE against the updated row rather than proceeding. That re-check is what makes `UPDATE ... WHERE state = 'OPEN'` safe at READ COMMITTED, and what an in-memory check skips entirely | Noted, ADR-004 and F05-NC1 |
| 2026-11-20 | `now()` vs `clock_timestamp()` | `now()` is the TRANSACTION START time, not the statement's. For an audit field recording when something took effect under contention, the two can differ by however long the row lock was held | Noted, F05 |
| 2026-11-20 | Lost updates vs transactions | A transaction gives atomicity and isolation, NOT protection from a lost update: two transactions can read the same row and both write it. Only a predicate in the mutation prevents it | Noted, F05-NC1 |
| 2026-11-20 | supertest laziness | A `Test` object does not send its request until `.then()` is called. Assigning one to a variable and awaiting it later means it never overlapped with anything | Noted, AI_LOG 29 |
| 2026-11-20 | Prisma and column defaults | Prisma supplies `@default(now())` values from the client per row, so the database's `DEFAULT CURRENT_TIMESTAMP` never fires and rows in one transaction do not share a timestamp | Noted, AI_LOG 31 |

---

# The twenty most likely questions

Fifty questions across ten feature documents is a revision resource, not an
interview. These twenty are the ones an interviewer is most likely to reach for
given what is actually in this repository - every one of them attacks a real
decision, and most of them have a defect behind them.

Answers are **not** repeated here. Each line names where the answer lives, so
revising means reading the argument rather than a summary of it.

### Multi-tenancy and authorization

1. Every service puts `companyId` from the session into its `WHERE`. The admin
   routes take it from the URL. Why is that not the vulnerability it looks
   like? — [F08 Q1](F08-platform-administration.md)
2. A company asks for another company's expense by a real id. Why 404 and not
   403, and what stops a future query forgetting the predicate? —
   [F02 Q3](F02-authentication.md), [ADR-003](../adr/ADR-003-cross-tenant-response.md), risk R-20
3. How do you know tenant isolation actually holds, rather than that your tests
   agree with your code? — F06-NC1, and
   [the live matrix](../security/endpoint-authorization.md)
4. A manager's browser requested `/admin` and got a 403 page. What was still
   wrong with that, and how did you find it? — [AI_LOG 44](../../AI_LOG.md)

### Concurrency

5. Three different mechanisms for three concurrency problems. Why can't one of
   them do all three jobs? — [F04 Q4](F04-policy-engine.md),
   [F05 Q2](F05-review-lifecycle.md), [F08 Q4](F08-platform-administration.md)
6. Your frequency test passed with the unique index dropped. What did that
   prove, and what did you change? — [AI_LOG 20](../../AI_LOG.md)
7. Two requests arrive at the same millisecond with the same `externalId`.
   Walk me through both transactions. — [F03 Q2](F03-expense-submission.md)
8. How do you make two supertest requests genuinely concurrent, and how would
   you know if you hadn't? — [AI_LOG 29](../../AI_LOG.md), risk R-10
9. A transaction does not prevent a lost update. What does? —
   [ADR-004](../adr/ADR-004-review-resolution.md)

### Idempotency and the API contract

10. The same `externalId` with a different body. Why 409 rather than replaying
    or updating? — [ADR-001](../adr/ADR-001-idempotency-conflicting-payload.md)
11. A retry returns 200 and a first submission returns 201, with the same body.
    Why does the distinction matter? — [F03 Q3](F03-expense-submission.md)

### The policy engine

12. Does the current expense count toward the frequency rule, and what breaks
    if you change that? — [ADR-002](../adr/ADR-002-frequency-window.md),
    assumption A1
13. Show me the case where your frequency rule can be evaded, and explain why
    you left it. — risk R-11, and the worked example in the README
14. Why is the policy snapshotted onto the expense instead of joined at read
    time? — [F04 Q5](F04-policy-engine.md), assumption A7

### Data and correctness

15. How do you represent money, and show me a bug the alternative produces. —
    [ADR-005](../adr/ADR-005-money-representation.md), [AI_LOG 40](../../AI_LOG.md)
16. Why is there a composite foreign key on `reviews`? —
    [ADR-011](../adr/ADR-011-composite-foreign-key-tenant-integrity.md)

### Credentials

17. Why SHA-256 for API keys and bcrypt for passwords? —
    [ADR-006](../adr/ADR-006-api-key-storage-rotation.md), [F08 Q2](F08-platform-administration.md)
18. What exactly do you promise about a key shown once, and what do you not? —
    [F08 Q5](F08-platform-administration.md)

### The frontend

19. Why is the review resolution pessimistic when optimistic updates are the
    usual advice? — [F07 Q1](F07-reviews-and-policy-settings.md)
20. Where does the browser keep the session, and why not a JWT? —
    [ADR-008](../adr/ADR-008-browser-session.md)

### The optional bonus, if you want to go there

21. Why does HMAC need the **raw** body, and what breaks if you verify the
    parsed object? — [F12 Q2](F12-card-webhook.md)
22. You hash every other credential. Why is the webhook signing secret
    encrypted instead? — [F12 Q3](F12-card-webhook.md)
23. A worker commits the expense and then dies. What happens next? —
    [F12 Q8](F12-card-webhook.md)
24. Is the webhook pipeline exactly-once? — [F12 Q9](F12-card-webhook.md)

### The one to ask for

If you want the single question that shows the most: **"tell me about a
mistake you made in this project and how you found it."** The answer is in
[`AI_LOG.md`](../../AI_LOG.md) - 66 of them, including a live API key written
into a screenshot by a redaction that React undid, an acceptance check that had
been failing for six features, a seed that refused to start as soon as anybody
used the application, and an oversized request body that had been answering 500
on every endpoint since F03 - found by a webhook test, and pre-existing.
