# F01 - Interview defence

Five questions a LIMAZ interviewer could reasonably ask after reading the F01
schema. Each attacks a decision actually made here.

---

## Q1 - Normalisation

> `reviews` stores `companyId`, which is already on the expense it points at.
> That is a denormalisation. Defend it.

**It is, and the denormalisation is the point - what matters is that it cannot
go wrong.**

ADR-004 resolves a review with one conditional statement so the tenant guard
and the concurrency guard are evaluated atomically:

```sql
UPDATE reviews SET state = 'RESOLVED', ...
 WHERE id = $1 AND company_id = $2 AND state = 'OPEN';
```

Checking the tenant in a separate `SELECT` would open a
time-of-check-to-time-of-use gap between the check and the update. Keeping it
in the same `WHERE` requires the column on the row.

The usual objection to denormalising is drift, and here drift is not cosmetic:
that guard *reads* `reviews.company_id`, so a corrupted value would make the
guard itself approve a cross-tenant resolve.

So drift is made impossible by the database:

```sql
ALTER TABLE expenses ADD CONSTRAINT "expenses_id_companyId_key"
  UNIQUE (id, "companyId");

ALTER TABLE reviews ADD CONSTRAINT "reviews_expenseId_companyId_fkey"
  FOREIGN KEY ("expenseId", "companyId") REFERENCES expenses (id, "companyId");
```

The unique on `expenses(id, companyId)` looks redundant - `id` is already
unique - but PostgreSQL requires a UNIQUE on exactly the referenced columns
before they can be a foreign-key target.

I also did *not* denormalise the tenant onto `rule_hits`, and the asymmetry is
deliberate: a rule hit is only ever reached through its expense, so it
inherits that filter. A review is queried and updated directly. **Denormalise
where there is direct access, not out of habit.**

**Backed by:** ADR-011, F01-T09, F01-T09b, and the executed negative control.

---

## Q2 - Multi-tenant isolation

> Suppose a bug writes a review with the wrong `companyId`. What happens?

**It cannot be written.** `23503` on `reviews_expenseId_companyId_fkey`, on
insert and on update.

I checked that this test is not vacuous rather than assuming it. I dropped the
constraint from the test database and retried the same insert:

```
RESULT: cross-tenant review ACCEPTED  ->  review.companyId = 5851387a-...
        expense.companyId             = 7d2a27c1-...
```

It was accepted. So the constraint is the thing stopping it, and F01-T09 is
testing the constraint rather than passing for an unrelated reason.

The related question is what happens one layer up, when company A *asks* for
company B's record. That is ADR-003: `404`, never `403`, because `403`
confirms the record exists and turns the endpoint into an enumeration oracle.
It is enforced structurally - `WHERE company_id = <authenticated>` in every
query, so the row is never loaded - and it is tested in F02.

The two work together: the constraint stops bad data existing, the query shape
stops good data leaking.

---

## Q3 - Unique constraints and races

> Why is idempotency a unique constraint instead of checking for an existing
> row first?

**Because the check-then-insert loses the race, and the race is the normal
case here.** Clients retry; two retries can be in flight at the same moment.

```
request A: SELECT ... WHERE externalId = 'exp-1001'  ->  no rows
request B: SELECT ... WHERE externalId = 'exp-1001'  ->  no rows
request A: INSERT                                     ->  ok
request B: INSERT                                     ->  ok
```

Two expenses, and both count toward the frequency rule. `UNIQUE (companyId,
externalId)` moves the decision to the only place that can serialise it: the
database rejects the second insert with `23505`, and the application turns
that into the original decision (ADR-001).

It is scoped to the company, not global. Company A choosing `exp-1001` must
not stop company B from doing the same - F01-T04 proves the first, F01-T05 the
second, and the seed itself contains that exact pair so the behaviour is
visible in the running system.

**The important caveat:** this constraint gives idempotency and **nothing
else**. It does not protect correct frequency counting under concurrency.
Two concurrent submissions for the same employee with *different* `externalId`
values satisfy it perfectly, both read `count = 3`, and both conclude the rule
does not fire. That is a read-then-write invariant and needs serialisation -
an advisory lock, in F04. Two different guarantees, two different mechanisms
(ADR-007).

---

## Q4 - Index selection

> You have two indexes on `expenses` with `companyId` leading. Why not one?

Because one cannot serve both queries.

| Query | Index |
|---|---|
| `WHERE companyId = ? AND employeeId = ? AND spentAt BETWEEN ? AND ?` | `(companyId, employeeId, spentAt)` |
| `WHERE companyId = ? ORDER BY spentAt DESC LIMIT 50` | `(companyId, spentAt)` |

The dashboard query cannot use the first index for ordering, because
`employeeId` sits between the two columns it uses. PostgreSQL could still scan
it, but it would have to sort afterwards.

Column order in the first index is also load-bearing: the **range** column must
come last. With `spentAt` in the middle, the `employeeId` equality could not be
used as part of the same index scan. That matters more than usual here, because
that query runs **inside a transaction holding an advisory lock** (ADR-007) -
time spent in it is time every other submission for that employee waits.

The cost is honest: two indexes means every insert writes to both, on the
highest-insert table in the system. That is the trade - and it is the reason I
did not add a third for `(companyId, status)` or similar, which nothing
currently needs.

Primary keys are `uuid(7)` rather than `uuid(4)` for the same reason: v7 is
time-ordered, so inserts land at the end of the B-tree instead of scattering
across it and splitting pages.

---

## Q5 - Referential integrity and transactions

> You have five CHECK constraints. Why not validate that in the application,
> where you can return a friendly error?

**Both, and they do different jobs.**

| | Application validation | CHECK constraint |
|---|---|---|
| Gives | a clear `400` naming the field | a state that cannot exist |
| Runs on | requests through our code | **every** write, including migrations and psql |
| Can be forgotten | yes, on one new code path | no |

The one I would point at is `reviews_state_resolution_check`:

```sql
CHECK (
  (state = 'OPEN'     AND outcome IS NULL     AND "resolvedByUserId" IS NULL)
  OR
  (state = 'RESOLVED' AND outcome IS NOT NULL AND "resolvedByUserId" IS NOT NULL
                      AND "resolvedAt" IS NOT NULL)
)
```

The assessment requires a record of who resolved each review, when, and how.
This makes a resolved review with no recorded reviewer **unstorable** rather
than merely discouraged. The audit trail is not a convention somebody has to
remember.

`expenses_decision_status_check` encodes something subtler: a decision other
than `REVIEW` is final the moment it is made, because no review is opened, so
no manager can change it. An `APPROVE` expense with `REJECTED` status is a
state nothing can produce - and now nothing can store either.

**What the constraints deliberately do not do:** they are not a concurrency
mechanism. `UNIQUE (expenseId)` stops two reviews on one expense; it does
nothing about two managers resolving the *same* review. That needs the
conditional `UPDATE` of ADR-004, and it is built and tested in F05.

Constraints make bad states impossible. Transactions make multi-row changes
atomic. Locks make read-then-write sequences correct. Validation makes errors
legible. Confusing any of them for another is how these systems break.
