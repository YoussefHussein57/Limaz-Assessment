# F01 test matrix

**Executed:** 2026-11-20
**Commands:** `npm test --workspace @limaz/api` and `bash scripts/verify-f01.sh`
**Environment:** Windows 11, Docker 29.5.3, Node 22.20.0, PostgreSQL 17-alpine

**Result: 53 of 53 automated tests PASS, 11 of 11 acceptance checks PASS.**

Every integration test runs against a real PostgreSQL. Nothing is mocked.

```
Test Suites: 6 passed, 6 total
Tests:       53 passed, 53 total
```

## Test isolation

The F01 suites run against a throwaway database named `limaz_test`, dropped
and recreated by `test/global-setup.ts` on every run, with the migrations
applied through the real `prisma migrate deploy`.

They never touch the development database. These tests assert exact row counts
and deliberately insert rows that violate constraints; doing that to the
database a reviewer is looking at would be destructive and would make the
counts depend on whatever happened to be there.

## Matrix

| ID | Scenario | Preconditions | Steps | Expected | Verification | Type | Result |
|---|---|---|---|---|---|---|---|
| F01-T01 | Migrations apply to a clean database | `limaz_test` just created | `prisma migrate deploy` | Applied, every row in `_prisma_migrations` has `finished_at` | Query `_prisma_migrations` | Integration | **PASS** |
| F01-T02 | Every table exists | T01 | Query `information_schema.tables` | 8 tables present | Catalogue query | Integration | **PASS** |
| F01-T02b | Every enum exists with the right values, in order | T01 | Query `pg_enum` | 7 enums, exact labels | Catalogue query | Integration | **PASS** |
| F01-T03 | The frequency index has its columns in the required order | T01 | Query `pg_indexes` | `("companyId", "employeeId", "spentAt")` | `indexdef` match | Integration | **PASS** |
| F01-T03b | Dashboard, review and credential indexes exist | T01 | Query `pg_indexes` | 8 named indexes present | Catalogue query | Integration | **PASS** |
| F01-T03c | All five hand-written CHECK constraints are present | T01 | Query `pg_constraint` | 5 named checks | Catalogue query | Integration | **PASS** |
| F01-T03d | The composite foreign key exists and restricts deletes | T01 | `pg_get_constraintdef` | `FOREIGN KEY ("expenseId", "companyId") REFERENCES expenses(id, "companyId") ... ON DELETE RESTRICT` | Definition match | Integration | **PASS** |
| F01-T03e | Cascade and restrict are assigned per the design | T01 | Query all foreign keys | Expenses, users and reviewers RESTRICT; policies, keys, sessions, rule hits CASCADE | Definition match | Integration | **PASS** |
| F01-T04 | Duplicate `externalId` within one company is rejected | Company exists | Insert the same `externalId` twice | `23505` on `expenses_companyId_externalId_key` | SQLSTATE **and constraint name** | Integration | **PASS** |
| F01-T05 | The same `externalId` in two companies is allowed | Two companies | Insert the same `externalId` under each | Both succeed; two rows | Row count | Integration | **PASS** |
| F01-T06 | An expense cannot have two reviews | Expense exists | Insert a second review | `23505` on `reviews_expenseId_key` | SQLSTATE and constraint | Integration | **PASS** |
| F01-T07 | Duplicate API key hashes are rejected | - | Insert the same hash for a different company | `23505` | SQLSTATE | Integration | **PASS** |
| F01-T07b | Duplicate session token hashes are rejected | User exists | Insert the same token hash twice | `23505` | SQLSTATE | Integration | **PASS** |
| F01-T08 | An expense for a non-existent company is rejected | - | Insert with a random `companyId` | `23503` | SQLSTATE | Integration | **PASS** |
| F01-T08b | A company with expenses cannot be deleted | Company has an expense | Delete the company | `23503` | SQLSTATE | Integration | **PASS** |
| **F01-T09** | **A review claiming the wrong tenant is rejected** | Expense owned by company A | Insert a review for it with `companyId` = B | `23503` on `reviews_expenseId_companyId_fkey` | SQLSTATE **and constraint name** | Integration | **PASS** |
| F01-T09b | A review cannot be moved to another tenant | Review exists | Update its `companyId` | `23503` on the same constraint | SQLSTATE and constraint | Integration | **PASS** |
| F01-T10 | A MANAGER without a company is rejected | - | Insert `role=MANAGER, companyId=null` | `23514` on `users_role_company_check` | SQLSTATE and constraint | Integration | **PASS** |
| F01-T10b | A PLATFORM_ADMIN with a company is rejected | - | Insert `role=PLATFORM_ADMIN` with a company | `23514` | SQLSTATE | Integration | **PASS** |
| F01-T11 | An APPROVE decision cannot be REJECTED | - | Insert that pair | `23514` on `expenses_decision_status_check` | SQLSTATE and constraint | Integration | **PASS** |
| F01-T11b | A REVIEW decision may end APPROVED or REJECTED | - | Insert both | Both accepted; `decision` unchanged | Field values | Integration | **PASS** |
| F01-T12 | A RESOLVED review without a reviewer is rejected | Expense exists | Insert with no `resolvedByUserId` | `23514` on `reviews_state_resolution_check` | SQLSTATE and constraint | Integration | **PASS** |
| F01-T12b | An OPEN review carrying an outcome is rejected | Expense exists | Insert `state=OPEN, outcome=APPROVED` | `23514` | SQLSTATE | Integration | **PASS** |
| F01-T12c | A fully resolved review records who, when and how | Expense exists | Insert all three fields | Accepted, values stored | Field values | Integration | **PASS** |
| F01-T12d | A user who resolved a review cannot be deleted | Resolved review exists | Delete the user | `23503` | SQLSTATE | Integration | **PASS** |
| F01-T13 | Exactly two companies, with different policies | Seed ran | Query companies and policies | Two companies; limits, counts, windows and blocked lists all differ | Field comparison | Integration | **PASS** |
| F01-T14 | One manager per company, one platform admin | Seed ran | Query users | 3 users; admin has null `companyId` | Field values | Integration | **PASS** |
| F01-T14b | Passwords stored as bcrypt hashes | Seed ran | Inspect `passwordHash` | Matches `$2[aby]$NN$`; never equals the plaintext | Pattern and inequality | Integration | **PASS** |
| F01-T14c | API keys stored as SHA-256 hashes | Seed ran | Inspect `keyHash` and `prefix` | Hash equals `sha256(plaintext)`; prefix is a strict prefix | Recomputation | Integration | **PASS** |
| F01-T15 | Seeding twice does not duplicate anything | Seed ran | Run the seed again | Every count identical | Count comparison | Integration | **PASS** |
| F01-T15b | Re-seeding preserves row identities | Seed ran | Run again, compare ids | Identical id set | Id comparison | Integration | **PASS** |
| F01-T16 | A review exists for exactly the REVIEW decisions | Seed ran | Query expenses with reviews | REVIEW has one; others have none | Per-row assertion | Integration | **PASS** |
| F01-T16b | Review state matches expense status | Seed ran | Join reviews to expenses | OPEN implies PENDING_REVIEW; RESOLVED implies status equals outcome | Per-row assertion | Integration | **PASS** |
| F01-T16c | The dashboard has open and resolved work | Seed ran | Count by state and outcome | Both states present; both outcomes present | Counts | Integration | **PASS** |
| F01-T16d | All three decisions present, including a multi-rule rejection | Seed ran | Group by decision; find REJECT with a REVIEW rule hit | All three; at least one expense with 2 rule hits | Grouping | Integration | **PASS** |
| F01-T16e | The seed itself shows tenant-scoped uniqueness | Seed ran | Query `externalId = exp-1001` | Two rows, two companies | Row count | Integration | **PASS** |
| F01-T16f | Every expense carries its policy snapshot | Seed ran | Inspect `policySnapshot` | Present, typed, and different between the two companies | Field inspection | Integration | **PASS** |
| F01-T17 | A negative amount is rejected | - | Insert `amountMinor = -1` | `23514` on `expenses_amount_non_negative_check` | SQLSTATE and constraint | Integration | **PASS** |
| F01-T17b | A rule fires at most once per expense | Expense exists | Insert the same `ruleCode` twice | `23505` | SQLSTATE | Integration | **PASS** |
| F01-T17c | Nonsensical policy settings are rejected | - | `frequencyMaxCount = 0` | `23514` | SQLSTATE | Integration | **PASS** |
| F01-T18 | One cold start migrates and seeds | Empty volume | `docker compose down -v && up -d --build` | All three services healthy | `docker inspect` health | Acceptance | **PASS** |
| F01-T18b | The entrypoint applied the migrations | T18 | Read the api logs | "migrations applied" | Log search | Acceptance | **PASS** |
| F01-T18c | The entrypoint ran the seed | T18 | Read the api logs | "seed complete" | Log search | Acceptance | **PASS** |
| F01-T18d | Startup prints the development credentials | T18 | Read the api logs | Manager emails present | Log search | Acceptance | **PASS** |
| F01-T18e | Exactly two companies seeded | T18 | `SELECT count(*) FROM companies` | 2 | psql | Acceptance | **PASS** |
| F01-T18f | The two policies differ | T18 | `count(DISTINCT autoApproveLimitMinor)` | 2 | psql | Acceptance | **PASS** |
| F01-T18g | The dashboard has data | T18 | Count expenses and reviews by state | 12 expenses, 1 open, 2 resolved | psql | Acceptance | **PASS** |
| F01-T18h | The same `externalId` exists in both companies | T18 | Count rows with `exp-1001` | 2 | psql | Acceptance | **PASS** |
| F01-T18i | No plaintext API key is stored | T18 | Search `keyHash` for `lmz_%` | 0 | psql | Acceptance | **PASS** |
| F01-T19 | Restarting does not duplicate seeded data | T18 | `docker compose restart api`, recount | Counts unchanged (12, 3, 3) | psql before and after | Acceptance | **PASS** |

