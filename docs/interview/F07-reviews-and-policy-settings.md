# F07 - Interview defence

Five questions a LIMAZ interviewer could reasonably ask after reading the F07
code. Each attacks a decision actually made here.

---

## Q1 - Pessimistic versus optimistic mutations

> Approving a review is a single POST. Most teams would update the UI
> optimistically and roll back on failure. You did not. Defend that, and tell
> me when you *would* reach for an optimistic update.

**Because the failure this one has is not rare, and it is not cosmetic.**

An optimistic update is a bet that the server will agree. It pays off when the
server almost always agrees and a brief wrong pixel costs nothing - a toggle, a
reorder, a "like".

Here the server disagreeing is a **designed-for case**, not an edge: two
managers resolving the same review is exactly what F05's conditional UPDATE and
ADR-004 exist for, and the loser gets a 409. An optimistic UI would show that
manager "Approved", let them move on, and then take it back. For the seconds in
between, the screen states as fact a decision that never happened - about
money, on a record the company audits.

So the button shows a pending state and the result appears only after the
server has committed it. The cost is one round trip on an action a human takes
a few times an hour. That is the right trade.

**Where I would use optimistic here:** nowhere in F07. If this application
later gets a "mark as read" or a saved-filter toggle - cheap, reversible, no
audit meaning - that is the shape that earns it.

**Two details I would raise unprompted.** `busy` disables **both** buttons
while either request is in flight, so a double click cannot produce a second
mutation and an impatient manager cannot approve and then reject. And the
mutation has `retry: false`: this request is not idempotent in the general
case, so a blind retry is a second attempt at a decision.

**Backs it up:** `resolve-actions.tsx`, `review-queries.ts`, F07-F08, F07-F10.

---

## Q2 - Concurrent resolution and what the loser sees

> Two managers open the same review. One approves, the other rejects a second
> later. Walk me through exactly what the second manager sees, and what you had
> to do to make it true.

**The backend already guarantees the outcome. F07 is about not lying to the
person who lost.**

F05's `UPDATE ... WHERE state = 'OPEN'` means exactly one transition, with
PostgreSQL re-evaluating the predicate after the first commits (EvalPlanQual).
The second manager's request affects zero rows and the API answers 409.

What the UI does with that 409 is the question:

1. It does **not** treat it as a failure. The system worked; this caller lost a
   race it was always possible to lose.
2. It refreshes everything a resolution touches - reviews, expenses, dashboard
   - because the database moved even though *this* request did not move it.
3. It shows the **actual winning outcome** and who made it, by name.
4. It removes the action buttons. There is nothing left to decide.
5. It does not retry.

The message is specific: *"Rejected by Verify Manager B. They resolved it
before your decision reached the server, so yours was not applied."* Not "an
error occurred" - the manager needs to know their decision did not land and
whose did.

**And it is verified, not described.** Two genuinely independent sessions: a
browser signed in as one manager, and a second manager - created for the test,
not added to the seed - resolving through the API. Then the browser's Approve
was pressed. Screenshot in `docs/screenshots/f07-conflict-1440.png`.

**The case I would raise unprompted** is the one that is not a 409: a network
failure *after* the request left. That is not "nothing happened" - the server
may have committed. Treating it as a failure and offering "try again" is how a
manager produces a second, conflicting decision. `ApiError.isAmbiguous` is
handled separately: refresh, then say the outcome is unconfirmed and ask them
to look before deciding again.

**Backs it up:** ADR-004, `resolve-actions.tsx`, F07-F10, F07-F13.

---

## Q3 - Cache invalidation and consistency

> After a successful resolution, what has to be refreshed - and how do you know
> you did not miss one?

**Five things, and they are not all owned by the same system. That is the part
that is easy to get wrong.**

| | What changes | Owned by |
|---|---|---|
| 1 | The review itself | TanStack Query |
| 2 | Every review listing | TanStack Query |
| 3 | The expense detail page | **Server Component** |
| 4 | Every expense listing | TanStack Query |
| 5 | The dashboard summary | **Server Component** |

`invalidateQueries` cannot touch 3 and 5. They are rendered on the server and
no client cache knows they exist. So `reconcile()` does both halves -
invalidate the three families, then `router.refresh()`.

The keys are **prefixed** precisely so the first half is three calls and not a
loop over every filter combination a reader might have open: `reviewKeys.all`
matches every state filter and every page. That is why the filters are the last
element of a key rather than baked into the first.

**It also runs after a conflict**, which is the bit worth defending. A 409
means the database moved - somebody else moved it - and this reader's cached
copy is exactly as stale as if they had won. Refreshing only on success is how
a losing manager is shown a stale "Open" above a message saying it was
resolved.

