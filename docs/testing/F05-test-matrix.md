# F05 test matrix

**Executed:** 2026-11-20
**Command:** `npm test --workspace @limaz/api`
**Environment:** Windows 11, Docker 29.5.3, Node 22.20.0, PostgreSQL 17-alpine

```
Test Suites: 26 passed, 26 total
Tests:       372 passed, 372 total
```

**67 new tests in F05.** The F00-F04 baseline of 305 is unchanged and still
passing (**F05-T46**).

| Suite | Tests |
|---|---|
| `review-access.e2e-spec.ts` | 24 |
| `review-resolution.e2e-spec.ts` | 20 |
| `review-concurrency.e2e-spec.ts` | 10 |
| `review-query-shape.e2e-spec.ts` | 5 |
| `review-negative-control.e2e-spec.ts` | 2 |

Reviews are created the way production creates them - by submitting an
expense that trips a policy rule - not inserted by hand. An inserted fixture
can drift from what the submission path actually writes, and then the tests
pass against a shape that never occurs.

---

## Listing and details

| ID | Scenario | Expected | Result |
|---|---|---|---|
| F05-T01 | Manager lists reviews | Own company, OPEN only | **PASS** |
| F05-T02 | No open reviews | Empty `items`, `nextCursor: null` - not 404 | **PASS** |
| F05-T03 | Resolved reviews exist | Excluded from the default listing | **PASS** |
| F05-T04 | Own review detail | Expense, reasons, snapshot; `decision REVIEW`, `status PENDING_REVIEW` | **PASS** |
| F05-T04b | A resolved review | Outcome, timestamp and reviewer **name**; no email | **PASS** |
| F05-T05 | Unknown id | 404 | **PASS** |
| F05-T06 | Another company's id | **Byte-identical** 404 to "unknown" | **PASS** |
| F05-T07 | Several triggered rules | Every reason with its evidence | **PASS** |
| F05-T08 | Ordering and paging | Newest first; every row seen exactly once walking 1-at-a-time | **PASS** |

Also: no `payloadHash`, `keyHash`, `passwordHash` or any 64-char hex in either
response; a `limit` above the maximum is **rejected** rather than silently
clamped; four shapes of malformed cursor each give 400; an unknown query
parameter is refused.

---

## Authorization and validation

| ID | Scenario | Expected | Result |
|---|---|---|---|
| F05-T09 | Unauthenticated | 401 `unauthenticated` | **PASS** |
| F05-T10 | Invalid session | 401 | **PASS** |
| F05-T11 | Company API key | 403 `caller_type_not_allowed`, review untouched | **PASS** |
| F05-T12 | Platform admin | 403 `insufficient_role` on both list and resolve | **PASS** |
| F05-T13 | Other company's review | 404, every field byte-identical afterwards | **PASS** |
| F05-T14 / T15 | Body carries `reviewerId`, `companyId`, `resolvedAt`, `resolvedByUserId`, `state` or `outcome` | **400 each** - refused, not ignored | **PASS** |
| F05-T16 | Invalid decision (×4) | 400 | **PASS** |
| F05-T17 | Missing decision | 400 | **PASS** |
| F05-T18 | Unknown properties | 400, same path as T14/T15 (`.strict()`) | **PASS** |
| F05-T19 | Malformed review id | **400**, not 404 and not 500 | **PASS** |
| F05-T20 | Missing / wrong-origin CSRF | 403 `csrf_header_required` / `cross_origin_rejected` | **PASS** |
| F05-T45 | Production wiring | Routes answer with the guards' vocabulary | **PASS** |

---

## Resolution and historical integrity

| ID | Scenario | Expected | Result |
|---|---|---|---|
| F05-T21 | Approve | Review RESOLVED/APPROVED, expense APPROVED | **PASS** |
| F05-T22 | Reject | Review RESOLVED/REJECTED, expense REJECTED | **PASS** |
| F05-T23 | Audit | Reviewer from the session; `resolvedAt` between request and response; `resolvedAt == updatedAt`; both after `createdAt` | **PASS** |
| F05-T24 / T25 | After resolution | `decision` still REVIEW; rule hits, snapshot, hash, amounts and timestamps unchanged | **PASS** |
| F05-T26 | Same manager, same decision | 200 with the stored resolution and **zero writes**, proven by an unchanged row version (`xmin`) | **PASS** |
| F05-T26b | A real transition | `xmin` **does** change, so the check above is not vacuous | **PASS** |
| F05-T27 | Same manager, conflicting | 409; expense keeps the first outcome | **PASS** |
| F05-T28 | Another manager, either decision | 409; reviewer, timestamp and outcome unchanged | **PASS** |
| F05-T29 | Policy changed before resolution | Nothing re-evaluated; snapshot and rule hits intact | **PASS** |
| F05-T30 | Expense resubmitted after resolution | 200 `duplicate`, `decision REVIEW`, `status APPROVED`, one expense, one review | **PASS** |
| F05-T30b | That expense in a later window | **Still counts** toward frequency | **PASS** |

