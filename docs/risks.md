# Risk register

Reviewed at four points: initial architecture planning, before each high-risk
feature, after each completed feature, and before the final submission
rehearsal.

**A risk is not mitigated because code was written.** Each entry names the
evidence that supports its status. Where a mitigation is partial, the status is
`ACCEPTED`, not `MITIGATED`, and the residual hole is stated.

## Status vocabulary

| Status | Meaning |
|---|---|
| `OPEN` | Identified; the mitigation is not built yet |
| `IN PROGRESS` | Partially built; evidence incomplete |
| `MITIGATED` | Built **and** supported by named passing evidence |
| `ACCEPTED` | A real residual risk we are knowingly carrying, with the hole stated |

## Register

### R-01 - Cross-tenant data exposure

| | |
|---|---|
| **Component** | Every company-scoped endpoint |
| **Description** | Company A reads or writes company B's data, including when it supplies a valid id for B |
| **Likelihood** | Medium |
| **Impact** | Catastrophic - this is the central guarantee of the product |
| **Severity** | **Critical** |
| **Mitigation** | `companyId` resolved only from the API key record or the session. Every query carries `WHERE company_id = <authenticated>`. DTOs use `whitelist` and `forbidNonWhitelisted`, so a body-supplied `companyId` is stripped. `404`, never `403` (ADR-003) |
| **Automated verification** | F02-T* - authenticate as A, request each of B's record types by real id, assert `404` and a byte-identical body to the nonexistent case |
| **Manual verification** | Direct API calls bypassing the UI entirely |
| **Status** | `OPEN` - lands in F02 |

### R-02 - Frequency rule bypassed under concurrency

| | |
|---|---|
| **Component** | Expense submission, policy evaluation |
| **Description** | Concurrent submissions for one employee each read the same count, all conclude the rule does not fire, and the window ends up over the limit with no REVIEW raised |
| **Likelihood** | **High** - it is the default behaviour without explicit serialisation |
| **Impact** | High - a core policy rule silently stops working |
| **Severity** | **Critical** |
| **Mitigation** | `pg_advisory_xact_lock(hashtext(companyId), hashtext(employeeId))` acquired as the first statement; count and insert inside one `READ COMMITTED` transaction (ADR-007) |
| **Automated verification** | F04-T07, five simultaneous submissions, order-independent assertions, **plus a negative control** that disables the lock and must fail |
| **Manual verification** | - |
| **Status** | `OPEN` - lands in F04 |

> R-02 and R-03 look similar and have different solutions. The unique constraint
> that fixes R-03 does nothing for R-02.

### R-03 - Duplicate expense created under concurrency

| | |
|---|---|
| **Component** | Expense submission |
| **Description** | Two simultaneous requests with the same `externalId` both create a row |
| **Likelihood** | High |
| **Impact** | High - breaks idempotency and double-counts toward frequency |
| **Severity** | **Critical** |
| **Mitigation** | `UNIQUE (company_id, external_id)`; the database rejects the second write. The application catches `23505` and returns the original decision. No check-then-insert (ADR-001) |
| **Automated verification** | F03-T*, two simultaneous identical submissions, assert one row and two `200`s with the same decision |
| **Manual verification** | - |
| **Status** | `OPEN` - lands in F03 |

### R-04 - A review is resolved twice

| | |
|---|---|
| **Component** | Review resolution |
| **Description** | Two managers resolve the same review simultaneously; both succeed, and the audit record or final status is wrong |
| **Likelihood** | Medium |
| **Impact** | High |
| **Severity** | High |
| **Mitigation** | Single conditional `UPDATE ... WHERE id = $1 AND company_id = $2 AND state = 'OPEN'`; review and expense updated in one transaction; `rowCount = 0` yields `409` (ADR-004) |
| **Automated verification** | F05-T*, two simultaneous resolves, assert exactly one `200`, one `409`, one audit record |
| **Manual verification** | Two browser sessions |
| **Status** | `OPEN` - lands in F05 |

### R-05 - Stack fails to start from a clean clone

| | |
|---|---|
| **Component** | Docker Compose, container entrypoint |
| **Description** | `docker compose up` fails on a machine with no warm cache, usually because the API starts before PostgreSQL accepts connections |
| **Likelihood** | High without explicit handling |
| **Impact** | Catastrophic for the submission - a reviewer who cannot start it cannot evaluate anything |
| **Severity** | **Critical** |
| **Mitigation** | `pg_isready` healthcheck on `db`; `depends_on: condition: service_healthy` on `api` and `web`; entrypoint that applies migrations and seeds before starting the process |
| **Automated verification** | **F00-T01** (cold start to healthy), **F00-T03** (`RestartCount = 0`), **F00-T10** (two consecutive cold starts) - see the result table below |
| **Manual verification** | Fresh-clone rehearsal before submission |
| **Status** | `MITIGATED` for F00 scope. Re-verify after F01 adds real migrations and a seed script |

