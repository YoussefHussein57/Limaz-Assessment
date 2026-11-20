# LIMAZ Expense Policy Service

A multi-tenant expense policy service. Company backends submit expenses over an
API and receive `APPROVE`, `REVIEW` or `REJECT` with every reason behind the
decision. Managers work through `REVIEW` cases in a company dashboard, and a
platform admin manages companies and API keys in an admin panel.

Many companies share one deployment, so the central guarantee is that **a
company can only ever see its own data** - including when it supplies a valid
identifier belonging to another company.

---

## Current state

> **F00, F01 and F02 are complete.** One
> `docker compose up` starts the stack, applies migrations and seeds two
> companies. Both caller types authenticate: company backends with an API key,
> managers and the platform admin with a database-backed session. Tenant
> isolation is enforced and tested. **No business endpoints exist yet** -
> expense submission, policy evaluation and reviews are F03 to F05.
>
> This is an incremental build. Each feature is implemented, tested and
> reviewed before the next one begins. The table below is the honest status.

| Feature | Scope | Status |
|---|---|---|
| **F00** | Monorepo, Docker, health check, config validation, tooling | **Done** - 17/17 acceptance checks |
| **F01** | Database schema, migrations, seed data | **Done** - 11/11 acceptance checks |
| **F02** | API key auth, manager and admin sessions, tenant isolation | **Done** - 16/16 acceptance checks, 62 new tests |
| F03 | Expense submission and idempotency | Not started |
| F04 | Policy rules, decision precedence, frequency concurrency | Not started |
| F05 | Review lifecycle and concurrent resolution | Not started |
| F06 | Manager dashboard | Not started |
| F07 | Review and policy UI | Not started |
| F08 | Platform admin panel | Not started |
| F09 | Cross-feature regression and security testing | Not started |
| F10 | Final documentation and submission readiness | Not started |

The architectural decisions for F03 to F05 are already made and recorded in
[`docs/adr/`](docs/adr/). They are decided, not implemented.

---

## Running it

### Requirements

- Docker and Docker Compose
- Node.js **>= 22.12** (only if you want to run tests or lint outside Docker)

### One command

```bash
cp .env.example .env
docker compose up
```

That starts everything:

| Service | URL | Notes |
|---|---|---|
| Web | http://localhost:3000 | The only origin a browser uses |
| API | http://localhost:3001 | For company backends calling directly |
| PostgreSQL | `localhost:5433` | 5433, not 5432, so it cannot collide with a local install |

Check it is alive:

```bash
curl http://localhost:3001/health
```

```json
{
  "status": "ok",
  "uptimeSeconds": 12,
  "checks": { "database": { "status": "up", "latencyMs": 2.57 } }
}
```

A `503` with `"status": "degraded"` means the API is running but PostgreSQL is
not answering.

### Development credentials

The seed prints these at startup. They are published here on purpose so a
reviewer can run the stack, and they are used nowhere else. Only hashes reach
the database - bcrypt for passwords, SHA-256 for API keys.

| Role | Email | Password |
|---|---|---|
| Manager, Nile Logistics | `manager@nile-logistics.test` | `NileManager!2026` |
| Manager, Delta Consulting | `manager@delta-consulting.test` | `DeltaManager!2026` |
| Platform admin | `admin@limaz.test` | `PlatformAdmin!2026` |

| Company | API key, sent as `x-api-key` |
|---|---|
| Nile Logistics | `lmz_dev_nile_7Qk2PmXaR4tVbN8cLw3ZyH6dJeF5uG9s` |
| Delta Consulting | `lmz_dev_delta_3Xn9TbVcA7pKmR2wQy8ZsL4dHe6uJ5g` |

Try them:

```bash
curl -i -X POST http://localhost:3000/api/v1/auth/login   -H 'content-type: application/json' -H 'x-limaz-client: 1'   -d '{"email":"manager@nile-logistics.test","password":"NileManager!2026"}'
```

```bash
curl -s http://localhost:3001/v1/auth/me -H 'x-api-key: lmz_dev_nile_7Qk2PmXaR4tVbN8cLw3ZyH6dJeF5uG9s'
```

