# F05 - Interview defence

Five questions a LIMAZ interviewer could reasonably ask after reading the F05
code. Each attacks a decision actually made here.

---

## Q1 - Atomic conditional updates versus read-then-update

> You wrap the resolution in a transaction. Inside it you could read the
> review, check it is OPEN, and update. Instead you push `state = 'OPEN'` into
> the UPDATE's own WHERE clause and then inspect a row count. The transaction
> already gives you isolation - what does the predicate add?

**The transaction does not prevent a lost update, and that is the specific
thing being prevented.**

A transaction gives atomicity and isolation. It does not stop two
transactions from reading the same row and both writing it: nothing conflicts
until the writes themselves, and by then both have already decided, in
application memory, that the review was OPEN. The second write lands on top of
the first - different outcome, different reviewer, different timestamp - and
**nobody is told**. The audit trail simply names the wrong person.

Putting the predicate in the mutation changes what happens at the row:

1. The second statement blocks on the row lock the first holds.
2. When the first commits, PostgreSQL does not just proceed. It
   **re-evaluates the second statement's WHERE against the updated row** -
   the EvalPlanQual mechanism.
3. The row is now RESOLVED, the predicate fails, and the statement affects
   zero rows.

That re-check is the entire reason this is safe at READ COMMITTED, and it is
exactly what an in-memory check skips.

**The row count is then the permission slip.** One row means this request
performed the transition. Zero means it did not - and zero is four different
things, not one: the review is missing or another tenant's (404), already
resolved by this manager the same way (200, having written nothing), resolved
by anyone else or differently (409), or - the case worth naming - it exists,
is this company's, and is still OPEN, which is a contradiction and answers
500. Treating every zero-row update as a successful retry would report
success for something that never happened.

**And it is measured.** F05-NC1 removes the predicate, keeps the in-memory
check, and forces both transactions to read before either writes: both
succeed, the second overwrites the first, and no error is raised anywhere.

**Backs it up:** `review-resolution.service.ts`, ADR-004, F05-T31, F05-NC1.

---

## Q2 - PostgreSQL concurrency and isolation

> Two managers resolve the same review at the same instant. Walk me through
> what PostgreSQL actually does, and tell me why you did not reach for
> SERIALIZABLE or an advisory lock.

**The row lock plus the predicate re-check is exactly the right size for this
invariant, and the other two tools are the wrong shape.**

The sequence: Alice's UPDATE matches, takes the row lock, holds it until
COMMIT. Bob's UPDATE reaches the same row and blocks - not in my code, inside
PostgreSQL. On Alice's COMMIT, Bob's WHERE is re-evaluated against the new
row version, `state = 'OPEN'` is false, and Bob gets zero rows. He then does a
tenant-scoped lookup and returns 409 naming Alice.

**That contention is verified, not assumed.** A test holds the lock, dispatches
a competing request, and polls `pg_blocking_pids()` from a separate connection
with a bounded timeout until PostgreSQL itself reports a blocked backend.

**Why not SERIALIZABLE.** It would also work, and it would charge every
transaction in the system for a guarantee one statement already provides:
40001 serialisation failures and retry handling everywhere, for an invariant a
row lock covers exactly.

**Why not an advisory lock, when F04 uses one.** Because the invariants are
different shapes:

| | F04 frequency | F05 resolution |
|---|---|---|
| Invariant | a COUNT across many rows | one row's state transition |
| Can a row lock protect it? | **No** - there is no single row to lock | **Yes** |

F04's read-then-write is over a *set*, which is why it needs explicit
serialisation. Here, an advisory lock would serialise unrelated reviews for no
gain.

**One more thing I would raise unprompted:** the review update and the expense
update are in one transaction, which is what makes "the review succeeded but
the expense failed" a non-question. Neither write is visible until COMMIT, so
there is no observable moment where a review is resolved while its expense is
still pending. That state only exists if the writes are split across
transactions or HTTP calls.

**Backs it up:** ADR-004, F05-T31 to T38, the `pg_blocking_pids()` test.

---

## Q3 - Tenant isolation and trusted reviewer identity

> The reviewer id and the company id both end up in the database. Where does
> each come from, and what stops a manager resolving another company's review?

**Both come from the verified session, and neither can be influenced by the
request.**

The DTO has exactly one field, `decision`, and it is `.strict()`. A body
carrying `reviewerId`, `companyId`, `resolvedAt`, `state` or `outcome` is
**refused with a 400** - not ignored. That distinction matters more here than
usual: an ignored `reviewerId` leaves the caller believing they recorded who
acted, and the audit trail then says something nobody intended.

The reviewer is `principal.userId` from the session. The tenant is
`principal.companyId`, and it goes **into the WHERE clause of the mutation
itself**:

```sql
WHERE id = $1 AND "companyId" = $2 AND state = 'OPEN'
```

Not a check after fetching a global row. A post-fetch check has already read
another tenant's data into the process, and leaves a time-of-check-to-time-of-
use gap between the check and the write. One statement, one evaluation, no gap.