**How I know nothing was missed:** by checking the screens rather than the
code. After the conflict, the queue showed "0 reviews shown" and the dashboard
showed Rejected 3 with "1 rejected by a manager". Both verified in the browser.

**On cross-session leakage**, the other half of cache correctness: the provider
is mounted with `key={user.id}`, so a different user gets a **new** QueryClient
rather than a cleared one. There is no exit path that can forget to clear it,
because React does the unmounting.

**Backs it up:** `review-queries.ts`, `resolve-actions.tsx`,
`app/(app)/layout.tsx`, F07-F11, F07-F12.

---

## Q4 - Safe financial form handling

> The limit field takes "750.50" and the API wants an integer. Show me the
> conversion and tell me why it is not one line.

**Because the one line is wrong, and wrong silently.**

`Math.round(Number(text) * 100)` is the one line. Measured on this runtime:

```js
Number('8.2') * 100      // 819.9999999999999
Number('1.1') * 100      // 110.00000000000001
Math.round(1.005 * 100)  // 100  - should be 101
```

The third is the dangerous one. It is off by a single minor unit, it produces a
perfectly valid integer, the API accepts it, the database stores it, and
nothing anywhere reports a problem. A manager who typed one limit now has
another.

So `parseMajorUnits` does **string arithmetic**: split on the decimal point,
pad the fraction to the currency exponent, concatenate, read as an integer. No
multiplication, no floating point, no rounding. The digits that come out are
the digits that went in.

**Three decisions inside that are worth defending:**

- **Excess precision is refused, not rounded.** `100.005` for a two-decimal
  currency means something. Storing `100.00` or `100.01` decides for the
  manager, and they would never learn which.
- **The exponent comes from `Intl`, not from 100.** JPY has no minor unit;
  dividing by 100 would be wrong by a factor of a hundred and would still look
  plausible.
- **`inputMode="decimal"`, not `type="number"`.** A number input lets the
  browser reformat silently and increments on scroll. Exact money is no place
  for either.

**And it is tested at the edges**, not the happy path: zero, one halala,
leading zeros, the `int4` ceiling, grouping commas, scientific notation, and a
round trip back to the editable string.

**Backs it up:** `lib/format.ts`, `format.spec.ts`, F07-F23.

---

## Q5 - Tenant-isolated policy management and historical decisions

> A manager raises the auto-approval limit. What happens to the expense that
> was flagged yesterday under the old limit - and how do I know?

**Nothing. Deliberately, and it is what keeps the system explainable.**

Assumption A7: editing a policy never re-evaluates existing expenses. Each
expense stored the policy it was judged against at submission, so "why was this
flagged?" stays answerable after any number of edits. Re-evaluating would
rewrite decisions a human may already have acted on and leave an audit trail
disagreeing with itself.

Four tests hold that line, and they are deliberately different shapes: a **new**
expense uses the updated policy (B14); an identical **retry** of an old one
returns its **original** decision (B15); an already-evaluated expense keeps its
snapshot and reasons (B16); a resolved review is not reopened (B17).

B15 is the one worth pausing on. Idempotency is about the expense, not about
re-running the rules - the same submission must not mean two different things
depending on when it was retried.

**On which fields are editable:** all four, and not because the columns exist.
The requirements matrix records "per-company policy settings" and "the two
companies seeded with different values", and the seed implements it - 3/60
versus 5/30. A fixed platform constant could not be seeded per company.

**On tenancy:** `companyId` comes from the session and goes into the `where` of
the mutation - `updateMany` with the tenant in its WHERE rather than `update`
by id, so there is no moment at which a row is read, judged to be the caller's,
and then written. A body carrying `companyId` is a 400, not an ignored field.

**On normalisation**, which is the subtle one: `blockedCategories` goes through
**the same `normaliseCategory` the expense pipeline uses**. Two implementations
means a manager types " gambling ", the expense arrives as GAMBLING, the
strings differ, and the rule quietly stops firing - nothing errors, the company
simply stops being protected. F07-B07b submits a real expense and asserts it is
rejected, because "the strings match" and "the rule works" are different claims.

**The honest limitation:** concurrent policy edits are last-write-wins with no
conflict reported. That is a deliberate stopping point - a policy edit is an
infrequent deliberate act, unlike a review resolution where racing is expected -
and it is recorded as R-31 rather than implied to be handled.

**Backs it up:** A7, `policy.service.ts`, `normaliseCategory`, F07-B07b, B14,
B15, B16, B17, R-31.
