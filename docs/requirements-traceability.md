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
| A company can never see another's data, even knowing the id | F02 | `tenantScope()` + 404 | **F02-T13, T14, T29**; re-proven on every live endpoint in **F09** | **DONE** - F09 executed the whole authorization matrix against the running stack: 404 on another company's expense, review and resolve; 400 for a body-supplied `companyId`. See [endpoint-authorization.md](security/endpoint-authorization.md) |

## Section 3 - Submitting an expense

| Requirement | Feature | Implementation | Evidence | Status |
|---|---|---|---|---|
| Submit an expense, receive a decision and every reason | F03 (submission), F04 (decision) | `expenses.controller.ts`, `policy/policy-rules.ts` | F03-T01, **F04-T33 to T36, T43, T45** | **DONE** - the endpoint is live, decisions are genuine, and every triggered reason is persisted and returned |
| Bad input rejected cleanly, never a server error | F02 (shape), F03 | zod `.strict()` DTO, two-phase validation, `HttpExceptionFilter` | F03-T02 to T09b | **DONE** - 400 for shape, 422 for business rules, no 500 on any invalid input |
| `externalId` unique per company | F01 (index), F03 (behaviour) | `UNIQUE (companyId, externalId)` + conflict handling | F01-T04, F01-T05, F03-T14, F03-T20 | **DONE** |
| A retry creates no second expense and does not count twice | F03 | canonical SHA-256 hash, in-transaction lookup | F03-T13, T13b, T13c, T23, T25 | **DONE** - the evaluator is called ONCE for three identical requests |
| Correct when both requests arrive together | F03 | advisory lock + unique index + aborted-transaction recovery | F03-T17, T18, T19, T21, T27 | **DONE** - with a negative control showing the duplicate appears when the index is removed |
| Money is never floating point | F03 | integer minor units, `z.int()` | F03-T05, F03-T06, ADR-005 | **DONE** |
| The tenant is never taken from the request | F03 | `.strict()` + `tenantScope(principal)` | F03-T12, T12b, T12c | **DONE** |

## Section 4 - Policy rules

| Requirement | Feature | Implementation | Evidence | Status |
|---|---|---|---|---|
| Per-company policy settings in the database | F01, **F07** | `Policy` model; `GET`/`PATCH /v1/policy` | F01-T13, **F07-B01, B02** | **DONE** - editable by the company manager |
| The two companies seeded with different values | F01 | fixtures | F01-T13, F01-T18f | **DONE** |
| Amount limit rule | F04 | `amountLimitRule` - strictly greater than the limit | F04-T02, T03, T04 | **DONE** - the boundary is tested at 49,999 / 50,000 / 50,001 |
| Frequency rule | F04 | `frequencyRule` + the COUNT inside the locked transaction | F04-T08 to T10, T16 to T25 | **DONE** - inclusive bounds, A2 counting, out-of-order documented |
| Blocked category rule | F04 | `blockedCategoryRule`, both sides normalised by `normaliseCategory` | F04-T05, T06, T07, T07b | **DONE** |
| Strongest decision wins | F04 | `decide()` over an explicit RANK table | F04-T11 to T15 | **DONE** - order-independent across all six permutations |
| The response lists every rule that fired | F04 | no short-circuit; every rule evaluated | F04-T14, **F04-T36** | **DONE** - all three reasons persisted and returned even when REJECT wins |
| Correct under concurrent submissions | F04 | advisory lock, first statement, READ COMMITTED | **F04-T26**, **F04-NC1** | **DONE** - with a negative control showing the rule fail when the lock is removed |
| Historical decisions stay explainable | F04 | `policySnapshot` from the same policy object the evaluator used | F04-T40, T41, T42 | **DONE** |

## Section 5 - Reviews

| Requirement | Feature | Implementation | Evidence | Status |
|---|---|---|---|---|
| A REVIEW decision opens a review | F04 (creation), F05 (lifecycle) | review created in the submission transaction, A8 | F04-T34, F04-T35b | **DONE** |
| A manager lists their company reviews | F05 | `GET /v1/reviews`, keyset paging, tenant in the query | F05-T01 to T03, T08 | **DONE** |
| A manager inspects an expense and every reason | F05 | `GET /v1/reviews/:id` with snapshot and rule hits | F05-T04, T07 | **DONE** |
| A manager approves or rejects, setting the final status | F05 | conditional UPDATE + expense update in one transaction | F05-T21, T22 | **DONE** |
| Exactly one of two simultaneous resolves wins | F05 | `UPDATE ... WHERE state = 'OPEN'` + EvalPlanQual re-check | **F05-T31, T33, T34, NC1** | **DONE** - with a negative control showing the lost update when the predicate is removed |
| The reviewer is the logged-in manager, never a caller value | F02 + F05 | principal from session; `.strict()` DTO refuses any reviewer field | F05-T14, T15, T23 | **DONE** |
| A record of who resolved each review, when and how | F01 (constraint), F05 (writes it) | `reviews_state_resolution_check`; `clock_timestamp()` written once to both columns | F01-T12, F05-T23, T44 | **DONE** |
| The original automated decision survives human resolution | F05 | `decision` never written by resolution | F05-T24, T25, T29 | **DONE** |
| A manager cannot touch another company review | F02 + F05 | tenant predicate inside the query and the mutation | F05-T06, T13, T37 | **DONE** |

