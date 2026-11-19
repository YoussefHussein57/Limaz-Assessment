# Architecture overview

## The problem in one paragraph

One deployment serves many companies. Each company's backend submits expenses
over an API and gets back a decision with every reason behind it. Managers
resolve `REVIEW` cases in a dashboard; a platform admin manages companies and
API keys. Clients retry, and managers act simultaneously, so the service must
stay correct under both.

## The four guarantees

Everything else is detail. These four are the product.

| # | Guarantee | Mechanism | Record |
|---|---|---|---|
| 1 | A company only ever sees its own data | `companyId` resolved from the API key or session; every query filtered; `404` not `403` | [ADR-003](../adr/ADR-003-cross-tenant-response.md) |
| 2 | A retried submission creates one expense and counts once | `UNIQUE (company_id, external_id)` plus conflict handling | [ADR-001](../adr/ADR-001-idempotency-conflicting-payload.md) |
| 3 | Exactly one manager wins a concurrent resolve | Single conditional `UPDATE`, one transaction | [ADR-004](../adr/ADR-004-review-resolution.md) |
| 4 | The strongest decision wins, with every reason reported | Pure evaluation function, `REJECT > REVIEW > APPROVE` | [ADR-002](../adr/ADR-002-frequency-window.md), [ADR-007](../adr/ADR-007-frequency-concurrency.md) |

Guarantees 2 and 4 are routinely conflated and have **different** mechanisms.
The unique constraint that gives idempotency does nothing for correct frequency
counting under concurrency - that needs serialisation. See
[ADR-007](../adr/ADR-007-frequency-concurrency.md).

## Runtime topology

```
                    browser
                       │
                       ▼
            ┌──────────────────────┐
            │  web  :3000          │   Next.js App Router
            │  app/api/[...path]   │   runtime same-origin proxy
            └──────────┬───────────┘
                       │  docker network
company backend        ▼
  (API key)  ──▶ ┌──────────────────────┐
                 │  api  :3001          │   NestJS modular monolith
                 └──────────┬───────────┘
                            ▼
                 ┌──────────────────────┐
                 │  postgres :5432      │
                 └──────────────────────┘
```

The browser addresses **one origin**. That is what keeps the session cookie
first-party, keeps `SameSite=Lax` effective as CSRF protection, and removes CORS
from the system entirely ([ADR-008](../adr/ADR-008-browser-session.md)).

Company backends reach the API directly. They authenticate with an API key
rather than a cookie, so the browser's same-origin rules do not apply to them.

## Backend layering

```
Controller    transport only - status codes, DTO binding
    │
Service       business use case, transaction boundaries
    │
Prisma        data access, explicit pg pool
```

The policy engine sits outside this stack as a **pure function**:

```
evaluatePolicy(expense, policySettings, frequencyCount) -> { decision, reasons[] }
```

No database access, no clock, no I/O. It is therefore deterministic and
unit-testable without any infrastructure, and the concurrency concerns stay
where they belong - in the service that calls it.

## Planned modules

| Module | Responsibility | Feature |
|---|---|---|
| `config` | Validated environment, the only reader of `process.env` | F00 |
| `prisma` | One client, one explicit pool | F00 |
| `health` | Liveness and real database round trip | F00 |
| `auth` | API key verification, sessions, guards, tenant resolution | F02 |
| `companies` | Company records and policy settings | F01, F08 |
| `api-keys` | Issue, rotate, revoke | F08 |
| `users` | Managers and the platform admin | F01, F02 |
| `expenses` | Submission, idempotency, policy evaluation | F03, F04 |
| `reviews` | Lifecycle and resolution | F05 |

## Expense submission lifecycle

```
company backend
      │  POST /v1/expenses + x-api-key
      ▼
Auth guard            resolves companyId from the key hash; 401 if unknown
      │
      ▼
Validation            whitelisted DTO; a body-supplied companyId is stripped
      │               bad input is 400, never 500
      ▼
BEGIN (READ COMMITTED)
  advisory lock on (companyId, employeeId)
  idempotency check  -> 200 same decision, or 409 on a payload mismatch
  load policy
  COUNT(*) in window
  evaluatePolicy()   pure
  INSERT expense + rule hits [+ review]
COMMIT                lock released here
      │
      ▼
decision + every reason that fired
```

The lock is acquired **first**, before any read. Under `READ COMMITTED` each
statement takes a fresh snapshot, so the `COUNT` that follows sees every
competitor that has already committed. Under `REPEATABLE READ` it would not, and
the design would silently produce wrong counts - see
[ADR-007](../adr/ADR-007-frequency-concurrency.md).

## Data model

Planned for F01. Constraints that carry a guarantee are called out.

| Entity | Notes |
|---|---|
| `Company` | Has one `Policy`; owns users, API keys and expenses. Carries `currency` (A3) |
| `Policy` | `autoApproveLimitMinor`, `frequencyMaxCount`, `frequencyWindowMinutes`, `blockedCategories` |
| `User` | `role` of manager or platform admin. `companyId` is null for the admin |
| `ApiKey` | `keyHash` **UNIQUE**, `prefix`, `status`, `expiresAt`, `revokedAt` |
| `Expense` | **`UNIQUE (companyId, externalId)`**, `payloadHash`, `amountMinor`, `spentAt`, `receivedAt`, `decision`, `status`, `policySnapshot` |
| `RuleHit` | Every rule that fired, with its detail |
| `Review` | **`UNIQUE (expenseId)`**, `companyId` denormalised (A9), `state`, `outcome`, `resolvedByUserId`, `resolvedAt` |
| `Session` | `tokenHash` **UNIQUE**, `expiresAt`, `revokedAt` |

| Index or constraint | Protects |
|---|---|
| `UNIQUE (companyId, externalId)` on `Expense` | Guarantee 2 |
| `INDEX (companyId, employeeId, spentAt)` on `Expense` | Frequency query stays an index range scan |
| `UNIQUE (expenseId)` on `Review` | One review per expense |
| `UNIQUE (keyHash)` on `ApiKey` | O(log n) auth lookup |
| `companyId` on `Review` | Lets the tenant guard sit in the same `WHERE` as the concurrency guard |

## Configuration

One file validates everything, with Zod, at boot. The process **refuses to
start** if anything is missing or malformed, naming the variables without
printing their values. Nothing else in the codebase reads `process.env`.

| Variable | Purpose |
|---|---|
| `NODE_ENV` | Runtime mode |
| `API_PORT` | API listen port |
| `DATABASE_URL` | PostgreSQL connection string |
| `DB_POOL_MAX` | pg pool size. Must exceed concurrency-test concurrency, or those tests serialise inside the pool and prove nothing (risk R-10) |
| `INTERNAL_API_URL` | Web-server-only address of the API. No `NEXT_PUBLIC_` prefix, so it never reaches a browser bundle |

## Where to read next

- [`docs/adr/`](../adr/) - the ten decisions, with alternatives and test strategy
- [`docs/risks.md`](../risks.md) - risk register, with evidence per entry
- [`docs/features/`](../features/) - one document per feature
- [`docs/testing/`](../testing/) - test matrices with actual results
