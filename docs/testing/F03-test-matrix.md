# F03 test matrix

**Executed:** 2026-11-20
**Command:** `npm test --workspace @limaz/api`
**Environment:** Windows 11, Docker 29.5.3, Node 22.20.0, PostgreSQL 17-alpine

```
Test Suites: 16 passed, 16 total
Tests:       242 passed, 242 total
```

**130 new tests in F03.** F00, F01 and F02 regression suites unchanged and
still passing (**F03-T26**).

| Suite | Tests |
|---|---|
| `canonical-payload.spec.ts` | 17 |
| `submission-validation.e2e-spec.ts` | 27 |
| `idempotency.e2e-spec.ts` | 14 |
| `filter-regression.e2e-spec.ts` | 11 |
| `concurrency.e2e-spec.ts` | 9 |
| `negative-control.e2e-spec.ts` | 3 |

## Every integration test uses real PostgreSQL

No mocked repository appears anywhere in this feature. A mock cannot raise
`23505`, cannot abort a transaction, and cannot serialise on an advisory lock -
so a mocked uniqueness test asserts only that the mock was written to agree
with the test.

The **only** substituted object is the `PolicyEvaluator`, and it is substituted
because no implementation of it exists yet: that is the F04 seam, not a stand-in
for the database.

---

## Required matrix

| ID | Scenario | Expected | Verification | Result |
|---|---|---|---|---|
| F03-T01 | Valid new expense | Persisted exactly once | Response + row count + stored companyId | **PASS** · decision verified in **F04-T45** |
| F03-T01b | Policy snapshot captured (A7) | Decision-affecting fields only | Stored JSON compared to the policy | **PASS** |
| F03-T02 | Missing required field (×7) | `400` naming the field | Status + message | **PASS** |
| F03-T03 | Wrong field type (×5) | `400` | Status | **PASS** |
| F03-T04 | Zero or negative amount | `400` | Status + message | **PASS** |
| F03-T05 | Decimal amount | `400`, **never rounded** | Status + no row at the rounded value | **PASS** |
| F03-T06 | Amount above `int4` | `400`, not a database error | Status; the boundary value is accepted | **PASS** |
| F03-T07 | Invalid timestamp (×5) | `400` | Status | **PASS** |
| F03-T08 | `spentAt` older than 90 days | `422 spent_at_too_old` | Status + error code | **PASS** |
| F03-T08b | `spentAt` more than 5 min ahead | `422 spent_at_in_future` | Status + error code | **PASS** |
| F03-T08c | `spentAt` 1 min ahead | Accepted - clock skew | `201` | **PASS** |
| F03-T09 | Currency mismatch (A3) | `422 currency_mismatch` | Status + message names both | **PASS** |
| F03-T09b | Malformed currency | `400`, **not** `422` | Status | **PASS** |
| F03-T10 | No credential at all | `403` at the CSRF layer | Status + error code | **PASS** (see note) |
| F03-T10a | Browser-shaped, no API key | `401 unauthenticated` | Status + error code | **PASS** |
| F03-T10b | Unknown API key | `401` | Status | **PASS** |
| F03-T11 | Manager session submits | `403 caller_type_not_allowed`, no row | Status + row count | **PASS** |
| F03-T12 | Body carries `companyId` | `400`; other tenant's count unchanged | Status + before/after count | **PASS** |
| F03-T12b | Body carries `decision`/`status`/`payloadHash`/`id`/`receivedAt` | `400` each | Status | **PASS** |
| F03-T12c | Stored tenant | Always the key holder's | Row inspection | **PASS** |
| F03-T13 | Sequential identical retry | One row, original decision, `200` | Ids, decision, reasons, row count | **PASS** · decision verified in **F04-T45** |
| F03-T13b | Retry re-evaluation | **Evaluator called once for three requests** | Call count | **PASS** |
| F03-T13c | Retry side effects | No second rule hit, no second review | Row counts | **PASS** |
| F03-T13d | Equivalent body, different shape | Still a retry | `200` + one row | **PASS** |
| F03-T14 | Same id, different payload | `409`; original row untouched | Status, details, stored amount | **PASS** |
| F03-T14b | Each hashed field changed (×5) | `409` each | Status + row count | **PASS** |
| F03-T14c | Conflict response | **No hash published** | Regex over the whole body | **PASS** |
| F03-T14d | Conflict re-evaluation | Evaluator not called again | Call count | **PASS** |
| F03-T15 | JSON property order | Same hash | Unit | **PASS** |
| F03-T16 | Equivalent timezone offset | Same hash | Unit | **PASS** |
| F03-T16b | Different instant with an offset | Different hash | Unit | **PASS** |
| F03-T17 | 2 concurrent identical | Exactly one row; `[200, 201]` | Multiset of statuses + row count | **PASS** |
| F03-T18 | 5 concurrent identical | One row, one evaluation, no duplicate side effects | Statuses, counts, one id | **PASS** |
| F03-T19 | 3 concurrent conflicting | One `201`, two `409`; stored row **is** the winner's | Statuses + stored amount vs the 201 | **PASS** · decision verified in **F04-T45** |
| F03-T20 | Same id, two companies | Two independent expenses | Ids + companyIds | **PASS** |
| F03-T20b | Cross-tenant conflict | One company cannot block another's identifier | Both `201` | **PASS** |
| F03-T20c | Concurrent, two companies | Both `201`, nothing contends | Statuses + rows | **PASS** |
| F03-T21 | Concurrent same id, **different employeeId** | Unique index decides; `[201, 409]`, no `500` | Barrier proof + statuses + row count | **PASS** |
| F03-T22 | Failure before commit | Nothing persisted; identifier still free | `500`, row count 0, then `201` | **PASS** |
| F03-T22b | Lock release on rollback | Next submission for the same employee proceeds | `201` within the timeout | **PASS** |
| F03-T23 | Retry after a lost response | Existing expense returned, same `receivedAt` | Ids + row count | **PASS** |
| F03-T24 | Unrelated unique violation | `500`, **never** `200`/`409` | Status + row count 0 | **PASS** |
| F03-T24b | That error body | No constraint, table or SQLSTATE named | Regex over the body | **PASS** |
| F03-T25 | Retry after the window passed | `200` with the original decision | Status + id + decision | **PASS** |
| F03-T25b | New expense that old | Still `422` | Status + no row | **PASS** |
| F03-T25c | Conflicting resubmission, stale | `409`, not `422` | Status | **PASS** |
| F03-T26 | F00-F02.1 regression | Still passing | 242/242, 16 suites | **PASS** |

