# F04 test matrix

**Executed:** 2026-11-20
**Command:** `npm test --workspace @limaz/api`
**Environment:** Windows 11, Docker 29.5.3, Node 22.20.0, PostgreSQL 17-alpine

```
Test Suites: 21 passed, 21 total
Tests:       305 passed, 305 total
```

**63 new tests in F04.** F00-F03 regression suites unchanged and still
passing (**F04-T46**): 242 before, 305 after.

| Suite | Tests | Database |
|---|---|---|
| `policy-rules.spec.ts` | 26 | **No** - pure functions |
| `frequency-window.e2e-spec.ts` | 12 | Yes |
| `policy-concurrency.e2e-spec.ts` | 7 | Yes |
| `policy-persistence.e2e-spec.ts` | 16 | Yes |
| `frequency-negative-control.e2e-spec.ts` | 2 | Yes |

The 26 rule tests run in **0.4 seconds** with no database at all, which is why
every boundary is covered exhaustively rather than sampled. The database is
reserved for what genuinely needs it: what the window contains, and what
happens under concurrency.

---

## Rule unit tests - no database

| ID | Scenario | Expected | Result |
|---|---|---|---|
| F04-T01 | No rule triggered | APPROVE, no reasons | **PASS** |
| F04-T02 | Amount 49,999 vs limit 50,000 | No hit | **PASS** |
| F04-T03 | Amount **exactly** 50,000 | **No hit** | **PASS** |
| F04-T04 | Amount 50,001 | REVIEW, detail `{autoApproveLimitMinor, amountMinor}` | **PASS** |
| F04-T05 | Blocked category | REJECT | **PASS** |
| F04-T06 | Empty blocked list | No hit | **PASS** |
| F04-T07 | Policy entry lowercase / padded / mixed case (×4) | Matches; evidence keeps the company's own value | **PASS** |
| F04-T07b | Equivalent Unicode encodings | Matches | **PASS** |
| F04-T08 | Count including current = 1 | No hit | **PASS** |
| F04-T09 | Count = 3 with maxCount 3 | **No hit** - 3 is not greater than 3 | **PASS** |
| F04-T10 | Count = 4 | REVIEW, detail `{windowMinutes, maxCount, countIncludingCurrent}` | **PASS** |
| F04-T11 | Amount + frequency | REVIEW, two reasons | **PASS** |
| F04-T12 | Amount + blocked | REJECT, two reasons, the AMOUNT hit still says REVIEW | **PASS** |
| F04-T13 | Frequency + blocked | REJECT, two reasons | **PASS** |
| F04-T14 | All three | REJECT, **three** reasons | **PASS** |
| F04-T15 | All six permutations of evaluation order | Same decision every time | **PASS** |

Also covered: a zero limit reviews everything; integer comparison at the int4
boundary; a partial category match (`GAMBLING_SUPPLIES`) does **not** fire; a
lone REVIEW rule does not become REJECT; reason order is deterministic.

---

## Frequency window - real PostgreSQL

Company A: window 60 minutes, maxCount 3. Every expense in these tests is
under the amount limit and in a permitted category, so the frequency rule is
the **only** rule that can fire - a REVIEW here means the window counted
something.

| ID | Scenario | Expected | Result |
|---|---|---|---|
| F04-T16 | A row at exactly `spentAt - 60min` | **Included** - the bound is inclusive. Count 4 → REVIEW | **PASS** |
| F04-T17 | The same row moved back **1 ms** | **Excluded**. Count 3 → APPROVE | **PASS** |
| F04-T18 | Three rows *after* the current `spentAt` | Excluded → APPROVE | **PASS** |
| F04-T18b | Three rows at the **same instant** | Included → REVIEW | **PASS** |
| F04-T19 | Another employee, same company | Excluded | **PASS** |
| F04-T20 | Another company, **same employeeId** | Excluded | **PASS** |
| F04-T21 | Three REJECTED rows in the window | **Included** (A2) → REVIEW | **PASS** |
| F04-T22 | Three PENDING_REVIEW rows | Included → REVIEW | **PASS** |
| F04-T23 | One expense submitted three times | One row; a later fourth distinct expense sees count 4, not 6 | **PASS** |
| F04-T24 | Late expense at 10:05 behind 10:10/10:20/10:30 | **APPROVE** - its own window excludes them. Earlier decisions untouched | **PASS** |
| F04-T25 | A further expense at 10:35 | REVIEW with `countIncludingCurrent: 5` | **PASS** |

