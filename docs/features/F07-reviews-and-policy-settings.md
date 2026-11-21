# F07 - Manager reviews and company policy settings

The manager's workflow becomes usable. Everything that decides anything was
already built in F03 to F05; F07 is the interface to it, plus the one piece of
backend that was genuinely missing - editing the policy.

---

## 1. What was built

### Backend - two endpoints

| Route | Caller | Purpose |
|---|---|---|
| `GET /v1/policy` | Manager session | The company's current policy |
| `PATCH /v1/policy` | Manager session | Change the permitted fields |

Nothing was added for reviews. `GET /v1/reviews`, `GET /v1/reviews/:id` and
`POST /v1/reviews/:id/resolve` shipped in F05, with the conditional UPDATE that
guarantees exactly one state transition. **No competing resolution endpoint was
created**, and none of F05's semantics were changed.

### Frontend - three pages

| Route | Rendering | Why |
|---|---|---|
| `/dashboard/reviews` | Server shell + Client list | Filter and cursor change interactively |
| `/dashboard/reviews/[reviewId]` | **Client** | Carries the mutation, and must show what the server says *after* it |
| `/dashboard/policy` | Server shell + Client form | Edit state and a mutation |

---

## 2. Which policy fields a manager may change, and why

All four: `autoApproveLimitMinor`, `frequencyMaxCount`,
`frequencyWindowMinutes`, `blockedCategories`.

**Not because the columns exist.** A column existing is never the reason. The
project's own requirements matrix records two entries that settle it:

> Per-company policy settings in the database
> The two companies seeded with different values

and the seed implements them - Nile runs 3 expenses per 60 minutes, Delta runs
5 per 30. A frequency rule that were a fixed platform constant could not be
seeded differently per company, and F04's tests assert the two configurations
behave differently. The established contract is that all four are company
policy, and this endpoint does not widen it.

### PATCH, not PUT

Every field is optional and an absent field is left alone. Under PUT semantics
a client sending only the limit would silently clear the blocked-category list,
and the company would stop blocking anything without one error being raised
(F07-B02b).

An **empty body is refused**. Answering 200 to a request that changes nothing
hides a client bug.

### Validation

| Field | Rule | Why that bound |
|---|---|---|
| `autoApproveLimitMinor` | integer, 0 … 2,147,483,647 | Minor units (ADR-005). **Zero is valid** - "every expense needs a human" is a coherent policy. The ceiling is the `int4` column's, not an opinion |
| `frequencyMaxCount` | integer, 1 … 1,000 | Zero would fire on an employee's first expense ever, which is not a frequency rule |
| `frequencyWindowMinutes` | integer, 1 … 1,440 | Longer than a day stops being a burst rule |
| `blockedCategories` | ≤ 100 entries, each 1 … 64 chars | The list is read whole on every evaluation |

`.strict()`, so `companyId` in the body is a **400**, not a silently ignored
field (F07-B08).

### One normaliser, not two

`blockedCategories` goes through **`normaliseCategory()` from F03** - the same
function the expense pipeline runs on an incoming category.

This is the whole reason that function was extracted rather than inlined. Two
implementations means a manager types `" gambling "`, the expense arrives as
`GAMBLING`, the strings differ, and the rule quietly stops firing. Nothing
errors; the company simply stops being protected.

F07-B07 asserts the stored form; **F07-B07b submits a real expense and asserts
the rule fires**, because "the strings match" and "the rule works" are
different claims.

Duplicates collapse **after** normalising, so `gambling`, `GAMBLING` and
`" Gambling "` become one entry (F07-B06).

---

## 3. What a policy change does not do

Nothing to a single existing expense. Not its decision, not its rule hits, not
its `policySnapshot`, not its status, and not any review.

That is assumption A7, and it is what keeps *why was this flagged?* answerable.
Four tests hold the line:

