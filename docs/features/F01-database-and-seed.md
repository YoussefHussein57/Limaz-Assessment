# F01 - Database schema, migrations and seed

**Status:** Implemented, awaiting project-owner approval
**Date:** 2026-11-20
**Depends on:** F00
**Blocks:** F02 (authentication), F03 (expenses), F05 (reviews)

## Objective

The schema every later feature writes to, with the constraints that make the
assessment's guarantees enforceable rather than merely intended, plus seed data
that makes the system demonstrable the moment it starts.

## Scope

### In scope

- Eight Prisma models and seven enums
- One migration, including five CHECK constraints appended by hand
- The composite foreign key that binds a review to its expense's tenant
- Indexes for the frequency query, the dashboard and credential lookups
- An idempotent seed, run automatically by the container entrypoint
- 53 integration tests against a real PostgreSQL
- Documentation: ERD, ADR-011, test matrix, risk-register updates

### Out of scope, deliberately

| Excluded | Reason |
|---|---|
| Authentication, guards, sessions in use | F02 |
| Expense submission, idempotency behaviour | F03 |
| The policy engine | F04 |
| Review resolution | F05 |
| Company deactivation, API key `lastUsedAt`, reviewer notes | No requirement asks for them. Each would be a column nobody could justify (risk R-13) |
| `PolicyVersion` table | `policySnapshot` as JSON achieves the same audit goal without a model or a join |

## Files created

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | Eight models, seven enums, every index and unique constraint |
| `prisma/migrations/20261120085132_init/migration.sql` | Generated DDL, plus five hand-appended CHECK constraints |
| `prisma/seed.ts` | CLI entry: builds the client, seeds, verifies its own work, prints credentials |
| `prisma/seed/run.ts` | The seed itself, callable from tests |
| `prisma/seed/fixtures.ts` | Hand-written development data with fixed ids |
| `tsconfig.seed.json` | Compiles the seed to `dist/prisma/seed.js`, the path the F00 entrypoint already expects |
| `test/database-url.ts` | Single source of truth for which database the tests use |
| `test/global-setup.ts` | Creates `limaz_test` and applies migrations to it |
| `test/test-db.ts` | Test client, reset helper, and the rejection assertion helper |
| `test/schema.spec.ts` | F01-T01 to T03 |
| `test/constraints.spec.ts` | F01-T04 to T12, T17 |
| `test/seed.spec.ts` | F01-T13 to T16 |
| `scripts/verify-f01.sh` | F01-T18, T19 |
| `docs/adr/ADR-011-...md` | The composite foreign key decision |
| `docs/architecture/data-model.md` | ERD and full schema rationale |

## Files modified

| File | Change | Why |
|---|---|---|
| `apps/api/package.json` | `build` also compiles the seed; added `db:migrate`, `db:seed`; `typecheck` covers the seed config; added `bcryptjs`, `pg`, `@types/pg` | The seed needs compiling and the tests need to create a database |
| `apps/api/prisma.config.ts` | Added `migrations.seed` | Lets a developer's `prisma migrate reset` reseed |
| `apps/api/Dockerfile` | Also copies `prisma.config.ts` into the runtime stage | Prisma 7 reads the connection string from it, so `migrate deploy` in the entrypoint needs it (defect D-7) |
| `apps/api/jest.config.js` | `globalSetup`, `testTimeout`, `maxWorkers: 1` | Test database creation, and suite isolation (defect D-5) |
| `apps/api/test/jest.setup.ts` | Uses the shared URL resolver | One place decides which database tests talk to |

## Decisions, with the alternatives rejected

| Decision | Chosen | Rejected |
|---|---|---|
| Tenant integrity on `reviews` | Composite foreign key (ADR-011) | Application discipline; a trigger; dropping the denormalisation and reintroducing a TOCTOU gap |
| `category` type | `String`, normalised uppercase | A Prisma enum - the category vocabulary belongs to the company, and every new one would need a migration |
| `User.email` uniqueness | Global | Per company - login is email plus password with no company selector, so the email must identify one user |
| Password hashing | `bcryptjs` | Native `bcrypt`/`argon2` (needs build tools in Alpine); hand-rolled `crypto.scrypt` (writing our own credential format is a finding in any security review) |
| `policySnapshot` | `Json` column | A `PolicyVersion` table - a model and a join on every read for the same audit outcome |
| `blockedCategories` | `text[]` | A join table - short list, read whole, never queried from the other direction |
| Primary keys | `uuid(7)` | `uuid(4)` - v7 is time-ordered, so inserts land at the end of the B-tree instead of scattering |
| Test database | Separate `limaz_test`, recreated per run | Sharing the development database - destructive, and makes row counts depend on leftovers |

## How the seed works

```
docker compose up
      |
      v
apps/api/docker-entrypoint.sh      (written in F00, unchanged)
      |
      |-- prisma/migrations non-empty?  -> prisma migrate deploy
      |-- dist/prisma/seed.js exists?   -> node dist/prisma/seed.js
      v
node dist/main.js
```

Both steps were wired and verified as no-ops in F00. F01 only supplied the
files, so the `docker compose up` contract never changed.

**Idempotency** comes from fixed ids. Every write is an `upsert` keyed on a
UUID written into `fixtures.ts`, so a second run updates the same rows instead
of inserting new ones. Random ids would double the data on the second start -
and the entrypoint seeds on *every* start.