### Transaction failure and integrity

| ID | Scenario | Expected | Result |
|---|---|---|---|
| F05-T39 / T40 | The expense update matches zero rows | **The review update rolls back too** - still OPEN, null outcome, null reviewer, null timestamp. 500 with no internal detail in the body | **PASS** |
| F05-T42 | Resolve again after that failure | Succeeds; the earlier failure left nothing behind | **PASS** |
| F05-T43 | A lost response, replayed three times | Three extra 200s, **zero additional writes** (`xmin` unchanged) | **PASS** |
| F05-T44 | Three refused attempts on a resolved review | Reviewer, timestamp and outcome unchanged; `xmin` untouched | **PASS** |

Also asserted: a resolved review leaves the default OPEN listing.

### Zero writes is proven, not inferred

`updatedAt` being equal is **not** proof - a write that happened to store the
same timestamp would look identical. So the replay tests compare **`xmin`**,
the transaction id that created the current row version. PostgreSQL never
updates a row in place: every UPDATE writes a new row version with a new
`xmin`, so an unchanged value means no write occurred at all.

F05-T26b is the control for that control. It confirms `xmin` *does* change on
a genuine transition, so the assertion cannot pass vacuously - without it,
"the row version did not change" would also hold for a column that never
changes.

---

## Concurrency

| ID | Scenario | Expected | Result |
|---|---|---|---|
| F05-T31 | Two managers, **opposite** decisions | One 200, one 409; stored state is the winner's; expense follows the winner; `decision` still REVIEW | **PASS** |
| F05-T32 | Two managers, **same** decision | Still one 200 and one 409 | **PASS** |
| F05-T33 | **Five** managers compete | Exactly one 200, four 409, no 5xx; every loser names the same winner | **PASS** |
| F05-T34 | Same manager, **identical**, concurrent | **Two 200s, ONE transition**, zero extra writes | **PASS** |
| F05-T34b | Same manager, **conflicting**, concurrent | One 200, one 409 | **PASS** |
| F05-T35 | Different reviews concurrently | All succeed - different rows, different locks | **PASS** |
| F05-T36 | Across companies | Independent | **PASS** |
| F05-T37 | Authorised vs foreign-tenant competitor | 200 and 404; only the authorised request mutated | **PASS** |
| F05-T38 | The first transaction **rolls back** | A waiting request then succeeds; nothing from the aborted transaction survives | **PASS** |

### Two 200s is correct, and the distinction is the point

F05-T34 asserts **two 200 responses and one state transition**. The
assessment requires exactly one successful *transition*, not exactly one 2xx.
The replay path performs no writes at all, which the test proves by comparing
`updatedAt` before and after rather than by trusting the status code.

### Contention is measured, not inferred

```sql
SELECT pid, pg_blocking_pids(pid) FROM pg_stat_activity
 WHERE cardinality(pg_blocking_pids(pid)) > 0
```

A dedicated test holds the row lock in one transaction, dispatches a
competing HTTP request, and polls that query with a bounded timeout until
PostgreSQL itself reports a blocked backend. A non-empty answer is direct
evidence of lock contention rather than a guess from timing.

### Where the barrier sits

Once the winner holds the row lock, competitors block **inside PostgreSQL**,
not at any barrier of ours. A shared barrier downstream of the UPDATE could
never be reached by more than one participant and would hang until its
timeout - the F04 mistake. So the barrier is an interceptor that runs
**before** the controller, and the winner is held by a **single-participant**
pause, never a shared one.

---

## Negative control

| ID | What changes | Predicted breakage | Result |
|---|---|---|---|
| **F05-NC1** | `AND state = 'OPEN'` removed from the mutation, in-memory check kept | Both managers succeed; the second overwrites the first's outcome, reviewer **and** timestamp | **PASS** - both updates affected 1 row; the record names Bob though Alice resolved it first |
| **F05-NC2** | Nothing - the same race through the real service | Exactly one 200, one 409, one transition | **PASS** |

### What it proves, precisely

