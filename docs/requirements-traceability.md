# Requirements traceability

Every requirement in the assessment, mapped to where it is implemented and to
the evidence that it works. A requirement with no test reference is not done,
however much code exists for it.

**Status:** `DONE` - implemented and covered by executed tests ·
`PARTIAL` - foundations in place, behaviour lands later ·
`PENDING` - not started · `OPTIONAL` - bonus, deliberately deferred

---

## Section 2 - Companies, users and access

| Requirement | Feature | Implementation | Evidence | Status |
|---|---|---|---|---|
| Seed two companies | F01 | `prisma/seed/fixtures.ts` | F01-T13, F01-T18e | **DONE** |
| Company backends call with an API key | F02 | `api-key.service.ts`, `x-api-key` | F02-T01, F02-T01-live | **DONE** |
| A manager per company logs in | F02 | `auth.controller.ts` login | F02-T07 | **DONE** |
| A platform admin logs in | F02 | same | F02-T09 | **DONE** |
| The company always comes from the key or the user, never the request | F02 | `principal.types.ts`, `tenantScope()`, `.strict()` DTO | **F02-T15, T15b, T27b** | **DONE** |
| Unauthenticated callers refused | F02 | global `AuthenticationGuard` | F02-T02, T02b, T03 | **DONE** |
| Managers cannot use admin features | F02 | `AuthorizationGuard`, `@Roles` | F02-T12, T12b | **DONE** |
| A company can never see another's data, even knowing the id | F02 | `tenantScope()` + 404 | **F02-T13, T14, T29** | **PARTIAL** - proven through a test-only controller; re-proven on real endpoints in F03, F05, F08 |

## Section 3 - Submitting an expense

| Requirement | Feature | Implementation | Evidence | Status |
|---|---|---|---|---|
| Submit an expense, receive a decision and every reason | F03 | - | - | **PENDING** |
| Bad input rejected cleanly, never a server error | F02 (shape), F03 | `.strict()` DTO, `HttpExceptionFilter` | F02-T27, T27b | **PARTIAL** |
| `externalId` unique per company | F01 | `UNIQUE (companyId, externalId)` | F01-T04, F01-T05 | **PARTIAL** - constraint done, behaviour in F03 |
| A retry creates no second expense and does not count twice | F03 | - | - | **PENDING** |
| Correct when both requests arrive together | F03 | - | - | **PENDING** |

## Section 4 - Policy rules

| Requirement | Feature | Implementation | Evidence | Status |
|---|---|---|---|---|
| Per-company policy settings in the database | F01 | `Policy` model | F01-T13 | **DONE** |
| The two companies seeded with different values | F01 | fixtures | F01-T13, F01-T18f | **DONE** |
| Amount limit rule | F04 | - | - | **PENDING** |
| Frequency rule | F04 | - | - | **PENDING** |
| Blocked category rule | F04 | - | - | **PENDING** |
| Strongest decision wins | F04 | - | - | **PENDING** |
| The response lists every rule that fired | F04 | `RuleHit` model exists | F01-T16d | **PARTIAL** |

## Section 5 - Reviews

| Requirement | Feature | Implementation | Evidence | Status |
|---|---|---|---|---|
| A REVIEW decision opens a review | F05 | `Review` model, `UNIQUE (expenseId)` | F01-T06, T16 | **PARTIAL** |
| A manager approves or rejects, setting the final status | F05 | `decision` and `status` are separate | F01-T11b | **PARTIAL** |
| Exactly one of two simultaneous resolves wins | F05 | - | - | **PENDING** |
| The reviewer is the logged-in manager, never a caller value | F02 + F05 | principal from session only | F02-T15 | **PARTIAL** |
| A record of who resolved each review, when and how | F01 | `reviews_state_resolution_check` makes it unstorable otherwise | F01-T12, T12c | **DONE** |

## Section 6 - The UI

| Requirement | Feature | Status |
|---|---|---|
| Manager dashboard: expenses, decisions, open reviews, policy editing | F06, F07 | **PENDING** |
| Admin panel: companies, creation, API keys | F08 | **PENDING** |
| Every rule holds when the API is called directly | F02 | **DONE** - all F02 tests call the API, never a UI |

## Section 7 - Tests

| Requirement | Evidence | Status |
|---|---|---|
| Tenant isolation | F02-T13, T14, T15, **T29** | **PARTIAL** - re-proven on real endpoints in F03, F05, F08 |
| Idempotency, including two simultaneous requests | F03 | **PENDING** |
| Concurrent resolve | F05 | **PENDING** |
| Which decision wins | F04 | **PENDING** |

## Section 8 - The eight decisions

| # | Question | ADR | Implemented |
|---|---|---|---|
| 1 | Same `externalId`, different body | [ADR-001](adr/ADR-001-idempotency-conflicting-payload.md) | F03 |
| 2 | Frequency window: `spentAt` or receipt time | [ADR-002](adr/ADR-002-frequency-window.md) | F04 |
| 3 | Cross-tenant record by id | [ADR-003](adr/ADR-003-cross-tenant-response.md) | **F02 - done** |
| 4 | Can a review be resolved twice | [ADR-004](adr/ADR-004-review-resolution.md) | F05 |
| 5 | Money representation | [ADR-005](adr/ADR-005-money-representation.md) | **F01 - done** |
| 6 | API key storage and rotation | [ADR-006](adr/ADR-006-api-key-storage-rotation.md) | **F02 - storage and lifecycle done**, rotation endpoints F08 |
| 7 | Where the frequency count lives | [ADR-007](adr/ADR-007-frequency-concurrency.md) | F04 |
| 8 | Where the browser keeps the session | [ADR-008](adr/ADR-008-browser-session.md) | **F02 - done** |

## Section 9 - Using AI

| Requirement | Evidence | Status |
|---|---|---|
| `AI_LOG.md` with tools, prompts and a real mistake caught | [AI_LOG.md](../AI_LOG.md) - ten recorded | **DONE** |
| Commit as you go | 3 commits, one per feature so far | **DONE** |

## Section 10 - Card webhook

**OPTIONAL.** Deliberately untouched until F00-F10 are complete and approved.

## Section 11 - Submission

| Requirement | Evidence | Status |
|---|---|---|
| Private GitHub repo | `YoussefHussein57/Limaz-Assessment` | **DONE** |
| `tarek-ragab-abdelal` invited as collaborator | Confirmed by the project owner | **DONE** |
| One `docker compose up` starts everything | F00-T01, F01-T18, F02-T20a | **DONE** |
| A seed script fills both companies, users, keys, policies and sample data | F01-T13 to T16, F01-T18e to T18i | **DONE** |
| README understandable on its own | [README.md](../README.md) | **PARTIAL** - updated per feature |
| Email the repo link by 24 Nov | - | **PENDING** - the project owner's step |

---

## Guarantees not yet verifiable

Recorded so they are not mistaken for done.

| Guarantee | Why it cannot be proven yet | Lands in |
|---|---|---|
| Tenant isolation on real business endpoints | Those endpoints do not exist; F02 proves the mechanism through a test-only controller | F03, F05, F08 |
| Idempotency under concurrent retries | Needs the submission endpoint | F03 |
| Frequency correctness under concurrency | Needs the policy engine and the advisory lock | F04 |
| Exactly-one-winner review resolution | Needs the resolve endpoint | F05 |
| That the real policy engine agrees with the seeded fixtures | The engine does not exist; the fixtures are hand-written | F04 |
| API key rotation and its grace window end to end | Only the lifecycle semantics are enforced so far | F08 |
