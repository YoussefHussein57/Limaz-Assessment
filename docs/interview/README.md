# Interview defence

Five realistic questions per completed feature, with the answer I should be able
to give, and the place in this repository that backs it up.

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