## Negative control: is F01-T09 actually testing anything?

A test that passes with and without the mechanism it claims to verify is not a
test. The composite foreign key was dropped from the test database and the
cross-tenant insert retried:

```
ALTER TABLE reviews DROP CONSTRAINT "reviews_expenseId_companyId_fkey";

RESULT: cross-tenant review ACCEPTED  ->  review.companyId = 5851387a-...
        expense.companyId             = 7d2a27c1-...
```

The write succeeded, and the review now claims a tenant its expense does not
belong to. The tenant guard in ADR-004 reads `reviews.companyId`, so it would
have approved company B resolving company A's expense.

With the constraint restored, the same write is rejected with `23503` on
`reviews_expenseId_companyId_fkey`. F01-T09 is testing the constraint, not a
coincidence.

## Defects found and fixed during F01

### D-5 - Test suites corrupted each other's data

The first full run failed with `companies: expected 2, received 4`. Jest runs
test files in parallel workers by default; the constraint suite and the seed
suite were creating and counting rows in the same database at the same time.

**Fixed by:** `maxWorkers: 1`, with the reason recorded in `jest.config.js`.
This does **not** limit concurrency *inside* a test - the `Promise.all` races
in F03 and F04 are bounded by the connection pool, not by worker count.

### D-6 - Prisma hides the PostgreSQL error code