That the predicate **inside the UPDATE** - not the check in application
memory, and not the transaction - is what makes exactly one resolution win.

Both halves of NC1 run in real transactions. A transaction gives atomicity
and isolation, not protection from a lost update: two transactions can read
the same row and both write it, because nothing conflicts until the writes
themselves and by then the decision was already made in memory.

Determinism comes from forcing both transactions to **read before either
writes**, which is the ordering a real race hits intermittently. Forcing it
turns "sometimes wrong" into "always wrong", which is what a control needs.

**Nothing raised an error in NC1** - which is what makes this class of bug
survive in production.

### Safety

The unsafe statement is written in the test file as raw SQL against the test
database. Nothing in `src/` is weakened; there is no flag, no environment
variable and no substituted provider that could disable the predicate in a
running application. The database name is read from `current_database()` on
the live connection and asserted before anything runs.

---

## Query shape

```
--- statements per page: 4 for 5 rows, 4 for 50 rows ---
```

Ten times the rows, the same number of statements. The count is bounded by
the **shape** of the query, not the number of rows - which is what "no N+1"
means. The figure is 4, not 1: `include` does not necessarily compile to one
joined query, and the claim is made nowhere.

Also asserted: a page never exceeds its `limit`; the cursor keeps working
after the review it names is resolved and leaves the OPEN set; three reviews
sharing a `createdAt` to the millisecond are each returned exactly once when
paging one row at a time.

---

## NOT APPLICABLE

| ID | Scenario | Why |
|---|---|---|
| **F05-T41** | "Audit write fails, if applicable" | **There is no separate audit write.** The audit *is* the review row - `resolvedByUserId`, `resolvedAt` and `outcome` are columns set by the same UPDATE that performs the transition, and a CHECK constraint makes a half-written set unstorable. There is no second write that could fail independently, and §11 explicitly says not to build a generic audit framework. The nearest real failure - the *expense* update failing after the review update - is F05-T39 and F05-T40 |

Not marked PASS. Nothing was executed for it.

---

## Manual verification against the running stack

Executed against `docker compose up` at `http://localhost:3000`.

| Step | Result |
|---|---|
| Submit a 60,000 expense | 201 · `REVIEW` |
| Log in as the seeded manager | session issued |
| List open reviews | 2 items, `nextCursor: null` |
| Read the new review | `OPEN` · `decision REVIEW` · `status PENDING_REVIEW` · `AMOUNT_LIMIT` · snapshot present · `resolution null` |
| Approve it | **200** · `RESOLVED` · `APPROVED` · by `Nour Hassan` · `expense.decision REVIEW` · `expense.status APPROVED` |
| List again | the review is **gone** from the open list |
| Approve again, same decision | **200** |
| Resolve with the opposite decision | **409** `review_already_resolved` |
| Resolve with an API key | **403** `caller_type_not_allowed` |
| Create a second review and reject it | **200** · `REJECTED` · expense `REJECTED` |
| Read another company's review | **404** |
| Resolve another company's review | **404** |
| Resubmit the expense after resolution | **200** · `duplicate true` · `decision REVIEW` · `status REJECTED` |

Database afterwards:

```
  externalId   | policy |  final   |  state   | outcome  | resolved_by | has_ts | ts_consistent | reasons
---------------+--------+----------+----------+----------+-------------+--------+---------------+---------
 m…-a          | REVIEW | APPROVED | RESOLVED | APPROVED | Nour Hassan | t      | t             |       1
 m…-b          | REVIEW | REJECTED | RESOLVED | REJECTED | Nour Hassan | t      | t             |       1
```

`ts_consistent` is `resolvedAt = updatedAt` - the single `clock_timestamp()`
evaluation, confirmed on real rows.

**The manual concurrency step is a smoke test, not evidence.** Shell
background jobs give no control over whether requests overlap inside the
database. The deterministic evidence is F05-T31 to T38 and F05-NC1.

---

## Static gates

| Gate | Result |
|---|---|
| `npx eslint apps/api --max-warnings=0` | **PASS** |
| `tsc --noEmit` | **PASS** |
| `npm run verify` | **PASS** |
| `docker compose up -d --build` | **PASS** - db, api, web healthy |

## What is not covered

- **No load testing**, here or anywhere in this repository.
- **No test of review reopening**, which is out of scope and would need the
  CHECK constraint rethought.
- **No fuzzing of cursor values** beyond the four named malformed shapes.
- **The 409 publishes the winning reviewer's user id.** Inside one company
  that is an audit trail, not a leak, but it is a deliberate choice rather
  than an oversight.
