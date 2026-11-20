# F04 - Policy engine, frequency evaluation and the live expense API

**Status:** Implemented, awaiting project-owner approval
**Date:** 2026-11-20
**Depends on:** F00, F01, F02, F03
**Blocks:** F05, F06, F07

## Objective

Every submitted expense receives a genuine decision and every reason that
contributed to it. The three required rules are evaluated, the strongest
decision wins, and no reason is discarded. `POST /v1/expenses` goes live,
because it can now answer honestly.

## What changed, and what deliberately did not

F03 built the orchestration around a hole. F04 fills the hole.

| File | Change |
|---|---|
| `policy/policy-rules.ts` | **New.** Three pure rules plus precedence |
| `policy/policy-engine.evaluator.ts` | **New.** One COUNT, then the pure rules |
| `frequency-lock.ts` | **New.** The advisory lock, as an injectable |
| `app.module.ts` | One import: `ExpensesModule.withEvaluator({ useClass: PolicyEngineEvaluator })` |
| `expense-submission.service.ts` | **One line**: the lock through the seam instead of inline SQL |
| `expenses.module.ts` | Binds the real lock |
| `canonical-payload.ts` | Exported `normaliseCategory` - an extraction, character for character |

**The submission transaction was not touched.** The order F03 built - lock,
idempotency, business validation, policy, evaluate, insert, rule hits,
review - is exactly the order §8 requires, and the port already carried
`tx`, `policy`, `companyId` and the normalised expense. That the real
evaluator dropped in without rearranging anything is the evidence that the
F03 boundary was drawn in the right place.

No migration. No second submission path.

---

## The architecture: pure rules, one impure measurement

```
policy-rules.ts            decides      - pure, no Prisma import at all
policy-engine.evaluator.ts measures     - one COUNT, inside the transaction
expense-submission.ts      orchestrates - lock, idempotency, writes
```

| Option | Verdict |
|---|---|
| One pure function for all three rules | Rejected: every boundary test exercises all three, so a failure says "something is wrong" rather than naming the rule |
| **Three pure functions + a thin evaluator** | **Chosen** |
| Strategy-pattern classes | Rejected: a class with one method and no state is a function with ceremony, and the rule set is fixed by the assessment - there is no dispatch to make polymorphic |
| A configurable rules engine | Rejected: three fixed rules do not need an expression language. Building one would be inventing a problem |

The payoff is concrete: **26 rule tests run in 0.4 seconds with no database**,
so every boundary is covered exhaustively rather than sampled. The database
is reserved for the questions that genuinely need it - what the window
contains, and what happens under concurrency.

---

## The three rules

### Amount limit - REVIEW

Fires when the amount is **strictly greater** than the limit.

An amount exactly equal does not fire. "Auto-approve limit" names the largest
amount that is still auto-approved; `>=` would make the limit the smallest
amount that is not - a different rule, and an off-by-one a company would
notice on every expense priced at the cap. Tests F04-T02, T03, T04 sit on
49,999 / 50,000 / 50,001.

Integer minor units throughout. No floating-point arithmetic exists in the
rules file.

### Frequency - REVIEW

Fires when `count(existing in window) + 1 > frequencyMaxCount`.

The window is **backward-looking with both ends inclusive** (ADR-002):

```
[spentAt - frequencyWindowMinutes, spentAt]
```

- Measured on `spentAt`, not arrival time. A client queue that stalls and
  flushes ten expenses would otherwise place all ten in one window and fire
  the rule on behaviour that never happened.
- Scoped to `companyId` **and** `employeeId`. Without the company filter, one
  tenant's traffic would push another tenant's employees over their
  threshold (F04-T20).
- **No filter on decision or status** (assumption A2). A rejected expense
  still happened. If rejected expenses did not count, an employee could reset
  their own window by submitting something certain to be rejected (F04-T21).
- The current expense is counted exactly once, by the evaluator adding 1 - it
  is not yet written, because the INSERT comes after evaluation.
- A retry never reaches the evaluator at all: idempotency returns first, so a
  replay contributes nothing (F04-T23).

### Blocked category - REJECT

**Both sides are normalised by the same function.** The expense's category was
normalised at submission; each policy entry is normalised at comparison time
with `normaliseCategory`.

Without that, a list saved as ` gambling ` from the F08 admin screen would
fail to block an expense in `GAMBLING` - a policy rule that looks configured
and silently does nothing, which is worse than one that is obviously missing.

| Input | Behaviour |
|---|---|
| Empty list | No hit |
| Different casing | Matches - both uppercased |
| Leading, trailing or repeated whitespace | Matches - both trimmed and collapsed |
| Equivalent Unicode encodings | Matches - both NFC |
| A partial match (`GAMBLING_SUPPLIES`) | **No hit.** Substring matching would block categories the company never listed |