The constraint tests could not read a SQLSTATE from the rejections. Prisma
translates driver errors into its own codes: `P2002` for unique, `P2003` for
foreign key, and `P2039` for everything else **including CHECK violations** -
too coarse to tell a CHECK violation from an unrelated database error.

**Found by:** the assertion helper failing with "no PostgreSQL error code could
be read from it", then probing a real rejection to see its actual shape.

**Fixed by:** reading `meta.driverAdapterError.cause.originalCode`, which the
driver adapter preserves. The same object also carries the constraint name, so
every constraint test now asserts **which** constraint rejected the write
rather than only that something did.

### D-7 - `prisma.config.ts` was missing from the runtime image

The Dockerfile copied `apps/api/prisma/` and `apps/api/dist/` but not
`prisma.config.ts`. In Prisma 7 that file is where the CLI reads the
connection string, so `prisma migrate deploy` in the container entrypoint
would have failed on every start.

**Found by:** reviewing the Dockerfile against the new entrypoint behaviour
before rebuilding, then confirmed by F01-T18b.

### D-8 - `array_agg` of a `name` column is not deserialisable

`F01-T02b` read enum labels with `array_agg(e.enumlabel)`. `enumlabel` is of
PostgreSQL type `name`, and Prisma's raw-query deserialiser rejects arrays of
unknown types.

**Fixed by:** `string_agg(e.enumlabel::text, ',' ORDER BY e.enumsortorder)`.

## Not covered by F01

| Area | Lands in |
|---|---|
| Tenant isolation at the API boundary | F02 |
| Idempotency behaviour, including concurrent duplicates | F03 |
| Policy evaluation and decision precedence | F04 |
| Concurrent review resolution | F05 |
| Frequency evaluation under concurrency, with its negative control | F04 |
| That the real policy engine agrees with the seeded fixtures | F04 |