### Note on F03-T10

The prompt's matrix expects `401` for a missing API key. The observed answer is
`403 csrf_header_required`, and it is correct rather than a defect:
`CsrfGuard` runs **before** authentication by design - it has to, because
`POST /v1/auth/login` is `@Public()` and a later CSRF check would skip login
entirely, leaving login CSRF open (F02-T16b). A POST carrying neither an API
key nor the browser client header is indistinguishable from a cross-site form
submission and is refused there.

**F03-T10a** reaches the `401` by shaping the request as a browser one, so the
authentication requirement is still proven rather than merely shadowed.

---

## Negative controls

A test that passes with and without the mechanism it claims to verify is not a
test.

| ID | What is removed | Predicted breakage | Result |
|---|---|---|---|
| F03-T27 | The unique index | The concurrent race creates **two rows** with the same `(companyId, externalId)` | **PASS** - both requests returned `201`, two rows |
| F03-T28 | Nothing; asserts attribution | Two requests on **different lock keys** still cannot duplicate - so the index, not the lock, is what guarantees idempotency | **PASS** |
| F03-T29 | Nothing; guards the guard | A barrier whose participants cannot arrive must fail in seconds with a named error, not hang | **PASS** |

### F03-T27 proves more than "the index works"

The guarded run holds both transactions at a barrier, so neither can have seen
the other's committed row at the idempotency read. The `409` therefore came
from the INSERT raising `23505` and the service resolving the outcome **after**
the aborted transaction rolled back - the path that returns `500` if anyone
queries inside it.

It also showed something sharper. With the index dropped and the duplicate
created, PostgreSQL **refuses to rebuild it**:

```
23505  could not create unique index "expenses_companyId_externalId_key"
```

The damage is not merely detectable afterwards; it physically blocks the
guarantee from being restored. In a real system that is the difference between
an incident and a migration that cannot run. The test asserts that rejection
explicitly, then cleans the duplicates and restores the index.

### Safety

- Runs **only** against `limaz_test`, and the database name is read from
  `current_database()` on the live connection and asserted in `beforeAll` -
  the suite refuses to start otherwise.
- The index is restored in `afterAll`, and the restore is **verified** against
  `pg_indexes`; a failure to restore throws rather than leaving a weakened
  schema for the next suite.
- **No environment flag disables anything.** A switch that turns off a
  correctness guarantee is a worse outcome than the problem it solves, because
  eventually somebody sets it.