The `x-limaz-client` header is required on every state-changing browser
request; API key callers are exempt. See "Choices worth knowing about" below.

### Seeded data

| | Nile Logistics | Delta Consulting |
|---|---|---|
| Auto-approve limit | 500.00 SAR | 2000.00 SAR |
| Frequency rule | more than 3 in 60 min | more than 5 in 30 min |
| Blocked categories | `GAMBLING` | `ALCOHOL`, `GAMBLING` |

Plus 12 expenses covering all three decisions, 7 rule hits, and 3 reviews (one
open, one resolved as approved, one resolved as rejected). The data is built to
demonstrate the rules rather than just fill the screen - including an expense
where two rules fire and `REJECT` beats `REVIEW`, and the **same
`externalId` in both companies**, which is what tenant-scoped uniqueness
means.

### Migrations and seeding

The API container applies migrations and seeds the database on startup, inside
`apps/api/docker-entrypoint.sh`. **`docker compose up` is the only command
required.**

The seed is idempotent: every write is an upsert keyed on a fixed id, so the
container can seed on every start without the data doubling. Verified by
F01-T15 and F01-T19.

### Stopping

```bash
docker compose down      # keep the data
docker compose down -v   # discard the volume too
```

---

## Testing

```bash
docker compose up -d db
npm ci
npm test --workspace @limaz/api
```

```
Test Suites: 10 passed, 10 total
Tests:       112 passed, 112 total
```

Integration tests run against a throwaway database named `limaz_test`, dropped
and recreated on every run with the migrations applied through the real
`prisma migrate deploy`. They never touch the development database.

`DATABASE_URL` resolves from an explicit variable, then `apps/api/.env`, then
the documented local default on port 5433, so a fresh clone needs no extra
step.

Full acceptance verification, including Docker:

```bash
bash scripts/verify-f00.sh
```

```bash
bash scripts/verify-f01.sh
```

```bash
bash scripts/verify-f02.sh
```

Each prints a PASS/FAIL line per test id, matching
[`docs/testing/F00-test-matrix.md`](docs/testing/F00-test-matrix.md) and
[`docs/testing/F01-test-matrix.md`](docs/testing/F01-test-matrix.md) and
[`docs/testing/F02-test-matrix.md`](docs/testing/F02-test-matrix.md).

Static gates:

```bash
npm run verify   # lint + typecheck + build, both workspaces
```

---

## How it is put together

```
browser ──▶ web :3000 ──(server-side)──▶ api :3001 ──▶ postgres :5432
                │                           │
                └── app/api/[...path] ──────┘
                    runtime proxy
```

```
apps/
  api/          NestJS - modular monolith
    src/config/   Zod environment validation, the only reader of process.env
    src/prisma/   One PrismaClient with an explicit pg pool
    src/health/   GET /health
  web/          Next.js App Router
    app/api/      Same-origin proxy to the API
docs/
  adr/          Eleven architecture decision records
  requirements-traceability.md  Every assessment requirement, mapped to evidence
  architecture/ Overview and the data model, with the ERD
  risks.md      Risk register, with evidence per entry
  features/     One document per feature
  testing/      Test matrices with actual results
```

### Choices worth knowing about

**The browser only ever talks to one origin.** Requests to `/api/*` are proxied
server-side by Next. The session cookie is therefore first-party, `SameSite=Lax`
keeps working as CSRF protection, and there is no CORS configuration anywhere.

**Nothing reads `process.env` except one file.** `env.schema.ts` validates
configuration with Zod and the process refuses to start if anything is missing
or malformed, naming the offending variables without printing their values.

**Both caller types are separate kinds of principal.** An API key
authenticates a *company*; a session authenticates a *person*. A valid API key
can never take a manager-only or admin-only action, however genuine it is.

**There is deliberately no CORS configuration.** CORS is permission the server
*grants*, not a lock it applies - with no CORS headers the browser denies by
default, which is the strictest posture. Cross-origin requests are refused by
a server-side `Origin` check instead, so the judgement does not depend on the
browser.

**Guarantees live in the database, not in application checks.** Idempotency is a
unique constraint. Concurrent review resolution is a single conditional
`UPDATE`. Correct frequency counting under concurrency is a transaction-scoped
advisory lock. See ADR-001, ADR-004 and ADR-007.

