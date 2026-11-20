# ADR-011: A composite foreign key makes the denormalised tenant unfalsifiable

- **Status:** Accepted, 2026-11-20 - **implemented in F01**
- **Assessment question:** none directly; it is what makes ADR-004 safe
- **Related:** ADR-003, ADR-004, assumption A9, risk R-01

## Context

ADR-004 resolves a review with one conditional statement, so that the tenant
guard and the concurrency guard are evaluated atomically together:

```sql
UPDATE reviews
   SET state = 'RESOLVED', ...
 WHERE id = $1 AND company_id = $2 AND state = 'OPEN';
```

Splitting the tenant check into a separate `SELECT` would open a
time-of-check-to-time-of-use gap. Keeping it in the same `WHERE` requires
`company_id` to be a column on `reviews` - which means it is **denormalised**
from the expense that owns the review.

That raises the obvious question: what stops `reviews.company_id` from
differing from `expenses.company_id`?

If they ever diverge, the consequence is not a cosmetic inconsistency. The
guard in the statement above reads `reviews.company_id`. A review carrying the
wrong tenant would let company B resolve company A's expense, **and the guard
we rely on would approve it**, because it is reading the corrupted value.

## Alternatives considered

| Option | What prevents divergence | Verdict |
|---|---|---|
| **A. Application discipline** - the review is created in the same transaction, from the same authenticated context | Nothing enforceable. A future refactor, a bug, a data-repair script, or someone typing into psql can break it, and nothing detects it | Rejected |
| **B. A trigger comparing the two rows on insert and update** | Works, but puts business logic in PL/pgSQL, and is easy to drop accidentally | Rejected |
| **C. Composite foreign key** | **PostgreSQL itself** | **Chosen** |
| D. No `company_id` on reviews at all; join to expenses for the tenant check | Removes the denormalisation but forces the guard into a join or a second statement, reintroducing the TOCTOU gap ADR-004 exists to close | Rejected |

## Decision

```sql
-- 1. Make (id, company_id) a referenceable key on expenses.
--    It looks redundant because id is already unique - it is not. PostgreSQL
--    requires a UNIQUE constraint on exactly the referenced columns.
ALTER TABLE expenses
  ADD CONSTRAINT "expenses_id_companyId_key" UNIQUE (id, "companyId");

-- 2. Bind the review to its expense AND its tenant in one key.
ALTER TABLE reviews
  ADD CONSTRAINT "reviews_expenseId_companyId_fkey"
  FOREIGN KEY ("expenseId", "companyId")
  REFERENCES expenses (id, "companyId")
  ON DELETE RESTRICT;
```

In Prisma:

```prisma
model Expense {
  @@unique([id, companyId])
}

model Review {
  expense Expense @relation(
    fields:     [expenseId, companyId],
    references: [id, companyId],
    onDelete:   Restrict,
  )
  @@unique([expenseId, companyId]) // required by Prisma for a 1-1 composite relation
}
```

A review whose `companyId` differs from its expense's is now **rejected by the
database**, on insert and on update, from any writer.

## Consequences

- One extra unique index on `expenses(id, companyId)`. It is as selective as
  the primary key, so the storage and write cost are small.
- Prisma requires `@@unique([expenseId, companyId])` on `Review` for the
  relation to be one-to-one. The plain `@unique` on `expenseId` is kept
  alongside it, because "one review per expense" should be stated directly
  rather than inferred from a two-column constraint plus a foreign key.
- `reviews` has **no separate foreign key to `companies`**. It would be
  redundant: `reviews(expenseId, companyId)` references `expenses(id, companyId)`,
  and `expenses(companyId)` references `companies(id)`, so a review's tenant is
  already transitively guaranteed to be a real company.

## Why `rule_hits` does not get the same treatment

`rule_hits` has no `companyId` at all, and that asymmetry is deliberate.

A `RuleHit` is only ever reached **through** its expense, so the tenant filter
is applied to the expense and the rule hit inherits it. A `Review` is queried
directly (`WHERE companyId = ? AND state = 'OPEN'` is the manager's main
screen) and updated directly, so it needs the tenant on the row.

**Denormalise where there is direct access, not out of habit.**

## Verification

Test **F01-T09** inserts a review for company A's expense while claiming
company B, and asserts both the SQLSTATE and the constraint name:

```ts
expect(rejection.code).toBe('23503');
expect(rejection.constraint).toBe('reviews_expenseId_companyId_fkey');
```

**F01-T09b** does the same for an `UPDATE` that tries to move an existing
review to another tenant.

### Negative control, executed 2026-11-20

The constraint was dropped from the test database and the same insert retried:

```
RESULT: cross-tenant review ACCEPTED  ->  review.companyId = 5851387a-...
        expense.companyId             = 7d2a27c1-...
```

The write succeeded. That is the proof that F01-T09 tests something real
rather than passing for an unrelated reason, and it is the concrete
demonstration of what option A above would have left exposed.

## Failure modes

| Failure | Effect | Mitigation |
|---|---|---|
| The composite unique on `expenses` is removed | The foreign key cannot exist; migration fails loudly | F01-T03b asserts the index exists |
| Someone "tidies up" the apparently redundant unique | Same | A comment in the schema explains why it is there |
| A future table denormalises a tenant without this pattern | Silent divergence returns | ADR recorded; reviewed when any tenant column is added |
