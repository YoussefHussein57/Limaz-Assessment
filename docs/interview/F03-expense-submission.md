# F03 - Interview defence

Five questions a LIMAZ interviewer could reasonably ask after reading the F03
code. Each attacks a decision actually made here.

---

## Q1 - Database uniqueness versus application-level duplicate checks

> You already `SELECT` by `(companyId, externalId)` inside the transaction
> before inserting. If that check is there, the unique index is dead weight -
> and if the index is the real guarantee, the `SELECT` is dead weight. Which
> is it, and why do you have both?

**Both, and they answer different questions.**

The `SELECT` alone is a classic read-then-write race:

```
A: SELECT → none          B: SELECT → none
A: INSERT → ok            B: INSERT → ok
```

Two statements with a gap between them. No ordering of application code
closes it, because the gap is in the database's snapshot semantics, not in my
code. Under `READ COMMITTED` each statement takes a fresh snapshot, so B's
`SELECT` genuinely saw a table without A's row.

The index alone is sufficient for **correctness** and insufficient for
**behaviour**. It stops the duplicate row, but on its own the losing request
gets a `23505` and the caller gets a 500 - and a caller receiving 500 retries,
which is exactly the wrong response to "this already succeeded".

So: the `SELECT` serves the common case, which is a sequential retry arriving
minutes later. It costs one indexed lookup and returns the original decision
without touching the write path at all. The index serves the rare case, which
is two requests genuinely overlapping. **The index is the authority; the
`SELECT` is the fast path.**

**The part I did not expect:** the advisory lock changes which of them fires.
Two identical requests for the same employee take the same lock key, so they
serialise, and the second finds the first's committed row at the `SELECT`.
**The index never fires.** It only fires when two requests share an
`externalId` but take different lock keys - different `employeeId`. That is
test F03-T21, and it is why the negative control uses that shape: a
concurrency suite built only around identical submissions passes with the
index dropped entirely.

**Backs it up:** `expense-submission.service.ts` steps 2 and 5, ADR-007, tests
F03-T17, F03-T21, F03-T27, F03-T28.

---

## Q2 - Deterministic payload hashing and canonicalisation

> Why not `sha256(JSON.stringify(req.body))`? It is one line and it detects
> every change.

**Because it detects changes that are not changes, and it is unstable in both
directions.**

Three concrete failures:

1. **Key order.** `{"amount":1,"merchant":"X"}` and
   `{"merchant":"X","amount":1}` are the same expense and hash differently.
   A client that switched JSON libraries would get a 409 on every retry, with
   no way to diagnose it.
2. **Server-generated and incidental fields.** The raw body does not contain
   `receivedAt`, but it does contain `externalId` - which is the key, not the
   payload - and would contain any field a client added for its own purposes.
3. **Equivalent representations.** `12:15+03:00` and `09:15Z` are the same
   instant. `sar` and `SAR` are the same currency. Raw hashing calls them
   different.

So six named fields are normalised and serialised as a **fixed-order JSON
array**:

```ts
JSON.stringify([employeeId, amountMinor, currency, merchant, category, spentAtIso])
```

An array rather than a sorted object, because then key ordering is not a step
that can be got wrong - it is part of the structure. And JSON rather than a
delimiter, because joining with `|` collides: merchant `a|b` with category `C`
produces the same string as merchant `a` with category `b|C`. JSON escapes
quotes inside each value, so no value can impersonate a field boundary.
There is a test for exactly that.

**The line I had to draw, and it is the interesting part: identifiers are
compared exactly; only content is normalised.**

Normalising an identifier merges identities. If ` exp-1` were trimmed to
`exp-1`, a caller would receive the decision belonging to a different record,
silently, with nothing in the response to indicate a substitution. So
`externalId` and `employeeId` are never trimmed, case-folded or
NFC-normalised, and a value carrying surrounding whitespace is **rejected with
400** rather than quietly repaired. `merchant` and `category` *are*
NFC-normalised, because `é` as one code point and as `e` + combining acute are
visually identical and would otherwise be a 409 nobody could diagnose.

**Why not a canonicalisation library (RFC 8785).** It solves arbitrary JSON:
nested key ordering, number-format edge cases, Unicode collation. Six fields
of known types have none of those problems, and the dependency would need
defending.

**The subtle requirement:** the normalised values are what gets **stored**,
not only what gets hashed. Storing the raw input while hashing the normalised
form makes a retry of a stored row conflict with itself - the column truncates
`spentAt` to milliseconds while the hash covered microseconds that were
dropped.

**Backs it up:** `canonical-payload.ts`, 17 unit tests, ADR-001.

---

## Q3 - Concurrent submissions and transaction behaviour

> Walk me through what happens when the INSERT loses the race. You catch the
> unique violation - then what?

**Then nothing, because the transaction is already dead.**

A unique violation puts the PostgreSQL transaction into an **aborted** state.
Every statement after it, including a plain `SELECT`, fails with:

```
25P02  current transaction is aborted, commands ignored until end of transaction block
```

So the obvious implementation - catch `23505`, `SELECT` the winning row,
return it - does not work. It produces a second, more confusing error, and is
the usual reason this path ends as a 500 in production.

Two ways out:

| Option | Trade-off |
|---|---|
| `SAVEPOINT` before the INSERT, `ROLLBACK TO` on conflict | Works, and keeps everything in one transaction. Costs raw savepoint SQL inside a Prisma interactive transaction for a path that is rare by construction |
| **Full rollback, then re-read on a fresh connection** | Chosen. One indexed lookup on a unique key |

I took the second. The winner cannot have vanished in between: nothing in this
service deletes expenses. If it is somehow missing, that is an explicit 500,
not a quiet success - a lost expense the caller is told about is recoverable;
one they believe was accepted is not.