---

## The eight decisions

Full reasoning, alternatives and test strategy are in [`docs/adr/`](docs/adr/).
Short answers:

**1. The same `externalId` arrives again with a different body.**
`409 Conflict`. A `payloadHash` over the canonicalised business fields
distinguishes a genuine retry (returns the original decision, `200`) from a
conflicting resubmission. Returning the original silently would hide a real
client bug; updating would destroy idempotency.
[ADR-001](docs/adr/ADR-001-idempotency-conflicting-payload.md)

**2. Does the frequency window use `spentAt` or receipt time, and does the
current expense count?**
`spentAt`, window `[spentAt - 60min, spentAt]`, and yes it counts - so the
fourth expense fires the rule. `spentAt` measures employee behaviour; receipt
time measures network conditions, and a stalled client queue would fire the rule
on behaviour that never happened. Decisions are never re-evaluated, so a
back-dated expense affects later evaluations but not earlier ones. The resulting
bypass is documented as accepted risk R-11.
[ADR-002](docs/adr/ADR-002-frequency-window.md)

**3. A company asks for another company's record by id.**
`404 Not Found`, never `403`. `403` confirms the record exists, which turns the
endpoint into an enumeration oracle. Enforcement is structural: every query
carries `WHERE company_id = <authenticated>`, so the row is never loaded.
[ADR-003](docs/adr/ADR-003-cross-tenant-response.md)

**4. Can a review be resolved twice, and what is the expense's final status?**
No. One conditional `UPDATE ... WHERE id = ? AND company_id = ? AND state =
'OPEN'`, with the review and the expense updated in a single transaction - so
there is no observable state where one is updated and the other is not. The
loser gets `409` naming who resolved it and when. `decision` (what the policy
said) and `status` (the final outcome) are separate fields; resolving changes
only `status`.
[ADR-004](docs/adr/ADR-004-review-resolution.md)

**5. How are money amounts represented?**
Integer minor units plus an ISO-4217 currency code: `12500` with `SAR` is
125.00 SAR. Floating point loses money. Integers keep every operation in native
integer space in both PostgreSQL and JavaScript, and make the wire format
unambiguous.
[ADR-005](docs/adr/ADR-005-money-representation.md)

**6. How are API keys stored, and what does rotating one look like?**
SHA-256 hash only, in a unique column; the plaintext is shown exactly once.
SHA-256 rather than bcrypt because the key has 256 bits of CSPRNG entropy, so
slow hashing buys nothing - and bcrypt's per-row salt makes the lookup
unindexable, turning every request into a full table scan. Rotation issues a new
key and moves the old one to a 24-hour grace window; revocation is immediate.
Expiry is enforced inside the `WHERE` clause so no code path can forget it.
[ADR-006](docs/adr/ADR-006-api-key-storage-rotation.md)

**7. Where does the frequency count live, and what happens at 1,000
expenses per second?**
A `COUNT(*)` over `(company_id, employee_id, spent_at)`, inside the insert's
transaction, serialised by `pg_advisory_xact_lock(hashtext(companyId),
hashtext(employeeId))`.

The important part is that **this is a different guarantee from idempotency**.
The unique constraint stops duplicate rows; it does nothing about two
transactions both reading `count = 3` and both deciding the rule does not fire.
The lock is per employee, so unrelated traffic never contends.

At 1,000 eps the bottleneck is transaction throughput: connection pooling, then
monthly partitioning of `expenses`, and only then moving the counter to Redis -
which trades exactness for throughput and should wait for a measured problem.
[ADR-007](docs/adr/ADR-007-frequency-concurrency.md)

**8. Where does the browser keep the login session, and why?**
A server-side session row, referenced by an opaque token in an `HttpOnly`,
`Secure`, `SameSite=Lax` cookie. Not `localStorage`, which any XSS can read.
Not a stateless JWT, because a JWT cannot be revoked and this system needs
revocation for logout, password change and admin access management. Only the
SHA-256 hash of the token is stored.
[ADR-008](docs/adr/ADR-008-browser-session.md)

---

## Deploying to a cloud