### The query plan, measured

4,000 rows, `ANALYZE` run, then `EXPLAIN (ANALYZE, BUFFERS)`:

```
Aggregate  (cost=8.31..8.32 rows=1 width=8) (actual time=0.035..0.036 rows=1 loops=1)
  Buffers: shared hit=4
  ->  Index Only Scan using "expenses_companyId_employeeId_spentAt_idx" on expenses
        (cost=0.28..8.30 rows=1 width=0) (actual time=0.024..0.031 rows=2 loops=1)
        Index Cond: (("companyId" = ...) AND ("employeeId" = ...)
                     AND ("spentAt" >= ...) AND ("spentAt" <= ...))
        Heap Fetches: 2
        Buffers: shared hit=4
Planning Time: 0.556 ms
Execution Time: 0.061 ms
```

**Index Only Scan**, with all four conditions inside `Index Cond`.

The index having the range column last is the *shape* a range scan needs; it
is not a guarantee the planner will use it. On a small table a sequential scan
is genuinely cheaper and PostgreSQL is right to take one - which is why this
is measured on representative data rather than asserted. The test checks only
that the index appears, so a future PostgreSQL picking an equally correct plan
does not fail the suite.

---

## Concurrency - real PostgreSQL, bounded barriers

| ID | Scenario | Expected | Result |
|---|---|---|---|
| F04-T26 | **Five simultaneous distinct expenses**, one employee, one instant | **3 APPROVE, 2 REVIEW, 2 OPEN reviews, 2 FREQUENCY hits** | **PASS** |
| F04-T26b | **Eight simultaneous expenses with SKEWED `spentAt`** (milliseconds apart, one window). Added in F13 for MIN-03 - F04-T26 pins one instant, so the suite was structurally blind to this case | The earliest `spentAt` **always** APPROVEs however late it arrives; no recorded count exceeds its row rank in `spentAt` order; all eight persist. The approval COUNT is deliberately not asserted - it varies with lock order | **PASS** |
| F04-T27 | Five simultaneous identical retries | One `201`, four `200`, one row | **PASS** |
| F04-T28 | Three simultaneous conflicting payloads | One `201`, two `409`, stored row is the winner's | **PASS** |
| F04-T29 | Four + four across two companies | Independent counts: A reviews its fourth (max 3), B reviews none (max 5) | **PASS** |
| F04-T30 | Four + four for two employees | Each independently reaches four, each gets exactly one REVIEW | **PASS** |
| F04-T31 | Three distinct expenses each sent twice | Three `201`, three `200`, three rows, all APPROVE | **PASS** |
| F04-T32 | A 422 raised while holding the lock | Nothing persisted; the next submission for the same employee proceeds | **PASS** |

### What makes F04-T26 evidence rather than decoration

The recorded `countIncludingCurrent` values are **4 and 5**. That is only
reachable if the five transactions saw one another in sequence - which is the
serialisation the advisory lock provides.

**Which** request was reviewed is deliberately not asserted. Lock acquisition
order is not determined, so asserting an identity would be flaky by design.

### The barrier, and why it moved

F03's barrier lives inside the evaluator, **after** the advisory lock. That
works for requests with different lock keys. For five requests sharing one
key it would **deadlock**: only the holder can proceed, so the others never
arrive and everyone waits for the timeout.

F04's barrier is a test-only interceptor that runs **before** the controller -
before the transaction opens and before the lock is attempted. All five are
released together and race for the lock as five real clients would.

### Preconditions, all load-bearing