**It checks its own work.** After seeding, the script compares every table's
count against `EXPECTED` in the fixtures and throws if any differ. A silent
partial seed is worse than a loud failure: the dashboard would simply look
wrong.

**One transaction.** A partial seed could leave an expense with a `REVIEW`
decision and no review row - a state the dashboard and F01-T16 both treat as
corrupt.

### Seeded data

| | Nile Logistics | Delta Consulting |
|---|---|---|
| Auto-approve limit | 500.00 SAR | 2000.00 SAR |
| Frequency rule | more than 3 in 60 min | more than 5 in 30 min |
| Blocked categories | `GAMBLING` | `ALCOHOL`, `GAMBLING` |
| Manager | manager@nile-logistics.test | manager@delta-consulting.test |

Plus one platform admin, two API keys, 12 expenses, 7 rule hits and 3 reviews
(1 open, 1 resolved APPROVED, 1 resolved REJECTED).

The data is built to demonstrate the rules rather than just fill the screen:

- Three approvals followed by a fourth that trips the frequency rule.
- An over-limit expense reviewed and **approved**, so `decision` stays `REVIEW`
  while `status` becomes `APPROVED` - the clearest illustration of why the two
  fields are separate.
- An over-limit expense reviewed and **rejected**.
- An expense where **two rules fire** and `REJECT` beats `REVIEW`, with both
  rule hits recorded, so "every reason is reported" has something to show.
- `ALCOHOL` blocked for one company and not the other: the same expense would
  be judged differently by the two policies.
- The **same `externalId` in both companies**, which is what tenant-scoped
  uniqueness means.

### The honest limitation

Every `decision`, `status`, `ruleHits` and `policySnapshot` value in
`fixtures.ts` is **written by hand**. The policy engine does not exist yet.

This is handled rather than hidden: **F04 will add a regression test** that
feeds these same inputs through the real engine and asserts it produces
exactly the decisions recorded here. If the engine and the fixtures ever
disagree, that test fails. The limitation becomes a guarantee.

## Development credentials

Published in the repository on purpose, so a reviewer can run the stack. They
are development fixtures and are used nowhere else.

| Role | Email | Password |
|---|---|---|
| Manager, Nile Logistics | `manager@nile-logistics.test` | `NileManager!2026` |
| Manager, Delta Consulting | `manager@delta-consulting.test` | `DeltaManager!2026` |
| Platform admin | `admin@limaz.test` | `PlatformAdmin!2026` |

| Company | API key (header `x-api-key`) |
|---|---|
| Nile Logistics | `lmz_dev_nile_7Qk2PmXaR4tVbN8cLw3ZyH6dJeF5uG9s` |
| Delta Consulting | `lmz_dev_delta_3Xn9TbVcA7pKmR2wQy8ZsL4dHe6uJ5g` |

Only hashes reach the database: bcrypt for passwords, SHA-256 for API keys.
F01-T14b and F01-T14c assert that, and F01-T18i asserts no plaintext key is
stored.

## Manual verification

```bash
docker compose down -v && docker compose up
```

Watch the API logs: migrations applied, seed complete, credentials printed.

```bash
# Two companies, different policies
docker exec limaz-expense-policy-db-1 psql -U limaz -d limaz -c \
  'SELECT c.name, p."autoApproveLimitMinor", p."frequencyMaxCount", p."blockedCategories" FROM policies p JOIN companies c ON c.id = p."companyId"'

# The same externalId in both companies
docker exec limaz-expense-policy-db-1 psql -U limaz -d limaz -c \
  'SELECT c.name, e."externalId" FROM expenses e JOIN companies c ON c.id = e."companyId" WHERE e."externalId" = $$exp-1001$$'

# No plaintext API keys
docker exec limaz-expense-policy-db-1 psql -U limaz -d limaz -c \
  'SELECT prefix, left("keyHash", 16) AS hash_start FROM api_keys'

# Restart and confirm nothing duplicated
docker compose restart api
docker exec limaz-expense-policy-db-1 psql -U limaz -d limaz -c \
  'SELECT count(*) FROM expenses'
```

## Test results

53 of 53 automated tests pass; 11 of 11 acceptance checks pass. Full detail,
including the negative control for the composite foreign key and the four
defects found and fixed, is in
[`docs/testing/F01-test-matrix.md`](../testing/F01-test-matrix.md).

## What breaks if a key piece changes

See the table at the end of
[`docs/architecture/data-model.md`](../architecture/data-model.md).

## Limitations

- Seeded decisions are hand-written fixtures until F04 ties them to the real
  engine.
- `category` is a free string. A typo (`TRANSPORTATION` instead of `TRANSPORT`)
  silently fails to match a blocked list. Normalisation reduces this; it does
  not eliminate it. Recorded as risk R-17.
- `updatedAt` is maintained by Prisma, not by a database trigger, so a raw SQL
  write would not refresh it.
- `Int` caps a single expense at about 21.4 million SAR (ADR-005).

## Next feature

**F02 - Authentication and tenant isolation.** It uses `api_keys`, `sessions`
and `users`, and is where the `404`-not-`403` rule from ADR-003 and the cookie
design from ADR-008 are actually built and tested.