## Section 6 - The UI

| Requirement | Feature | Status |
|---|---|---|
| A person can sign in and out of the web application | F02.1 | **DONE** - F02.1-T01, T02, T03, T08 |
| Manager dashboard: expenses, decisions, open reviews, policy editing | F02.1 (shell), **F06**, **F07** | **DONE** - expenses and decisions (F06), the review queue and resolution (F07-F01 to F12), policy editing (F07-F16 to F23) |
| Manager sees company-wide expense totals by current status | **F06** | **DONE** - one `groupBy`, one snapshot; F06-T01, T01b, T03, T04 |
| Manager lists, searches, filters and pages their company's expenses | **F06** | **DONE** - F06-T06, T14 to T19c |
| Manager opens one expense with every reason and the historical policy | **F06** | **DONE** - F06-T11, T12, T13 |
| Original automated decision and current status shown as distinct facts | **F06** | **DONE** - F06-T13, T28; `status-badges.tsx` |
| Admin panel: companies, creation, API keys | F02.1 (shell), **F08** | **DONE** - company listing, creation, details and the full key lifecycle (F08-B01 to B42, F08-F01 to F33) |
| Responsive, usable on a small screen | F02.1, **F06** | **DONE** - re-verified in a real browser at 360, 390, 768, 1024, 1440 and 1920 on all three new pages; F06-T39 to T44 |
| Accessible: contrast, focus, keyboard, labels | F02.1, **F06**, **F09** | **PARTIAL** - 15/15 contrast pairs measured; status never carried by colour alone (F06-T47). **F09 closed the keyboard work**: keyboard-only login, dialog focus trap, Escape, focus restoration, 0 unnamed controls and 0 unlabelled inputs across every screen, and one silent error path fixed (AI_LOG 46). Still PARTIAL because **no screen-reader session was run and no conformance claim is made** |
| Seeded credentials not exposed in the production-facing interface | F02.1 | **DONE** - F02.1-creds |
| Clear loading and error states | F02.1, **F06**, **F09** | **DONE** - skeletons, both empty states, error boundaries and the 404 page (F06-T32 to T34); a real backend outage injected in the F06 closure (F06-T35) and a real **mid-mutation** network failure injected in F09, both modes, checked against the database (F09-N01 to N12) |
| Every rule holds when the API is called directly | F02, **F06** | **DONE** - every F06 backend test calls the API, never a UI |

## Section 7 - Tests

| Requirement | Evidence | Status |
|---|---|---|
| Tenant isolation | F02-T13, T14, T15, **T29**; F03-T12, T20; F05-T06, T13, T37; **F06-T05, T07, T14 and F06-NC1**; F08-B32, B38, B40; **the live F09 matrix** | **DONE** on every endpoint that exists, including the admin routes, and re-executed end to end in F09 |
| Idempotency, including two simultaneous requests | F03-T21 to T28 | **DONE** |
| Concurrent resolve | F05-T31 to T38, F05-NC1 | **DONE** |
| Which decision wins | F04-T01 to T20 | **DONE** |
| No N+1 under a list endpoint | F05 review shape, **F06-T20** | **DONE** - measured, not asserted |

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
| `AI_LOG.md` with tools, prompts and a real mistake caught | [AI_LOG.md](../AI_LOG.md) - **50 recorded**, each with how it was noticed and what prevents recurrence | **DONE** |
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
| README understandable on its own | [README.md](../README.md) | **PARTIAL** - updated per feature. F10 rewrites it for a reviewer opening the repository for the first time |
| Email the repo link by 24 Nov | - | **PENDING** - the project owner's step |

---

## Guarantees not yet verifiable

Recorded so they are not mistaken for done.