| | |
|---|---|
| Employee history | Empty - cleared in `beforeEach` |
| External ids | Five different ones, so none is a retry |
| Company, employee, `spentAt` | Identical across all five |
| Policy | maxCount 3 (company A's seeded value) |
| Amounts and categories | Under the limit, permitted - so frequency is the only rule that can fire |
| `DB_POOL_MAX` | **10**, above every concurrency used. A smaller pool would queue the requests and the suite would pass without the database being contended at all (R-10) |

---

## Negative control

| ID | What is removed | Predicted breakage | Result |
|---|---|---|---|
| **F04-NC1** | The advisory lock | All five transactions count zero and **all approve** | **PASS** - 5 APPROVE, 0 reviews, 0 FREQUENCY hits |
| **F04-NC2** | Nothing; guards the guard | Pausing inside the lock deadlocks, and must fail fast rather than hang | **PASS** |

### Why a pre-lock barrier alone is not enough

Releasing five requests together proves they were in flight. It does **not**
prove they read the same count: without serialisation, one transaction can
still count, insert and commit before another reaches its count, and the
result would be a mixture that happens to look correct. The control would pass
intermittently and prove nothing.

So F04-NC1 adds a **second** synchronisation point, after the frequency count
and before any row is written. Every competitor must reach it before any of
them continues, which makes "all five counted zero" a determined outcome
rather than a likely one.

That second barrier is used **only** with the lock replaced by a no-op.
Pairing it with the real lock deadlocks by construction, and **F04-NC2
demonstrates exactly that failure on purpose**, with a short timeout, so it is
not a trap for whoever writes the next concurrency test.

### What F04-NC1 shows, precisely

Five expenses for one employee, inside one 60-minute window, under a policy
that allows three - and **not one of them was reviewed**. No error was raised
anywhere. The rule simply stopped working.

The unique index is untouched, so idempotency still holds in the same run:
five distinct `externalId` values, five rows. That is ADR-007's point made
concrete - two different guarantees needing two different mechanisms.

### Safety

- The substitution happens through Nest's testing `overrideProvider`. There is
  **no environment variable and no configuration flag** that can disable the
  lock in a running application.
- Nothing destructive: no DDL, no dropped constraint. It runs against
  `limaz_test` like every other suite.

---

## Persistence and the public endpoint

| ID | Scenario | Expected | Result |
|---|---|---|---|
| F04-T33 | APPROVE | APPROVED, no review, no rule hits | **PASS** |
| F04-T34 | REVIEW | PENDING_REVIEW, exactly one OPEN review carrying the right tenant | **PASS** |
| F04-T35 | REJECT | REJECTED, **no review** | **PASS** |
| F04-T35b | Two REVIEW rules firing | **One** review - it belongs to the expense, not the rule | **PASS** |
| F04-T36 | All three rules | Three rule hits persisted with the seed's exact detail shapes; individual verdicts preserved; **no review** despite two REVIEW rules | **PASS** |
| F04-T37 | A 422 inside the transaction | No expense, no rule hits, no review; the identifier is free afterwards | **PASS** |
| F04-T38 | A REVIEW decision | Expense, rule hit and review all visible together | **PASS** |
| F04-T39 | The same body to two companies | A: REVIEW (over its limit). B: REJECT (ALCOHOL blocked for B only) | **PASS** |
| F04-T40 | Policy raised after a decision | The stored snapshot is unchanged | **PASS** |
| F04-T41 | A retry after a policy change | The **original** decision and reasons, `duplicate: true` | **PASS** |
| F04-T42 | A new expense after the change | The **new** policy applies, new snapshot | **PASS** |
| F04-T43 | Production wiring | 50,000 → APPROVE, 50,001 → REVIEW with the real limit in the detail | **PASS** |
| F04-T44 | A REJECT decision | **HTTP 201**, not 4xx | **PASS** |

### F04-T36 recorded an unexpected ordering

`ORDER BY "ruleCode"` returned `AMOUNT_LIMIT, FREQUENCY, BLOCKED_CATEGORY`,
not alphabetical order. `RuleCode` is a PostgreSQL enum and ordering by it is
**declaration** order. The API response sorts in JavaScript and *is*
alphabetical, so the two differ. The assertion now records this rather than
working around it, because anything in F06 that sorts in SQL will see the
other sequence.

---

## F04-T45 - the F03 deferred scenarios, now resolved

These were marked `DEFERRED` in the F03 matrix because no real evaluator
existed. They are now verified against the real one.

| F03 ID | Was | Now | Result |
|---|---|---|---|
| **F03-T01** | PASS (orchestration) · decision DEFERRED | The full response body is asserted: decision, status, and the reason with its exact detail | **PASS** |
| **F03-T13** | PASS (orchestration) · decision DEFERRED | The retry returns the original decision and reasons verbatim; one rule hit, one review | **PASS** |
| **F03-T19** | PASS (orchestration) · decision DEFERRED | The conflict winner carries a genuine decision matching its own amount | **PASS** |

**Nothing in the F03 matrix is `DEFERRED` any longer.** The public-endpoint
section of that matrix is also resolved - `POST /v1/expenses` is live, and the
manual cycle's **NEEDS F04** commands have been executed.

---

## Manual verification against the running stack

Executed against `docker compose up` at `http://localhost:3000`, not against
the test harness.

| Scenario | HTTP | Decision | Reasons |
|---|---|---|---|
| Normal expense | 201 | APPROVE | - |
| 60,000 over a 50,000 limit | 201 | REVIEW | AMOUNT_LIMIT |
| Category GAMBLING | 201 | REJECT | BLOCKED_CATEGORY |
| Fresh employee, expense 1-3 | 201 | APPROVE | - |
| Fresh employee, expense 4 | 201 | REVIEW | FREQUENCY, `count=4` |
| Over limit + blocked + fifth | 201 | REJECT | AMOUNT_LIMIT, BLOCKED_CATEGORY, FREQUENCY, `count=5` |
| Identical retry | **200** | REVIEW | unchanged, `duplicate: true` |
| Conflicting retry | **409** | - | `conflict` |
| Same `externalId`, company B | 201 | APPROVE | - (B's limit is 200,000) |
| Five concurrent, one employee | 201 ×5 | **3 APPROVE, 2 REVIEW** | 2 open reviews |

Database state after the frequency run:

```
   externalId   | decision |     status     |                 reasons                 | reviews | snap_limit
----------------+----------+----------------+-----------------------------------------+---------+------------
 r...-f1        | APPROVE  | APPROVED       |                                         |       0 | 50000
 r...-f2        | APPROVE  | APPROVED       |                                         |       0 | 50000
 r...-f3        | APPROVE  | APPROVED       |                                         |       0 | 50000
 r...-f4        | REVIEW   | PENDING_REVIEW | FREQUENCY                               |       1 | 50000
 r...-x         | REJECT   | REJECTED       | AMOUNT_LIMIT+FREQUENCY+BLOCKED_CATEGORY |       0 | 50000
```

The last row is the one worth reading twice: **three reasons, two of them
REVIEW, and zero reviews opened**, because REJECT is final.

### A manual run contaminated itself, and that is recorded

The first attempt reused the employee id `emp-freq` across runs, so a second
run inherited four expenses from the first and reported REVIEW on what should
have been the first approval. The expense data was correct; the *test* was
wrong.

The manual guide now derives **both** the employee id and the external ids
from a per-run identifier. Reusing an `externalId` is caught by the 409;
reusing an `employeeId` is silent, which makes it the more dangerous of the
two.

---

## Static gates

| Gate | Command | Result |
|---|---|---|
| Lint | `npx eslint apps/api --max-warnings=0` | **PASS** |
| Types | `tsc --noEmit` | **PASS** |
| Build | `npm run verify` | **PASS** |
| Docker | `docker compose up -d --build` | **PASS** - db, api, web all healthy |

## What is not covered

- **No load or throughput testing.** Behaviour under sustained lock contention
  is reasoned about in ADR-007, not measured.
- **No test of advisory-lock hash collisions.** R-09: a collision makes
  unrelated pairs wait, never produces a wrong decision, because every query
  inside the lock still filters by the real ids.
- **Out-of-order under-counting is demonstrated, not fixed.** R-11, accepted.
- **No fuzzing of category strings.** The normalisation is covered by named
  cases, not by arbitrary Unicode.