### R-06 - Schedule pressure causes a guarantee to be skipped

| | |
|---|---|
| **Component** | Project management |
| **Description** | A core guarantee is dropped or left untested to make the deadline |
| **Likelihood** | Medium |
| **Impact** | High |
| **Severity** | High |
| **Mitigation** | Feature order follows the guarantees first: security and tenant isolation, then database correctness and concurrency, then business logic, then tests, then UI, then docs. The optional webhook bonus is out of scope until F10 is approved |
| **Automated verification** | - |
| **Manual verification** | Per-feature completion gate; nothing is marked complete without evidence |
| **Status** | `OPEN` - continuous |

### R-07 - CSRF against the cookie session

| | |
|---|---|
| **Component** | Browser authentication |
| **Description** | A third-party site triggers a state-changing request that the browser authenticates with the session cookie |
| **Likelihood** | Medium |
| **Impact** | High |
| **Severity** | High |
| **Mitigation** | Same-origin deployment via the Next proxy; `SameSite=Lax`; strict CORS allowlist; a custom header required on all mutations; all mutations use non-`GET` methods (ADR-008) |
| **Automated verification** | **F00-T05b** confirms the deployment is same-origin (no CORS header). F02-T* will assert the cookie attributes and reject a cross-origin mutation |
| **Manual verification** | - |
| **Status** | `IN PROGRESS` - the same-origin foundation is verified; the cookie itself lands in F02 |

### R-08 - API key or session token leaked into logs

| | |
|---|---|
| **Component** | Logging, error handling |
| **Description** | A secret reaches application logs, an error response, or an access log |
| **Likelihood** | **High** without deliberate handling - it is the default outcome |
| **Impact** | High - a leaked API key is full tenant compromise |
| **Severity** | **Critical** |
| **Mitigation** | Redaction interceptor for `x-api-key` and `authorization`; exception filter never echoes headers; pattern scrubber for key-shaped strings; secrets travel in headers only, never query strings; plaintext returned exactly once (ADR-006). **Already applied in F00:** the health endpoint returns a generic `"database unreachable"` and logs the driver error server-side only, because Prisma connection errors embed the password |
| **Automated verification** | `health.unit.spec.ts` asserts the response contains neither the driver message nor the password. **F00-T02b** asserts no connection string in the live health response. `env.spec.ts` asserts the config error never echoes the variable value |
| **Manual verification** | `grep` over captured container logs before submission |
| **Status** | `IN PROGRESS` - the F00 surfaces are covered and tested; the interceptor lands with F02 |

### R-09 - Advisory lock hash collision

| | |
|---|---|
| **Component** | Expense submission |
| **Description** | Two unrelated `(company, employee)` pairs hash to the same advisory lock key |
| **Likelihood** | Low with the two-argument form (2^64 key space) |
| **Impact** | **Low** |
| **Severity** | Low |
| **Mitigation** | Two-argument `pg_advisory_xact_lock(hashtext(c), hashtext(e))` rather than a concatenated 32-bit key |
| **Why the impact is low** | A collision causes two unrelated submissions to wait on each other. It **cannot** produce a wrong decision: every query inside the lock still filters on the real `company_id` and `employee_id`. The lock decides who waits, never who sees what |
| **Automated verification** | - (not economically testable) |
| **Manual verification** | Documented reasoning in ADR-007 |
| **Status** | `ACCEPTED` |

### R-10 - Concurrency tests pass without testing anything

| | |
|---|---|
| **Component** | Test infrastructure |
| **Description** | The connection pool is smaller than the test's concurrency, so requests serialise inside the pool. The test passes whether or not the mechanism under test exists |
| **Likelihood** | **High** - the default pool size is small and the failure is invisible |
| **Impact** | High - we would believe a guarantee is proven when nothing was exercised |
| **Severity** | **Critical** |
| **Mitigation** | `DB_POOL_MAX` is an explicit, validated environment variable (ADR-009 made it reachable). Test setup pins it to `10`. Every concurrency test ships with a **negative control** that disables the mechanism and must fail |
| **Automated verification** | The negative control itself. `env.spec.ts` covers the validation of `DB_POOL_MAX` |
| **Manual verification** | Code review of every concurrency test for a matching negative control |
| **Status** | `IN PROGRESS` - the mechanism exists and is configured; the concurrency tests land in F03 and F04 |

### R-11 - A back-dated expense evades the frequency rule

