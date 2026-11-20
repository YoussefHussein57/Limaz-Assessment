# F04 - Interview defence

Five questions a LIMAZ interviewer could reasonably ask after reading the F04
code. Each attacks a decision actually made here.

---

## Q1 - Policy evaluation architecture and alternatives

> Three rules in three functions, plus a fourth that runs them. That is a
> rules engine with the configurability removed. Why not build the
> configurable version once, so F08 can let companies define their own rules
> without touching this code again?

**Because nobody has asked for a company-defined rule, and a rules engine is
the most expensive thing to build speculatively.**

A configurable engine needs a representation for conditions, a way to
serialise it, validation so a malformed rule cannot be saved, an evaluator for
that representation, a migration path when the representation changes, and a
UI nobody has designed. It also moves the rules out of a place where
TypeScript checks them and into data where it cannot.

The three rules are fixed by the assessment, and the policy *values* are
already configurable per company - limit, count, window, blocked list - which
is the configurability that was actually required.

**Why three functions rather than one.** A single function mixing all three
means every boundary test exercises all three, so a failure says "something is
wrong" instead of naming the rule. Split, the 26 rule tests run in 0.4 seconds
with no database at all, which is why the boundaries are covered exhaustively
rather than sampled.

**Why not strategy classes.** A class with one method and no state is a
function with ceremony. There is no dispatch to make polymorphic - the caller
always runs all three.

**The split that actually matters is not rule-vs-rule, it is pure-vs-impure:**

```
policy-rules.ts            decides      - no Prisma import at all
policy-engine.evaluator.ts measures     - one COUNT, inside the transaction
expense-submission.ts      orchestrates - lock, idempotency, writes
```

Counting rows needs a database; deciding does not. Keeping them apart is what
lets every rule boundary be tested exhaustively and leaves only the window
semantics needing PostgreSQL.

**Backs it up:** `policy/policy-rules.ts`, `policy/policy-engine.evaluator.ts`,
26 unit tests.

---

## Q2 - Decision precedence and complete reasons

> If the category is blocked, the answer is REJECT. Nothing can change that.
> Why do you keep evaluating the other two rules, and why is precedence a
> lookup table instead of just checking REJECT first?

**Because the decision carries one piece of information and the evaluation
carries three.**

An expense that is over the limit *and* in a blocked category *and* the fourth
in its window has three things wrong with it. The caller gets REJECT either
way; the manager reading it in F07 needs to know all three, and the assessment
requires every triggered rule in the result. Short-circuiting discards evidence
the contract promises, to save two integer comparisons.

It would also make the output depend on **which rule was checked first**. The
same expense would report one reason or three depending on the order of three
lines that look independent - which is exactly the fragility the rank table
removes.

```ts
const RANK = { APPROVE: 1, REVIEW: 2, REJECT: 3 };
```

With a rank, reordering is provably irrelevant. F04-T15 asserts it over all
six permutations - not because anyone will reorder them, but because the test
demonstrates the property rather than the current arrangement.

**Two details that follow and are easy to get wrong:**

- **Two REVIEW rules open one review.** The review belongs to the expense, not
  to the rule. `Review.expenseId` is `@unique`, so a per-rule review would
  raise 23505 and turn a logic bug into a 500.
- **A REJECT opens no review at all**, even though two REVIEW rules fired. A
  rejected expense is final the moment it is decided, so an open review
  against it would be work nobody can complete (A8). The rule hits still
  record that those two rules said REVIEW.

**Backs it up:** `decide()`, tests F04-T11 to T15, F04-T35b, F04-T36.

---

## Q3 - Advisory locks, transaction boundaries and isolation

> You take a `pg_advisory_xact_lock` as the first statement and run at READ
> COMMITTED. Raising the isolation level to REPEATABLE READ would give you a
> stronger guarantee for free. Why not?

**Because at REPEATABLE READ this design is silently wrong.**

Under READ COMMITTED **each statement takes a fresh snapshot**. The lock is
statement one, so the COUNT that follows snapshots *after* the lock is granted,
and sees every competitor for this employee that has already committed. The
lock is still held at the INSERT, so no competitor can commit in between. That
is the whole mechanism.

Under REPEATABLE READ the snapshot is taken at the transaction's **first**
statement - which is the lock acquisition itself. The transaction then blocks.
When the lock is finally granted, its snapshot predates the competitor that
just committed, so the committed row is invisible and the count is short.

**The code would look correct. The lock would genuinely be held. The answer
would be wrong, with no error anywhere.** Raising the isolation level here
makes the system less correct, not more.

SERIALIZABLE was also rejected: the advisory lock already provides mutual
exclusion on the only contended invariant, so SERIALIZABLE would add 40001
failures and retry handling across every transaction for no additional
guarantee.

**Three other choices in that line:**

- **`pg_advisory_xact_lock`, never the session variant.** Transaction-scoped
  means COMMIT or ROLLBACK releases it, including a rollback caused by the
  process dying. A session lock survives and poisons a pooled connection
  permanently - a latent outage under PgBouncer. F04-T32 asserts the next
  submission for the same employee proceeds after a failure.
- **Two arguments, not one concatenated string.** `hashtext(a || ':' || b)`
  gives a 32-bit key space where the birthday bound puts a collision around
  77,000 distinct keys, and needs a separator that cannot occur in an
  employeeId. Two independent 32-bit arguments give 2^64.