**The classification is where this gets dangerous.** Prisma reports *every*
unique violation as `P2002`. If I treated any `P2002` as an idempotency
conflict, a violation on `rule_hits_expenseId_ruleCode_key` would be reported
to the caller as "this expense already exists" - they stop retrying, and an
expense that was never written is simply lost. So the classifier reads the
real SQLSTATE and the index name out of `meta.driverAdapterError.cause` and
requires `expenses_companyId_externalId_key` specifically. Anything it cannot
positively identify becomes a 500.

**Something I got wrong and found:** the first version of the negative control
said `DROP CONSTRAINT` and failed with `42704 does not exist`. Prisma's
`@@unique` emits `CREATE UNIQUE INDEX`, so the thing enforcing idempotency
lives in `pg_indexes` and is absent from `pg_constraint`. Same guarantee, same
`23505` - different DDL, different catalogue.

**Backs it up:** `resolveLostRace()`, `idempotency-conflict.ts`, tests
F03-T21, F03-T22, F03-T24.

---

## Q4 - Idempotency, conflict handling and tenant isolation

> The same `externalId` arrives with a different amount. You return 409.
> Most APIs would just take the newer value - that is what an upsert is for.
> Convince me.

**Because the first value was already answered, and that answer left the
building.**

The caller received a decision. If the expense was flagged for review, a
manager may already be looking at it. An upsert would mean:

- a decision reported as `APPROVE` silently becomes `REJECT`
- a review opened against an amount that no longer exists
- the audit trail says the expense was always 999.00, with no record it was
  ever 125.00

Idempotency is a promise that a given identity maps to one outcome. Last-write-
wins is the opposite promise.

And I cannot tell *why* the second request differs. It is a client bug, a
reused identifier, or an attempt to overwrite a decision. All three deserve
the same answer: refuse, and say so clearly. **409 is the status that
describes the situation** - the request is well formed, so it is not a 400; it
conflicts with the current state of the resource. To correct an expense, the
caller submits a new `externalId`.

**On tenant isolation**, the key point is that it is in the *identity*:
`UNIQUE (companyId, externalId)`, never `externalId` alone. On `externalId`
alone, company A submitting `INV-001` would block company B's `INV-001` - a
cross-tenant denial of service, and an oracle telling B which identifiers A
has used. Sequential identifiers are extremely common in the systems that will
call this.

The tenant itself comes from the authenticated API key and from nowhere else.
`.strict()` on the DTO means a body carrying `companyId` is **rejected**, not
ignored - ignoring it leaves the caller believing it was honoured (F03-T12).

**What I was careful not to leak in the 409:** the stored `payloadHash`.
Publishing it would let a caller brute-force the payload of an expense they
cannot otherwise read, one guess at a time. The conflict body carries the
field name, the existing id, decision and status - and a test asserts no
64-character hex string appears anywhere in it.

**Backs it up:** ADR-001, tests F03-T14, F03-T14c, F03-T20, F03-T20b, F03-T12.

---

## Q5 - Transaction boundaries and integration with the policy engine

> The policy engine is not built. So either your endpoint returns a fake
> decision, or it does not work. Which did you ship, and why is that
> defensible?

**Neither. The endpoint is not registered in the deployed application at all.**

`ExpensesModule` has no plain `@Module` to import. The only way in is:

```ts
ExpensesModule.withEvaluator({ useClass: PolicyEngineEvaluator })
```

so wiring it requires naming an evaluator. In F03 the sole caller is the test
factory. `POST /v1/expenses` returns 404 in the running service.

**Why not a stub returning APPROVE.** That endpoint is not incomplete, it is
**wrong** - and wrong in the direction that approves spending the policy says
to review. It would also be unstorable: F01 added

```sql
CHECK ((decision = 'APPROVE' AND status = 'APPROVED') OR ...)
```

so there is no placeholder decision the database would accept. The shortcut
was closed before it could be proposed.

**What that cost.** The manual test cycle cannot run against the public API
yet, and I have written it out in full with every command labelled
**RUNS TODAY** or **NEEDS F04**, each pointing at the automated test that
covers it now. Deferred verification is marked `DEFERRED` in the matrix, never
`PASS`.

**Where the boundary actually sits** is the more interesting half. The
evaluator is called **inside** the transaction, after the advisory lock, and
receives the transaction client as an explicit parameter. All three matter:

- **Inside the transaction**, because the decision and the row it is attached
  to have to commit together. Evaluating outside would leave a window where an
  expense exists with no decision - which the CHECK constraint would reject
  anyway.
- **After the lock**, because F04's frequency rule is a read-then-write that
  no constraint can protect. Under `READ COMMITTED` each statement takes a
  fresh snapshot, so the lock has to be the *first* statement for the count
  that follows to see every competitor that already committed.
- **`tx` as a parameter**, because a count issued on the global client would
  not be protected by the lock and would see a different snapshot. Making the
  correct client the one already in hand removes the opportunity to use the
  wrong one.

**So why take a lock F03 does not need?** Idempotency is a uniqueness
invariant the database enforces alone - F03-T28 proves that by racing two
requests on *different* lock keys and showing they still cannot duplicate.
The lock is for F04. Adding it later would mean reordering the transaction
underneath tests that had already passed, which is how a correct design
becomes a subtly wrong one.

**What F04 changes:** one line in `app.module.ts` and one interface
implementation. No migration, no backfill, and no row has ever carried a
decision that was not genuinely evaluated.

**Backs it up:** `policy-evaluator.port.ts`, `expenses.module.ts`, ADR-007,
`docs/architecture/expense-submission.md` diagram 7.