| | |
|---|---|
| **Component** | Policy evaluation |
| **Description** | Forward-only evaluation never looks ahead, so an expense submitted with an earlier `spentAt` can receive APPROVE even though it is logically the fourth in its own window |
| **Likelihood** | Medium |
| **Impact** | Medium |
| **Severity** | Medium |
| **Mitigation (partial)** | `spentAt` bounded to 5 minutes in the future and 90 days in the past; `receivedAt` stored on every expense so the gap is visible to a reviewer |
| **Residual hole** | **The bypass remains possible within those bounds.** Closing it needs retroactive re-evaluation (rejected) or a sliding sub-window search (deferred) - see ADR-002 |
| **Automated verification** | F04-T*, which **documents** the behaviour rather than preventing it |
| **Manual verification** | - |
| **Status** | `ACCEPTED` - knowingly carried, not eliminated |

### R-12 - Cross-origin cookie misconfiguration

| | |
|---|---|
| **Component** | Deployment topology |
| **Description** | Web and API on different origins forces `SameSite=None`, which disables the primary CSRF defence and requires HTTPS everywhere |
| **Likelihood** | Medium - it is the default outcome of a naive two-service setup |
| **Impact** | High |
| **Severity** | High |
| **Mitigation** | Same-origin by construction: the browser only talks to the web origin, and Next rewrites `/api/*` server-side to the API over the Docker network |
| **Automated verification** | **F00-T05** (proxy returns the API's response) and **F00-T05b** (no `access-control-allow-origin` header) |
| **Manual verification** | Browser devtools network tab |
| **Status** | `MITIGATED` - verified in F00 |

### R-13 - Repository bloat with code that cannot be defended

| | |
|---|---|
| **Component** | Dependency and scaffolding choices |
| **Description** | Generated or copied code that nobody uses. Section 9 of the assessment states that everything in the repository counts as ours and that we will be asked why each part is there |
| **Likelihood** | Medium |
| **Impact** | Medium - unexplainable files are a direct liability in the review |
| **Severity** | Medium |
| **Mitigation** | shadcn/ui reduced to only the primitives actually used; React Hook Form rejected for three forms; `packages/contracts` deliberately not created until F03 gives it a real shared type; no `pg` dependency added when the Prisma adapter already carries it |
| **Automated verification** | - |
| **Manual verification** | Review of staged files before every commit |
| **Status** | `OPEN` - continuous |

### R-14 - Toolchain version incompatibility

| | |
|---|---|
| **Component** | Build, lint and test toolchain |
| **Description** | Picking the newest release of every package produces a combination that does not actually work together |
| **Likelihood** | **Realised** - it happened twice during F00 |
| **Impact** | High - it broke `prisma generate` and the entire Jest suite |
| **Severity** | High |
| **Mitigation** | Versions selected from published `peerDependencies` and `engines`, not from `latest`. One TypeScript version across build, typecheck, lint and test. Recorded in ADR-009 and ADR-010 |
| **Automated verification** | **F00-T08 / T09 / T11** - lint, typecheck and build gates. `npm ci` from the committed lockfile in both Dockerfiles |
| **Manual verification** | `npm install` reports no `EBADENGINE` warnings |
| **Status** | `MITIGATED` for the current set. Re-check on any dependency bump |

### R-15 - Submission or documentation failure

| | |
|---|---|
| **Component** | Delivery |
| **Description** | The repository is not reachable by the reviewer, the collaborator invite is missing, the README is insufficient, or the deadline is missed |
| **Likelihood** | Low |
| **Impact** | Catastrophic |
| **Severity** | High |
| **Mitigation** | Fresh-clone rehearsal; README written for someone with no context; `AI_LOG.md` maintained as work happens; incremental commits |
| **Automated verification** | `scripts/verify-f00.sh` and its successors |
| **Manual verification** | **Only the project owner can confirm** the GitHub collaborator invite to `tarek-ragab-abdelal` and the email to `tragab@limaz.co` |
| **Status** | `OPEN` |

## Summary

| Severity | Open | In progress | Mitigated | Accepted |
|---|---|---|---|---|
| Critical | R-01, R-02, R-03 | R-08, R-10 | R-05 | - |
| High | R-04, R-06, R-15 | R-07 | R-12, R-14 | - |
| Medium | R-13 | - | - | R-11 |
| Low | - | - | - | R-09 |

## Review log

| Date | Trigger | Changes |
|---|---|---|
| 2026-11-19 | Initial architecture planning | R-01 to R-06 raised |
| 2026-11-19 | Architecture review by the project owner | R-07 to R-13 added |
| 2026-11-19 | F00 completed | R-14 added (realised during implementation). R-05 and R-12 moved to `MITIGATED` with named evidence. R-07, R-08 and R-10 moved to `IN PROGRESS` |