---

## Concurrency test quality

`Promise.all` alone proves nothing: requests launched together can still run
one after another, in the pool, in the event loop, or because a lock serialised
them.

| Requirement | How it is met |
|---|---|
| Requests genuinely overlap | A **barrier** inside the evaluator, which runs within the transaction after the lock. Participants wait there holding open transactions and are released together |
| Overlap is **proven**, not assumed | `evaluator.calls` is asserted to have the expected length. If the lock had serialised them, the barrier would have timed out instead |
| Bounded, never hanging | Every barrier takes a timeout (5s, 1s in F03-T29). On expiry it rejects with how many of how many arrived and why |
| Pool allows simultaneity | `DB_POOL_MAX = 10`, above every concurrency used (risk R-10) |
| No assumption about who wins | Assertions are on multisets of statuses and on "the stored row matches the 201", never on identities |
| Side effects asserted | Row counts, company ownership, winning payload, original payload preserved, rule-hit and review counts |

---

## The exception filter regression

F03 added one optional field to the body every error in the service passes
through, so the change is shown to be additive rather than argued to be.

| ID | Assertion | Result |
|---|---|---|
| F03-T30 | An error setting no `details` has **no such key** - not `undefined`, absent | **PASS** |
| F03-T31 | Two different 401 causes remain **byte-identical** (the F02 indistinguishability guarantee) | **PASS** |
| F03-T31b | A CSRF 403 body is unchanged | **PASS** |
| F03-T31c | A 400 with an array message still joins readably | **PASS** |
| F03-T32 | Primitives and one nested plain object survive | **PASS** |
| F03-T33 | `Error`, `Date`, arrays, functions and a Prisma-shaped object are **dropped** | **PASS** |
| F03-T33b | Nesting deeper than one level is dropped | **PASS** |
| F03-T34 | Strings inside `details` are redacted | **PASS** |
| F03-T34b | A **5xx never carries `details`**, even when one is attached | **PASS** |

F03-T34b records a change made because the test asked an uncomfortable
question: the first version let `details` through on a 500, which would have
been a new route for internal shape to reach an unauthenticated caller.

---

## Was deferred to F04 - now closed

**RESOLVED BY F04.** Kept here as the record of what was outstanding and how it was closed - these rows were never reported as a complete PASS while the evaluator did not exist.

| ID | Orchestration (F03) | Decision (F04) | Status |
|---|---|---|---|
| **F03-T01** | **PASS** - persisted once, tenant correct, snapshot captured, evaluator called exactly once | **PASS** - full response body asserted in F04-T45 | **CLOSED** |
| **F03-T13** | **PASS** - the retry returns the stored decision without re-evaluating | **PASS** - original decision and reasons verified in F04-T45 | **CLOSED** |
| **F03-T19** | **PASS** - one winner, conflicting requests refused | **PASS** - the winner carries a genuine decision, F04-T45 | **CLOSED** |

No test in F03 asserted that a decision was correct, because F03 did not
compute one. F04 did, and F04-T45 re-ran these three scenarios against the
real evaluator.

### Public endpoint verification - CLOSED BY F04

| What | Status | Evidence |
|---|---|---|
| `POST /v1/expenses` reachable in the running application | **CLOSED** | `AppModule` wires `ExpensesModule.withEvaluator({ useClass: PolicyEngineEvaluator })`; verified against `docker compose up` |
| End-to-end submission through the deployed stack | **CLOSED** | Ten manual scenarios executed and recorded in `F04-test-matrix.md` |
| Manual cycle sections 1, 2, 3, 4, 6, 7 | **CLOSED** | Executed; results in the F04 matrix |
| Manual cycle sections 5, 8 and setup | **PASS** | Were already runnable |

---
## Static gates

| Gate | Command | Result |
|---|---|---|
| Lint | `npx eslint apps/api --max-warnings=0` | **PASS** - no findings |
| Types | `tsc --noEmit -p apps/api/tsconfig.json` | **PASS** |
| Format | `npx prettier --check` on the new files | **PASS** |

## What is not covered

- **No decision is verified.** F04.
- **No load or throughput testing.** The lock's behaviour under sustained
  contention is reasoned about in ADR-007, not measured.
- **No fuzzing of the canonicalisation.** The field-by-field tests cover every
  input the DTO admits, but not arbitrary Unicode.
- **No test that the production application refuses to start with
  `ExpensesModule` wired and no evaluator.** The module's shape makes it a
  compile-time impossibility rather than a runtime one.