**A foreign review answers 404, not 403.** 403 confirms the row exists, which
turns the endpoint into an enumeration oracle - a caller could walk ids and
learn how many reviews a competitor has. Because the tenant predicate is in
the query, "not yours" and "not there" are genuinely the same code path, and a
test asserts the two bodies are **byte-identical** rather than merely similar.

**What the schema contributes**, and this is why no migration was needed:
`reviews(expenseId, companyId)` is a composite foreign key onto
`expenses(id, companyId)`. A review's tenant is not an independent copy that
could drift - a row naming two different companies is physically unstorable.
So the tenant predicate in that WHERE is trustworthy by construction.

**On the platform admin:** denied, 403 `insufficient_role`. Reviewing a
company's spending is that company's business and no approved contract grants
an administrator that authority, so it is denied rather than assumed. That is
one decorator - `@Roles('MANAGER')` - and no new code: the F02 guards already
answer the question.

**Backs it up:** `reviews.controller.ts`, `tenantScope()`, ADR-003, ADR-011,
F05-T06, T12, T13, T14, T37.

---

## Q4 - Transaction boundaries and rollback

> What happens if the review update succeeds and the expense update fails?

**Nothing observable - and that is a property of the boundary, not of error
handling.**

Both writes are in one transaction. Neither is visible to any other
transaction until COMMIT, so there is no moment at which a review is resolved
while its expense is still pending. That intermediate state only exists if the
two writes are split across separate transactions or separate HTTP calls,
which is the mistake the design avoids rather than recovers from.

The expense update is itself conditional:

```ts
where: { id: expenseId, companyId, status: 'PENDING_REVIEW' }
```

If that affects anything other than exactly one row, the service throws, and
the review update rolls back with it. A resolved review pointing at an expense
that was never transitioned is worse than a failed request, because the first
is silent and permanent and the second is visible and retryable.

**F05-T39 forces it:** the expense is moved out of PENDING_REVIEW behind the
service's back, so the conditional update matches zero rows. The assertion is
that the review is **still OPEN**, with a null outcome, null reviewer and null
timestamp. F05-T42 then puts the expense back and resolves successfully - the
failure left nothing behind.

**Two details I would mention:**

- The response is read **after** COMMIT, so it describes committed state and
  never a view that could still roll back. Returning the in-transaction view
  would mean reporting success for a transaction that might not survive.
- There is no retry loop. The conditional update either wins or does not, and
  a loser is told why. Retrying automatically would be the service guessing at
  what a human meant.

**On audit failure specifically:** there is no separate audit write to fail.
`resolvedByUserId`, `resolvedAt` and `outcome` are columns on the review, set
by the same UPDATE that performs the transition, with a CHECK constraint
making a half-written set unstorable. That is why the prompt's "audit write
fails" case is marked NOT APPLICABLE in the matrix rather than passed - and
why no generic audit framework was built.

**Backs it up:** `review-resolution.service.ts`, F05-T39, T40, T42.

---

## Q5 - Immutable decisions, final status and retry semantics

> After a manager approves a flagged expense, why is `decision` still REVIEW?
> And why does repeating the same resolution return 200 rather than 409, when
> the requirement says exactly one resolution may succeed?

**Two questions, and the second is the more interesting one.**

**On the two fields.** `decision` records what the policy concluded at
submission. `status` records the outcome. They are different facts, and
merging them loses the answer to "what did the policy originally say?" - a
basic audit question. A manager approving an expense does not mean the policy
was wrong to flag it; it means a human looked and decided. Resolution writes
`status` and never touches `decision`, the rule hits, the policy snapshot or
the payload hash, and no policy is consulted at all - a policy change between
submission and resolution changes neither (F05-T29).

It also means the F03 response contract needed no correction. It already
returns both: resubmitting after resolution gives `decision: REVIEW,
status: APPROVED, duplicate: true`.

**On the 200.** The requirement is exactly one successful **state
transition**, not exactly one 2xx response. Those are different guarantees and
conflating them makes the test demand the wrong thing.

ADR-004's exemption is narrow: the **same manager** repeating the **same
outcome**. It exists for a lost response - the transaction committed, the
reply never arrived, the client retried - and returning 409 for an action that
genuinely succeeded would send that manager investigating something that is
fine. The replay path performs **zero writes**: the conditional update matched
nothing, so `updatedAt` is unchanged, and the test proves that by comparing it
before and after rather than trusting the status code.

So two concurrent identical requests from one manager give **two 200s and one
transition**, and that is correct. A *different* manager repeating the same
decision still gets 409 - they did not lose a response, they are acting on
stale information and should be told.

**The honest limitation:** that narrow exemption is the only thing standing
between this and a strict single-winner rule, and it is a judgement call. A
client that retried aggressively and happened to always send the same decision
would see repeated successes. It writes nothing each time, so the data is
safe, but a reviewer could reasonably argue for 409 everywhere and a clearer
rule. ADR-004 chose the other way, deliberately, because the failure it
prevents - telling someone their successful action failed - is the one that
actually happens.

**Backs it up:** ADR-004, F05-T24, T25, T26, T30, T34, T43.