| Guarantee | Why it cannot be proven yet | Lands in |
|---|---|---|
| ~~Tenant isolation on real business endpoints~~ | **Closed** - proven on submission (F03), reviews (F05) and the three read endpoints (F06-T05, T07, T14, F06-NC1) | ~~F03, F05~~, F08 |
| ~~Idempotency under concurrent retries~~ | **Closed in F03** | - |
| ~~Frequency correctness under concurrency~~ | **Closed in F04** | - |
| ~~Exactly-one-winner review resolution~~ | **Closed in F05** | - |
| ~~That the real policy engine agrees with the seeded fixtures~~ | **Closed in F04** | - |
| ~~Resolving a review from the dashboard~~ | **Closed in F07** - verified with two independent sessions (F07-F10) | - |
| ~~Cache invalidation after a resolution~~ | **Closed in F07** - three query families plus `router.refresh()`, verified on the queue and the dashboard (F07-F11, F12) | - |
| ~~API key rotation and its grace window end to end~~ | **Closed in F08** - rotation, the 24-hour grace, expiry and revocation all verified against real PostgreSQL (F08-B27 to B37) | - |
| ~~Admin access to a named company's data~~ | **Closed in F08** - the company id is a path selector applied after the role check, never a proof (F08-B01 to B04, B32, B38) | - |

---

# Final reconciliation (F09/F10)

The original assessment PDF re-read end to end, section by section, against
what is actually in the repository. Status vocabulary as above, plus
`ACCEPTED LIMITATION` for a gap that is real, documented and deliberate.

| § | What the assessment asks for | Status | Where the evidence is |
|---|---|---|---|
| 1 | NestJS + PostgreSQL + an ORM; any modern frontend; multi-tenant; correct under retries and concurrent managers | **PASS** | NestJS 11, PostgreSQL 17, Prisma 7, Next.js 16. Concurrency proven with real PostgreSQL and four negative controls |
| 2 | Two seeded companies; API-key callers and human logins; company never from the request; unauthenticated refused; managers cannot use admin features; no cross-tenant access even with a real id | **PASS** | [endpoint-authorization.md](security/endpoint-authorization.md) - the whole matrix executed live in F09 |
| 3 | Submit an expense, get the decision and every reason; bad input never 500s; `externalId` unique per company; a retry creates no second expense and does not count twice, including simultaneous arrival | **PASS** | F03-T01 to T28; F09 end-to-end B1-B9; negative control F03-NC |
| 4 | Per-company policy in the database, two companies seeded differently; amount limit, frequency (>3 in 60 min), blocked category; strongest decision wins; every rule that fired is listed | **PASS** | F04-T01 to T45; F09 end-to-end B1-B5b, including two rules firing and REJECT winning with both reasons returned |
| 5 | A REVIEW opens a review; a manager approves or rejects, setting the final status; exactly one of two simultaneous resolves wins and the other is told clearly; reviewer is the logged-in manager; a record of who, when and how | **PASS** | F05-T01 to T44, F05-NC1; F07 two independent browser sessions; F09 M6-M10b and T22 |
| 6 | Two UI areas - manager dashboard (expenses and decisions, open reviews, policy editing) and admin panel (all companies, create, API keys); every rule holds when the API is called directly | **PASS** | F06, F07, F08; every F09 refusal measured against the API with the UI bypassed |
| 7 | Automated tests proving tenant isolation, idempotency including simultaneous requests, the concurrent resolve, and which decision wins | **PASS** | 517 automated tests; the four guarantees each have a **negative control** that fails when the mechanism is removed |
| 8 | Eight decisions, answered in the README | **PASS** | README "The eight decisions", each backed by an ADR and named tests |
| 9 | `AI_LOG.md` with tools, prompts, and at least one real AI mistake caught and fixed | **PASS** | 50 defects recorded, each with how it was noticed and what prevents recurrence |
| 10 | Card webhook intake | **NOT APPLICABLE** - marked `OPTIONAL BONUS`, and the brief says to do it "only once the core works". Deliberately not started so the core could be finished and verified |
| 11 | Private GitHub repo, `tarek-ragab-abdelal` invited, email by 24 Nov; `docker compose up` starts everything; a seed fills both companies, users, keys, policies and sample data; a README someone new can understand alone | **PASS**, except the email, which is the project owner's to send | Fresh-install verification from a clean clone in an isolated compose project; README rewritten in F10 |

## Accepted limitations, in one place

Nothing below is a mandatory requirement of the assessment. Each is linked to
its risk entry.

| | Limitation | Risk |
|---|---|---|
| 1 | A back-dated expense can evade the frequency rule (forward-only evaluation) | R-11 |
| 2 | No automated DOM/interaction test runner; frontend behaviour is browser-verified | R-23 |
| 3 | Keyset pagination has no backward cursor; "Older" walks a client-held trail | R-28 |
| 4 | Three high and nineteen moderate `npm audit` findings, all in dev tooling, measured unreachable | R-30 |
| 5 | Concurrent policy edits are last-write-wins with no conflict reported | R-31 |
| 6 | A newly created company has no manager until one is provisioned outside the app | R-32 |
| 7 | API key issuance is not idempotent; a lost response leaves a key nobody holds | R-33 |
| 8 | The `Origin` check refuses a different spelling of the same host | R-34 |
| 9 | No load testing, and no screen-reader or WCAG conformance audit | F09 §12 |