The recorded evidence keeps the company's **own** values, not the normalised
ones, because that is what they configured.

---

## Precedence, and why nothing short-circuits

```ts
const RANK = { APPROVE: 1, REVIEW: 2, REJECT: 3 };
```

An explicit table, not the order the rules happen to run in. Relying on
evaluation order means the answer changes if somebody reorders two lines that
look independent; with a rank, reordering is provably irrelevant - which is
what **F04-T15** asserts, over all six permutations.

**Every rule runs even after the outcome is settled.** When the blocked
category fires, the decision is already REJECT and nothing can change it. The
other two still run.

The reason is that **the decision carries one piece of information and the
evaluation carries three**. An expense that is over the limit *and* in a
blocked category *and* the fourth in its window has three things wrong with
it, and a manager reading it later needs all three. Returning early would
discard evidence the API contract promises, to save two integer comparisons.

Returning immediately on the blocked-category rule would also make the
response depend on which rule happened to be checked first, which is the
accidental-order problem the rank table exists to remove.

### The decision table

| Triggered | Decision | Status | Review |
|---|---|---|---|
| nothing | APPROVE | APPROVED | none |
| one or more REVIEW, no REJECT | REVIEW | PENDING_REVIEW | exactly one OPEN |
| any REJECT | REJECT | REJECTED | **none** |

Two REVIEW rules still open **one** review: the review belongs to the expense,
not to the rule (F04-T35b). A REJECT opens none even when two REVIEW rules
fired (F04-T36) - a rejected expense is final the moment it is decided, so an
open review against it would be work nobody can complete (A8).

### Reason ordering

The evaluator emits in a fixed order - alphabetical by rule code - so persisted
rows are deterministic, and the API response sorts the same way.

**A surprise worth knowing:** `ORDER BY "ruleCode"` in SQL does **not** give
that order. `RuleCode` is a PostgreSQL enum and ordering by it is *declaration*
order - `AMOUNT_LIMIT, FREQUENCY, BLOCKED_CATEGORY`. The API sorts in
JavaScript and is alphabetical. Anything in F06 that sorts in SQL will see a
different sequence from the one the contract promises. Asserted in F04-T36 so
it stays visible.

---

## The frequency query, with its measured plan

```ts
const windowStart = new Date(spentAt.getTime() - policy.frequencyWindowMinutes * 60_000);

await tx.expense.count({
  where: {
    companyId,                                   // from the API key
    employeeId: expense.employeeId,              // exactly, never normalised
    spentAt: { gte: windowStart, lte: spentAt },
  },
});
```

The index `(companyId, employeeId, spentAt)` has the range column last, which
is the shape a range scan needs. **That does not guarantee the planner uses
it** - on a small table a sequential scan is genuinely cheaper and PostgreSQL
is right to take one. So the plan is measured rather than claimed, on 4,000
rows after `ANALYZE`:

```
Aggregate  (cost=8.31..8.32 rows=1 width=8) (actual time=0.035..0.036 rows=1 loops=1)
  Buffers: shared hit=4
  ->  Index Only Scan using "expenses_companyId_employeeId_spentAt_idx" on expenses
        Index Cond: (("companyId" = ...) AND ("employeeId" = ...)
                     AND ("spentAt" >= ...) AND ("spentAt" <= ...))
        Heap Fetches: 2
Planning Time: 0.556 ms
Execution Time: 0.061 ms
```

**Index Only Scan**, with all four conditions inside `Index Cond` - the
equality columns and the range both served by the index, four buffer hits.

**This is a query plan, not a performance result.** It says the planner picks
the index on this shape of data; it says nothing about throughput, about
behaviour under concurrent load, or about how the service performs at scale.
No load test has been run at any volume - see the caveat at the top of
ADR-007's scalability section.
The test asserts only that the index appears, not the node type, so a future
PostgreSQL choosing an equally correct plan does not fail the suite.

---

## Concurrency

The transaction order is F03's, unchanged:

```
BEGIN                                   -- READ COMMITTED
  lock.acquire(tx, companyId, employeeId)   -- pg_advisory_xact_lock
  idempotency lookup                        -- 200 / 409 / continue
  currency (A3) and spentAt window (A4)     -- 422
  load policy
  evaluate  ->  COUNT(*) in the window, then the pure rules
  INSERT expense (decision + status)
  INSERT rule_hits
  INSERT review   (only when REVIEW, A8)
COMMIT                                  -- the lock releases here
```

### Why the lock has to be first