| | |
|---|---|
| F07-B14 | A **new** expense uses the updated policy |
| F07-B15 | An identical **retry** of an older expense keeps its original decision |
| F07-B16 | An already-evaluated expense keeps its snapshot and reasons |
| F07-B17 | A resolved review is not reopened |

The UI says it in those words: *"Changes apply to new expense evaluations.
Expenses already submitted keep the policy and the decision they were judged
with, and reviews already decided are not reopened."*

It deliberately does **not** claim anything about `spentAt`. An expense
submitted today for money spent last week is judged by the policy in force when
it **arrives**, not when it was spent. Claiming otherwise would describe a
feature nobody built.

### Concurrency: last write wins, stated rather than implied

Two managers editing the policy at the same moment is an ordinary UPDATE race.
The later commit wins; the earlier is overwritten with no conflict reported.
There is no version column.

That is a deliberate stopping point. A policy edit is an infrequent, deliberate
act by a colleague - unlike a review resolution, where two managers racing is
the **expected** case and ADR-004 exists precisely for it. Recorded as **R-31**
rather than left to be discovered.

**What is guaranteed:** a submitting expense always reads one internally
consistent policy row and snapshots the same object it evaluated against, so an
edit landing mid-submission happened either before that read or after it -
never half of it.

The save sends a PATCH of **only the fields that changed**, so editing the
limit cannot silently revert a category somebody else added a second earlier.

---

## 4. The money input

Two representations, kept apart:

```
what a person types   "750.50"      major units, a string
what the API receives  75050        minor units, an integer
```

### Why this is string arithmetic

The obvious conversion is `Math.round(Number(text) * 100)`. Measured on this
runtime:

```js
Number('8.2') * 100    // 819.9999999999999
Number('1.1') * 100    // 110.00000000000001
Math.round(1.005 * 100) // 100  - should be 101
```

The last one is the dangerous shape: wrong by one minor unit, silently, and it
produces a perfectly valid integer the API accepts without complaint.

So `parseMajorUnits` splits the text on its decimal point and concatenates the
digits. No multiplication, no floating point, no rounding - the result is the
digits the person typed, read as an integer.

**Excess precision is refused, not rounded.** A manager typing `100.005` for a
two-decimal currency means something; storing `100.00` or `100.01` decides for
them and they would never learn which.

The exponent comes from `Intl`, not from a hard-coded 100 - JPY has none, and
`toMajorUnitString(1000, 'JPY')` is `"1000"`, not `"10.00"`.

`inputMode="decimal"` rather than `type="number"`: a number input lets the
browser reformat silently and increments on scroll, and exact money is no place
for either.

Nine unit tests, including a round trip at the `int4` ceiling.

---

## 5. Resolving a review: pessimistic, and that is the decision of the feature

An optimistic update paints the new state immediately and rolls back if the
server disagrees. It is the right default for a toggle or a reorder.

It is the **wrong** default here, for a reason specific to this system: two
managers resolving the same review is not a rare failure, it is the case F05's
conditional UPDATE exists for, and the loser gets a **409**. An optimistic UI
would show that manager "Approved", let them move on, and then take it back -
and for those seconds the screen would state as fact a decision that never
happened, about money, on a record the company audits.

So: a pending state, then the server's answer. The cost is one round trip on an
action a human performs a few times an hour.

### What the loser sees

Verified with two genuinely independent sessions - a browser signed in as one
manager, and a second manager created for the test resolving through the API:

- **No "Approved".** The page says *"Rejected by Verify Manager B. They
  resolved it before your decision reached the server, so yours was not
  applied."*
- The badges change to the **actual winning outcome**, and the sidebar panel
  names the reviewer and the time.
- The action buttons **disappear**.
- The review leaves the OPEN queue and the dashboard counts move.
- No retry loop, and the page stays usable.

### The ambiguous case

A network failure after the request left is **not** "nothing happened" - the
server may have committed. Treating it as a failure and offering "try again" is
how a manager produces a second, conflicting decision.