The compose file is the development and review artefact. For a real deployment:

| Concern | Approach |
|---|---|
| Database | Managed PostgreSQL (RDS, Cloud SQL, Neon) with automated backups and point-in-time recovery. Never a container |
| Connection pooling | PgBouncer in transaction mode. `pg_advisory_xact_lock` is transaction-scoped and therefore compatible; a session-scoped lock would not be |
| API and web | Both container images behind one hostname, with `/api/*` routed to the API. Same-origin in production exactly as in development, so cookie behaviour does not change between environments |
| Migrations | A pre-deploy job, not the application entrypoint, so N replicas do not race. The entrypoint approach used here is right for a single-command review environment and wrong for a multi-replica production |
| Secrets | The platform's secret manager injects `DATABASE_URL` and the session secret. No `.env` file in any image - verified by test F00-T12 |
| TLS | Terminated at the load balancer; `Secure` cookies then behave identically to development |
| Scaling | The API is stateless, so it scales horizontally. Sessions are in PostgreSQL, not in memory |
| Observability | Structured JSON logs with a correlation id, with the existing redaction interceptor applied before any log write |

## With more time

1. **The optional card webhook** (section 10 of the assessment). Per-company
   HMAC-SHA256 verification over the raw body, tenant resolution without
   trusting the payload, a unique constraint on `transactionId` for exactly-once
   expense creation, and asynchronous processing. Queue-down behaviour and
   reconciliation of undelivered events need designing, not just coding.
2. **Close risk R-11** - the back-dated frequency bypass - with the sliding
   sub-window evaluation described in ADR-002.
3. **Rate limiting on login** and a Content-Security-Policy. Login throttling
   and XSS defence are recorded as risks R-19 and R-18 rather than implied.
4. **Browser end-to-end tests.** Deliberately deferred: none of the four core
   guarantees is provable by a browser test, and the time was better spent on
   integration and concurrency tests that do prove them.
5. **Load testing** the frequency path to find where advisory-lock contention
   actually begins, rather than guessing. Only then consider the Redis counter.
6. **Rate limiting** per API key, and audit logging for admin actions.

## Assumptions

Decisions the assessment leaves open, chosen and recorded:

| # | Assumption |
|---|---|
| A1 | The rule fires when the count including the current expense exceeds the limit - the fourth expense |
| A2 | Rejected expenses still count toward frequency; the rule measures behaviour, not approvals |
| A3 | One currency per company. A mismatched currency is rejected with `422`. No FX conversion |
| A4 | `spentAt` must be within 5 minutes of the future and 90 days of the past. `receivedAt` is stored on every expense |
| A5 | Creating a company creates its policy and first API key, but not a manager |
| A6 | The schema allows several managers per company; the seed creates one |
| A7 | Editing a policy never re-evaluates existing expenses. Each expense stores the policy snapshot it was judged against |
| A8 | A review is opened only for a `REVIEW` decision |
| A9 | `companyId` is denormalised onto `REVIEW` so the tenant guard fits in the same `WHERE` clause as the concurrency guard |
| A10 | Web and API are same-origin; the browser never addresses the API directly |

## Notable toolchain decisions

Two versions are deliberately not the newest available, each for a measured
reason:

- **NestJS 11, not 12.** NestJS 12 is ESM-only, and Jest cannot load ESM-only
  packages on Node 22 - it needs Node 24.9+. The application itself runs fine;
  the test suite does not. Since this project's core deliverable is a test suite
  proving four correctness guarantees, the test runner is not the place to take
  risk. [ADR-010](docs/adr/ADR-010-nestjs-11-toolchain.md)
- **Prisma 7.10.1, not 8.0.0-rc.** Release candidates do not belong in a
  submission. Prisma 7 removed `url` from the datasource in favour of driver
  adapters, which turned out to be an advantage: the connection pool is now
  explicit, which matters for concurrency testing.
  [ADR-009](docs/adr/ADR-009-prisma-7-driver-adapter.md)

Everything else - Prisma, Next.js, React, TypeScript, Jest, ESLint, Tailwind -
is on its current release.

## AI usage

See [`AI_LOG.md`](AI_LOG.md).