Under `READ COMMITTED` **each statement takes a fresh snapshot**. Because the
lock is taken first, the count that follows snapshots *after* the lock is
held and therefore sees every competitor that has already committed. The same
lock is still held at the INSERT, so no competitor can commit in between.

Under `REPEATABLE READ` this design silently breaks: the snapshot is taken at
the transaction's first statement - the lock acquisition itself - so when the
lock is finally granted the snapshot is stale and the committed competitor is
invisible. The code would look correct and the answer would be wrong.

### The lock is injected, not inlined

So the negative control can run **the production code path** with the lock
absent. There is no environment variable and no configuration flag -
substitution is only possible through Nest's testing API. A flag would
eventually be set by someone debugging something else, and turning off a
correctness guarantee is worse than the problem it solves.

### The barrier problem

F03's barrier lives inside the evaluator, **after** the lock. That works for
requests with different lock keys and would **deadlock** for requests that
share one: only the holder can proceed, so the others never arrive.

F04's five-concurrent test needs five requests for the *same* employee, so the
barrier moved to a test-only interceptor that runs **before** the controller -
before the transaction and before the lock. All five are released together and
then race for the lock as five real clients would.

A pre-lock barrier proves they overlapped. It does **not** prove they read the
same count, so the negative control adds a **second** synchronisation point
between the count and the first write, used only when the lock is a no-op.
Pairing that second barrier with the real lock deadlocks by construction, and
**F04-NC2 demonstrates that failure on purpose** so it is not a trap for
whoever writes the next concurrency test.

---

## Out-of-order expenses - an accepted limitation, not a solved problem

Forward-only evaluation (ADR-002). Decisions are never revisited.

| Expense | `spentAt` | Its window | Count | Decision |
|---|---|---|---|---|
| E1 | 10:10 | `[09:10, 10:10]` | 1 | APPROVE |
| E2 | 10:20 | `[09:20, 10:20]` | 2 | APPROVE |
| E3 | 10:30 | `[09:30, 10:30]` | 3 | APPROVE - 3 is not greater than 3 |
| **E4** | **10:05, arriving late** | `[09:05, 10:05]` | **1** | **APPROVE** |
| E5 | 10:35 | `[09:35, 10:35]` | **5** | REVIEW |

E4's own window ends at 10:05, and E1, E2 and E3 all happened *after* that, so
none of them is inside it. E4 is approved even though it is logically the
fourth expense in that hour.

**The advisory lock does not help with this and is not claimed to.** The lock
orders concurrent writers; this is a property of evaluating only backwards in
time. Risk **R-11** stays `ACCEPTED`.

Late data is not discarded - E5's window contains all five. It is simply never
applied retroactively. Tests F04-T24 and F04-T25.

---

## Policy snapshots and historical decisions

The snapshot is built from the **same policy object** the evaluator received -
no second load, so there is no window in which the policy could change between
evaluating and recording what was evaluated against.

| Scenario | Behaviour | Test |
|---|---|---|
| Policy changes after an expense is decided | The stored snapshot is unchanged | F04-T40 |
| A retry arrives after a policy change | The **original** decision and reasons, re-evaluating nothing | F04-T41 |
| A new expense after a policy change | The **new** policy applies | F04-T42 |

A retry is a replay of a fact, not a new evaluation. Re-evaluating would change
a decision already reported to the caller, and any review opened against it
would stop matching the expense it describes.

**Concurrent policy updates.** The policy is read inside the transaction at
`READ COMMITTED`, so it sees whatever was committed when that statement ran.
An update committing afterwards does not affect this expense. The advisory
lock does **not** cover the policy row - it is keyed on (company, employee) -
so two expenses submitted either side of an update legitimately get different
snapshots. That is correct point-in-time semantics, and it is why no policy
versioning system is needed: the snapshot *is* the version, recorded per
expense.

---

## The live endpoint

`POST /v1/expenses` is registered in `AppModule` and answers in the running
application. Everything F03 established is preserved: API-key-only
authentication, the tenant from the verified credential, the validation
split, idempotency, conflict handling and error sanitisation.

| Status | Meaning |
|---|---|
| **201** | A new expense was processed. The body carries the decision and every reason |
| **200** | An identical retry. Same body, `duplicate: true` |
| **400** | Malformed request |
| **401** | Missing or invalid credential, past the CSRF layer |
| **403** | Wrong caller type, or a request shaped like a cross-site submission |
| **409** | Same tenant-scoped `externalId`, different canonical payload |
| **422** | Well formed, but the content is not acceptable - currency (A3) or age (A4) |