So `ApiError.isAmbiguous` is handled separately: the page refreshes itself and
says *"this decision may or may not have been recorded - check the outcome
above before deciding again"*.

### Duplicate clicks

`busy` disables **both** buttons while either request is in flight, so a double
click cannot produce a second mutation and an impatient manager cannot approve
and then reject.

### The confirmation dialog

Resolution is irreversible by design - there is no "unresolve" endpoint and the
database constrains a review to one transition. The dialog names **the merchant
and the amount**, so the confirmation is about this expense rather than a
generic "are you sure", which trains people to click through.

Radix Dialog, already a dependency, because an accessible confirmation has to
trap focus, restore it, close on Escape and mark the rest inert.

---

## 6. Cache invalidation

Resolving a review changes five things a reader may be looking at:

| | What | Owned by |
|---|---|---|
| 1 | The review itself | TanStack Query |
| 2 | Every review listing | TanStack Query |
| 3 | The expense's detail page | **Server Component** |
| 4 | Every expense listing | TanStack Query |
| 5 | The dashboard summary | **Server Component** |

So `reconcile()` does both halves:

```ts
await Promise.all([
  queryClient.invalidateQueries({ queryKey: reviewKeys.all }),
  queryClient.invalidateQueries({ queryKey: expenseKeys.all }),
  queryClient.invalidateQueries({ queryKey: dashboardKeys.all }),
]);

router.refresh();   // the Server Components
```

It runs after a **success and after a conflict**, because both mean the
database moved - in the conflict case somebody else moved it, and this reader's
cached copy is exactly as stale either way.

Session isolation is unchanged: the provider is still mounted with
`key={user.id}`, so a different user gets a **new** cache rather than a cleared
one.

---

## 7. Security

Every route is `@Roles('MANAGER')` on the controller class.

| Caller | Policy read/write | Review resolve |
|---|---|---|
| Company manager, own company | ✅ | ✅ |
| Company manager, other company | 404 (tenant predicate in the query) | 404 |
| Company API key | 403 `caller_type_not_allowed` | 403 |
| Platform admin | 403 `insufficient_role` | 403 |
| Unauthenticated | 401 | 401 |

The platform admin is refused deliberately: a company's spending rules are that
company's business, and no approved contract grants an administrator the power
to change them.

CSRF is inherited, not re-implemented - `CsrfGuard` runs first on every
state-changing request that is not API-key authenticated, so `PATCH /v1/policy`
requires the `x-limaz-client` header and a matching `Origin` exactly as login
does (F07-B13).

The tenant comes from `tenantScope(principal)` and goes into the `where` of the
mutation itself: `updateMany` with the tenant in its WHERE rather than `update`
by id, so there is no moment at which a row is read, judged to belong to the
caller, and then written.

---

## 8. What was NOT built

| Not built | Why |
|---|---|
| A competing resolve endpoint | F05's already exists and already guarantees one transition |
| Optimistic resolution | See section 5. It would show a decision that never happened |
| A reason or note on a resolution | Neither the API contract nor the assessment asks for one |
| Policy versioning | No requirement. The last-write-wins limitation is documented as R-31 instead |
| Re-evaluating history on a policy change | A7 forbids it, and four tests hold the line |
| Reopening a resolved review | Out of scope; the CHECK constraint would need rethinking |
| Search or category filters on the review queue | `GET /v1/reviews` supports neither, and a control that does nothing is worse than a missing one |
| WebSockets or polling | Not required. `router.refresh()` and query invalidation cover it |

---

## 9. Known limitations

| # | Limitation |
|---|---|
| R-31 | Concurrent policy edits are last-write-wins with no conflict reported |
| - | A policy change applies from the moment it is saved, by **arrival** time - not by the expense's `spentAt` |
| - | The review queue has no search; the expense listing is where searching lives |
| - | Frontend behaviour is browser-verified and recorded as such, not covered by an automated DOM runner (R-23) |
| - | No load testing anywhere in this repository |