- **A collision costs latency, never correctness.** Every query inside the
  lock still filters by the real companyId and employeeId. The lock decides
  who waits, never who sees what.

**And the lock is injected rather than inlined**, so the negative control can
run the production path with it absent: removing it produces 5 APPROVE, 0
reviews, 0 frequency hits. There is no flag that could do that in production -
substitution is only possible through the testing API.

**Backs it up:** ADR-007, `frequency-lock.ts`, F04-T26, F04-NC1, F04-T32.

---

## Q4 - Frequency-window semantics and concurrency

> Your five-concurrent test asserts three APPROVE and two REVIEW. How do you
> know the requests actually overlapped, rather than the test runner handing
> them to the server one at a time?

**Two things, and only together are they evidence.**

**First, they are provably in flight at once.** A test-only interceptor holds
each request *before* the controller - before the transaction opens and before
the lock is attempted - and releases all five together. They then race for the
lock as five real clients would. `DB_POOL_MAX` is 10, above the concurrency, so
they cannot queue inside the connection pool and serialise there instead (that
was risk R-10, and it is how a concurrency test passes while proving nothing).

The barrier had to be *there* specifically. F03's barrier sits inside the
evaluator, **after** the lock; for five requests sharing one lock key that
deadlocks, because only the holder can proceed and the others never arrive.

**Second, the outcome is only reachable through serialisation.** The recorded
`countIncludingCurrent` values are **4 and 5**. Each transaction saw the ones
before it. Without the lock they would all count zero.

**And that is measured, not assumed.** The negative control replaces the lock
with a no-op and runs the identical scenario: **5 APPROVE, 0 reviews, 0
frequency hits** - no error anywhere, the rule simply stops firing.

A pre-lock barrier alone would not have been enough for that control. It
proves overlap, not that they read the same count: one transaction could still
count, insert and commit before another reached its count, so the control
would pass intermittently. So it adds a **second** synchronisation point
between the count and the first write - used only with the lock disabled,
because pairing it with the real lock deadlocks by construction. F04-NC2
demonstrates that deadlock deliberately so it is documented rather than
discovered.

**On the window itself:** `[spentAt - window, spentAt]`, both ends inclusive,
measured on `spentAt` rather than arrival time - a stalled client queue
flushing ten expenses would otherwise fire the rule on behaviour that never
happened. Rejected expenses count (A2), because otherwise an employee could
reset their own window by submitting something certain to be rejected.

**Backs it up:** F04-T26, F04-NC1, F04-NC2, F04-T16 to T22, ADR-002.

---

## Q5 - Scalability, historical decisions and trade-offs

> Every submission does a COUNT inside a lock. At a thousand expenses a second
> that is a queue. And you snapshot the whole policy onto every row, which is
> duplicated data. Defend both.

**First, the honest caveat, because the question invites a confident number
and I do not have one: I have not load tested this.** No benchmark has been
run at any throughput. What follows is reasoning from the shape of the design,
and I would say so in the room rather than let a plausible answer pass as a
measurement.

**On the lock.** It is per `(company, employee)`, so different employees never
block each other and different companies never block each other. The only
contention is the same employee submitting in parallel, which is exactly the
case that must be serialised. So I would not *expect* the lock to be the first
bottleneck - the transaction throughput of a single PostgreSQL instance is the
more likely candidate - but that is a hypothesis to test, not a finding.

In order, if it were measured to be a problem: PgBouncer in transaction mode -
compatible precisely *because* the lock is transaction-scoped; partition
`expenses` by month, since the frequency query only touches the most recent
partition; and only then move the counter to a Redis sliding window with
PostgreSQL as the source of truth. That last step **replaces a guarantee with
an approximation**, and needs an explicit decision about what happens when
Redis is unavailable. None of it is built, because none of it has a measured
problem behind it.

The COUNT itself is an `Index Only Scan` on `(companyId, employeeId,
spentAt)` - measured with EXPLAIN ANALYZE on 4,000 rows, four buffer hits. I
checked rather than asserted, because on the test database PostgreSQL
correctly chooses a sequential scan and the claim would have been false in the
environment the tests run in.

**On the snapshot.** It is four fields of denormalised data, and it is what
makes a decision explainable a year later.

Without it, "why was this reviewed?" is answered against *today's* policy. An
expense reviewed under a 500 limit, after the limit rises to 5,000, appears to
have been reviewed for no reason - the audit trail becomes actively
misleading rather than merely incomplete. A7 says policy edits never
re-evaluate history, and the snapshot is what makes that statement verifiable
instead of a promise.

It also removes the need for a policy versioning system: **the snapshot is the
version**, recorded per expense, with no version table, no foreign key and no
join. The cost is four fields per row; the alternative is a schema that has to
answer "which version was in force at this instant" for every historical
query.

**The trade-off I would name unprompted:** the snapshot records what the
policy *was*, not the evaluator's *code*. If a rule's logic changed in a later
release, an old expense's snapshot would no longer fully explain its decision.
Storing the rule hits with their evidence - the limit and the amount, the
window and the count - mitigates it, because the reasons record what was
actually compared. It does not eliminate it, and that is a limitation rather
than a solved problem.

**Backs it up:** ADR-007, ADR-002, F04-T40 to T42, the EXPLAIN ANALYZE output
in the F04 test matrix.