**A REJECT decision is a 201.** The request was well formed, authenticated,
authorised and processed; the business outcome is that the expense is
rejected. A 4xx would tell the caller their *request* failed, and a retrying
client would retry something that worked (F04-T44).

No test evaluator is reachable from production wiring: `ExpensesModule`
exposes only `withEvaluator()`, and `AppModule` names
`PolicyEngineEvaluator`.

---

## Known limits

- **Out-of-order expenses can be under-counted.** R-11, accepted.
- **No sliding sub-window search.** The window is anchored at `spentAt`;
  ADR-002 records the alternative as an upgrade path.
- **Advisory lock hash collisions** make unrelated pairs wait on each other.
  Never a wrong decision - every query still filters by the real ids. R-09.
- **The lock does not cover the policy row**, so a policy update can commit
  between two expenses in the same window. Correct, and worth knowing.
- **`ORDER BY` on `RuleCode` is enum-declaration order**, not alphabetical.
- **No load testing.** Behaviour under sustained contention is reasoned about
  in ADR-007, not measured.

---

## Change impact analysis

| Change | Affected | Consequence | Severity | Detected by |
|---|---|---|---|---|
| **`>` → `>=` on the amount rule** | every expense priced exactly at the cap | The limit becomes the smallest amount that is *not* auto-approved. Every expense at exactly 500.00 SAR is reviewed, and a manager's queue fills with items policy says are fine | **Medium** | F04-T03 |
| **`>` → `>=` on the frequency rule** | every employee | The rule fires on the **third** expense instead of the fourth, which is not the stated requirement. A third of all windows gain a false review | **High** | F04-T09, F04-T10 |
| **Remove `companyId` from the frequency query** | every tenant | One company's traffic pushes another company's employees over their threshold. Cross-tenant interference with no error anywhere, and the busier tenant silently degrades the quieter one | **Critical** | F04-T20 |
| **Remove `employeeId`** | every employee | The window becomes company-wide. A company with twenty employees trips the rule constantly; the rule stops describing a person | **Critical** | F04-T19, F04-T30 |
| **Remove the advisory lock** | the frequency rule only | Concurrent submissions each count zero and **all approve**. No error, no log line - the rule simply stops working. Idempotency is unaffected, which is why one mechanism cannot cover both | **Critical** | **F04-NC1** (measured: 5 APPROVE, 0 reviews) |
| **Move the count outside the transaction** | the frequency rule | The count is protected by neither the lock nor the transaction's snapshot. Same silent under-count as above, and harder to spot because the lock still appears to be held | **Critical** | F04-T26 degrades; the port passes `tx` explicitly to make this hard to write |
| **`READ COMMITTED` → `REPEATABLE READ`** | the frequency rule | The snapshot is taken at the transaction's **first** statement - the lock acquisition. When the lock is finally granted the snapshot is stale, so the competitor that just committed is invisible. **The code looks correct, the lock is genuinely held, and the answer is wrong** | **Critical** | F04-T26; ADR-007 records this as the reason the level is pinned |
| **Count the current expense twice** | every expense | The rule fires on the third. Equivalent to the `>=` change above, arrived at by a different route | **High** | F04-T09 |
| **Re-evaluate duplicate requests** | retries | A retry counts toward the window and can change a decision already reported. Any review opened against the expense stops matching it, and a client that retries aggressively reviews itself into a queue | **High** | F04-T23, F04-T41 |
| **Return after the first triggered rule** | multi-rule expenses | The response carries one reason instead of three. The decision is still right; the explanation is not, and F06/F07 display reasons. It also makes the output depend on which rule was checked first | **Medium** | F04-T14, F04-T36 |
| **Change precedence (REVIEW > REJECT)** | blocked-category expenses | A blocked expense that is also over the limit becomes reviewable, so a manager can approve spending the company forbade outright | **Critical** | F04-T12, F04-T13, F04-T14 |
| **One review per triggered REVIEW rule** | multi-rule expenses | Two reviews for one expense. `Review.expenseId` is `@unique`, so the second INSERT raises 23505 and the whole submission fails with a 500 - a correctness bug that presents as an outage | **High** | F04-T35b, plus the unique index |
| **Persist rule hits outside the transaction** | every expense with reasons | An expense can commit with no reasons attached, or reasons can survive a rolled-back expense. "Why was this reviewed?" becomes unanswerable for an unknowable subset | **High** | F04-T37, F04-T38 |
| **Replace the snapshot with the current policy** | every historical expense | Every past decision is re-explained against today's settings. An expense reviewed under a 500 limit appears, after a raise, to have been reviewed for no reason - and the audit trail becomes actively misleading rather than merely incomplete | **High** | F04-T40 |
