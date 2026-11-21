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
| **Automated verification** | F02-T* - authenticate as A, request each of B's record types by real id, assert `404` and a byte-identical body to the nonexistent case. **F01 landed the schema half:** F01-T09 and F01-T09b prove a review cannot claim a tenant its expense does not belong to (ADR-011) |
| **Manual verification** | Direct API calls bypassing the UI entirely |
| **Status** | `MITIGATED` for the mechanism. F02 built the API boundary: tenant from a typed principal only, `tenantScope()` as the single filter source, `404` not `403`, and **F02-T29** as the negative control. **Re-verification is still required** on the real expense, review and admin endpoints in F03, F05 and F08 - F02 proved it through a test-only controller |

### R-02 - Frequency rule bypassed under concurrency

| | |
|---|---|
| **Component** | Expense submission, policy evaluation |
| **Description** | Concurrent submissions for one employee each read the same count, all conclude the rule does not fire, and the window ends up over the limit with no REVIEW raised |
| **Likelihood** | **High** - it is the default behaviour without explicit serialisation |
| **Impact** | High - a core policy rule silently stops working |
| **Severity** | **Critical** |
| **Mitigation** | `pg_advisory_xact_lock(hashtext(companyId), hashtext(employeeId))` acquired as the first statement; count and insert inside one `READ COMMITTED` transaction (ADR-007) |
| **Automated verification** | **F04-T26** - five simultaneous distinct expenses for one employee give exactly 3 APPROVE, 2 REVIEW, 2 OPEN reviews and 2 FREQUENCY hits, with recorded counts of 4 and 5. Order-independent: the multiset of outcomes is asserted, never which request won. **F04-NC1** is the negative control - with the lock replaced by a no-op the same scenario produces **5 APPROVE, 0 reviews, 0 FREQUENCY hits** |
| **Manual verification** | Five concurrent submissions against `docker compose up`: 3 APPROVE, 2 REVIEW, 2 open reviews |
| **Status** | `MITIGATED` |
| **Evidence it is genuinely exercised** | A pre-lock barrier releases all five together, so they are provably in flight at once; the recorded `countIncludingCurrent` values of 4 and 5 are only reachable if the transactions saw one another in order. The negative control adds a second synchronisation point between the count and the write, so "all five counted zero" is a determined outcome rather than a likely one |
| **Re-verify** | Any change to the transaction order, the isolation level, or the lock key |

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
| **Automated verification** | **F03-T17** (2 concurrent), **F03-T18** (5 concurrent, one evaluation, no duplicate side effects), **F03-T19** (concurrent conflicting payloads), **F03-T21** (the shape where the index actually decides), **F03-T27** (negative control: with the index dropped, the same race creates two rows). F01-T04 and F01-T05 proved the constraint itself |
| **Manual verification** | `docs/testing/F03-manual-cycle.md` section 7, labelled as a smoke test - it cannot guarantee the requests overlap, which is why the automated version uses a bounded barrier |
| **Status** | `MITIGATED` |
| **What F03 added beyond the constraint** | The losing request no longer produces a `500`. Its transaction is aborted by the `23505`, so the outcome is resolved on a fresh connection afterwards and returned as `200` or `409`. **Re-verify in F04**, because the frequency count is a different invariant the constraint does not protect |

### R-04 - A review is resolved twice

| | |
|---|---|
| **Component** | Review resolution |
| **Description** | Two managers resolve the same review simultaneously; both succeed, and the audit record or final status is wrong |
| **Likelihood** | Medium |
| **Impact** | High |
| **Severity** | High |
| **Mitigation** | Single conditional `UPDATE ... WHERE id = $1 AND company_id = $2 AND state = 'OPEN'`; review and expense updated in one transaction; `rowCount = 0` yields `409` (ADR-004) |
| **Automated verification** | F05-T*, two simultaneous resolves, assert exactly one `200`, one `409`, one audit record. **F01 landed the supporting constraints:** `UNIQUE (expenseId)` (F01-T06), the composite tenant key (F01-T09), and `reviews_state_resolution_check`, which makes a resolved review with no recorded reviewer unstorable (F01-T12) |
| **Manual verification** | Approve, then approve again (200), then reject (409), against `docker compose up` |
| **Status** | `MITIGATED` |
| **Measured evidence** | **F05-T31** two managers with opposite decisions: one 200, one 409, stored state is the winner's. **F05-T33** five managers: exactly one 200, four 409, no 5xx, every loser naming the same winner. **F05-T44** a resolved review cannot have its reviewer or timestamp overwritten by any later attempt. **F05-NC1** is the negative control: with `AND state = 'OPEN'` removed from the mutation, both managers succeed and the second overwrites the first's outcome, reviewer and timestamp, with no error raised anywhere |
| **Contention proven, not inferred** | `pg_blocking_pids()` is polled from a separate connection with a bounded timeout until PostgreSQL reports a backend blocked on another |
| **Re-verify** | Any change to the UPDATE predicate, the transaction boundary, or the isolation level |

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
| **Status** | `MITIGATED`. **Re-verified in F01** now that the entrypoint genuinely applies migrations and seeds: F01-T18 to T18d, and F01-T19 for a restart |

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
| **Status** | `MITIGATED`. Four layers built and tested: `SameSite=Lax`, no CORS at all, a required `X-Limaz-Client` header, and a **server-side `Origin` check** that moves the judgement out of the browser and into our own code. F02-T16, T16b, T16f, T30, T30c |

### R-08 - API key or session token leaked into logs

| | |
|---|---|
| **Component** | Logging, error handling |
| **Description** | A secret reaches application logs, an error response, or an access log |
| **Likelihood** | **High** without deliberate handling - it is the default outcome |
| **Impact** | High - a leaked API key is full tenant compromise |
| **Severity** | **Critical** |
| **Mitigation** | Redaction interceptor for `x-api-key` and `authorization`; exception filter never echoes headers; pattern scrubber for key-shaped strings; secrets travel in headers only, never query strings; plaintext returned exactly once (ADR-006). **Already applied in F00:** the health endpoint returns a generic `"database unreachable"` and logs the driver error server-side only, because Prisma connection errors embed the password |
| **Automated verification** | `health.unit.spec.ts` asserts the response contains neither the driver message nor the password. **F00-T02b** asserts no connection string in the live health response. `env.spec.ts` asserts the config error never echoes the variable value. **F01:** F01-T14b and F01-T14c assert passwords and API keys are stored only as hashes, and F01-T18i asserts no plaintext key reached the live database |
| **Manual verification** | `grep` over captured container logs before submission |
| **Status** | `MITIGATED`. `redact()` scrubs by header name, by key name and by pattern; `HttpExceptionFilter` never echoes request headers; credentials travel in headers only, never query strings. F02-T24, T24a, T24b, T24c, plus a live scan of the container logs |

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
| **Automated verification** | `env.spec.ts` covers `DB_POOL_MAX` validation. Every concurrency suite pins it to 10, above the concurrency used. **Both concurrency features now ship a negative control that fails without the mechanism**: F03-T27 (drop the unique index, duplicates appear) and F04-NC1 (remove the advisory lock, the frequency rule silently stops firing) |
| **Manual verification** | Code review of every concurrency test for a matching negative control |
| **Status** | `MITIGATED` |
| **What closed it** | The risk was that a concurrency test could pass without exercising anything. Both mechanisms are now demonstrated to fail when removed, which is the only evidence that the passing version proves something. **F04-NC2 additionally guards the guard**: a barrier whose participants cannot all arrive fails in seconds with a named error instead of hanging |
| **Residual** | A FUTURE concurrency test could still be written without a negative control. The convention is documented in both matrices; nothing enforces it |

### R-11 - Out-of-order arrival evades the frequency rule

> **Widened in F13 after the QA regression pass (MIN-03).** This entry used to
> be titled "a back-dated expense evades the frequency rule" and described
> only deliberate or late backfill, with a worked example an hour apart. That
> was too narrow, and the narrowness mattered: the **same** hole opens on
> ordinary concurrent live traffic, which is the exact traffic the frequency
> rule exists to catch. The mechanism is unchanged; the scope was understated.

| | |
|---|---|
| **Component** | Policy evaluation |
| **Description** | Evaluation looks only backwards from the submitted `spentAt`, so an expense whose `spentAt` is earlier than one already decided does not see it. It can receive APPROVE although it is logically the fourth in its own window. **This happens whenever arrival order differs from `spentAt` order** - by back-dating, by a delayed or retried integration, by a card provider's own batching, and by ordinary concurrency, where several requests are in flight at once and carry timestamps milliseconds apart |
| **Likelihood** | **Medium-high** - raised in F13. Back-dating alone is uncommon; a concurrent burst is not. Any company backend submitting in parallel produces one |
| **Impact** | Medium |
| **Severity** | Medium |
| **Mitigation (partial)** | `spentAt` bounded to 5 minutes in the future and 90 days in the past; `receivedAt` stored on every expense so the gap between "when it was spent" and "when we heard" is visible to a reviewer on every row |
| **Residual hole** | **The bypass remains possible within those bounds, and it is wider than a back-dating risk.** Closing it needs retroactive re-evaluation (rejected) or a sliding sub-window search (deferred) - see ADR-002 |
| **Automated verification** | **F04-T24** builds the exact sequence from ADR-002 - 10:10, 10:20, 10:30, then a late 10:05 - and asserts the late expense is APPROVE with no reasons, and that the three earlier decisions are untouched. **F04-T25** then submits at 10:35 and asserts a count of 5. **F04-T26b** (added in F13) submits a concurrent burst with `spentAt` values milliseconds apart and asserts the two invariants that hold on every interleaving: the earliest `spentAt` always approves however late it arrives, and no expense's recorded count can exceed its rank in `spentAt` order. These tests **document** the bypass; they do not prevent it |
| **Why the count is not asserted** | The number of approvals in such a burst varies with lock order, which is undetermined - the QA pass observed 3 to 7 of ten against a limit of 3. Asserting a number would be flaky by construction, so F04-T26b asserts the mechanism instead |
| **Manual verification** | QA regression pass, 21 November 2026, cycle 6 case C6.15 - reproduced on every run |
| **Status** | `ACCEPTED` - knowingly carried, not eliminated |
| **Explicitly NOT mitigated by the advisory lock** | The lock added in F04 orders concurrent writers, and F04-T26 shows it working: ten submissions sharing one `spentAt` approve exactly three, deterministically, every run. It does not help here. Serialising the writers does not change what each one is allowed to see, and a serialised transaction still evaluates only backwards. Claiming the lock closes this would be the kind of overstatement that makes a risk register useless |

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

### R-16 - Development stack reachable from the local network

| | |
|---|---|
| **Component** | Docker Compose port publishing |
| **Description** | `ports: - '5433:5432'` binds to `0.0.0.0`, so a database carrying a documented, well-known development password is reachable by anyone on the same network - a cafe or office wifi, for example |
| **Likelihood** | Medium - it is the default behaviour of a plain port mapping, and the review stack runs on laptops |
| **Impact** | Medium for the development stack; the data is seeded, not real |
| **Severity** | Medium |
| **Mitigation** | All three published ports bound to `127.0.0.1` explicitly. Still fully reachable from the host, so the README instructions and host-run integration tests are unchanged |
| **Why the password itself was not changed** | It is a development-only placeholder, documented as such in `.env.example` and the README, and the assessment permits seeded development credentials. Production values come from the platform secret manager; no image contains an `.env` (verified by F00-T12) |
| **Automated verification** | F00-T01 to F00-T05 all still pass against loopback-bound ports |
| **Manual verification** | `docker compose ps` shows `127.0.0.1:PORT->PORT/tcp` rather than `0.0.0.0:PORT->PORT/tcp` |
| **Status** | `MITIGATED` |
| **Source** | Raised by automated security review of the F00 commit, 2026-11-19 |

### R-17 - A category typo silently bypasses the blocked list

| | |
|---|---|
| **Component** | Expense category matching |
| **Description** | `category` is a free string, so a client sending `TRANSPORTATION` where the blocked list holds `TRANSPORT` simply does not match, and the rule does not fire |
| **Likelihood** | Medium |
| **Impact** | Medium - a blocked-category rejection is missed |
| **Severity** | Medium |
| **Mitigation (partial)** | Categories are normalised (trimmed, uppercased) in one place before storage and before comparison, so case and whitespace cannot cause a miss |
| **Residual hole** | **A genuinely different word still does not match.** Closing it needs a per-company category vocabulary, which nothing in the requirements asks for and which would make every new category an administrative step |
| **Why not an enum** | A Prisma enum would give database-level integrity, but the category vocabulary belongs to the company, not to us: every new category would need a migration and a deploy |
| **Automated verification** | F04 will assert that normalisation makes case and whitespace variants match |
| **Manual verification** | - |
| **Status** | `ACCEPTED` - knowingly carried, with the reasoning recorded |

### R-18 - XSS defeats every CSRF layer

| | |
|---|---|
| **Component** | Browser session security |
| **Description** | Script injected into our own page runs same-origin. It can set `X-Limaz-Client`, it sends a correct `Origin`, and the browser attaches the session cookie - so every CSRF layer passes |
| **Likelihood** | Low for now; the frontend renders almost nothing user-supplied yet |
| **Impact** | High - any action the signed-in user can take |
| **Severity** | High |
| **Mitigation (partial)** | `HttpOnly` stops the token being read and exfiltrated, so the session cannot be used elsewhere. React escapes by default |
| **Residual hole** | **The attacker does not need to read the cookie.** They act from inside the page. Closing this needs a Content-Security-Policy with a `script-src` directive and discipline about rendering user-supplied content - **neither is built**. A `frame-ancestors` directive was added in F13, but that closes R-39, not this: it governs who may frame the page, not what may execute inside it |
| **Automated verification** | None, and that is the point: the CSRF suite cannot catch this |
| **Manual verification** | Review of every place F06 to F08 render user input |
| **Status** | `ACCEPTED` - stated rather than implied |
| **Do not misread the F13 header work** | The web tier now sends a `Content-Security-Policy` header. It carries **one directive**, `frame-ancestors 'none'`. The presence of the header name is not the presence of a content security policy, and nothing in F13 reduces this risk |

### R-19 - Login is not rate limited

| | |
|---|---|
| **Component** | Authentication |
| **Description** | Nothing throttles repeated login attempts, so password guessing is bounded only by the bcrypt cost factor |
| **Likelihood** | Medium |
| **Impact** | Medium - the seeded passwords are strong, but a real deployment would not be so lucky |
| **Severity** | Medium |
| **Mitigation (partial)** | bcrypt at cost 10 puts each attempt at roughly 100 ms, so one attacker manages about 10 per second per connection. Generic errors reveal nothing about which half of the pair was wrong |
| **Residual hole** | **A distributed attempt is unaffected.** Needs per-IP and per-account throttling plus lockout after repeated failures |
| **Automated verification** | None |
| **Manual verification** | - |
| **Status** | `ACCEPTED` - outside the stated scope of F02, recorded for the README |

### R-20 - A developer forgets to apply the tenant filter

| | |
|---|---|
| **Component** | Every company-scoped query |
| **Description** | `tenantScope(principal)` has to be spread into each `where`. Omitting it returns rows from every tenant, and the endpoint still appears to work |
| **Likelihood** | Medium, and rising with every endpoint added |
| **Impact** | Catastrophic - this is R-01 arriving by a different road |
| **Severity** | **Critical** |
| **Mitigation (partial)** | One helper, so `grep tenantScope` finds every scoped query. The tenant comes from a typed principal, not a loose string. `tenantScope()` throws for a principal with no tenant rather than returning an empty filter, because an empty filter means either no rows or all rows. Cross-tenant tests on every feature that adds endpoints |
| **Residual hole** | **Nothing prevents the omission.** PostgreSQL row-level security would; it was rejected for lack of Prisma support, the `SET LOCAL` requirement per transaction, friction under transaction-mode pooling, and the admin needing `BYPASSRLS`. Recorded as the upgrade path |
| **Automated verification** | F02-T29 negative control, plus per-feature cross-tenant tests from F03 onwards |
| **Manual verification** | Review every new query against a company-owned table |
| **Status** | `ACCEPTED` - knowingly carried, with the upgrade path named |

### R-21 - The development seed could restore revoked credentials

| | |
|---|---|
| **Component** | Container entrypoint, development seed |
| **Description** | The entrypoint ran the seed on **every** container start, with `NODE_ENV=production`, and the seed update branch rewrites each user password to the one published in this repository and sets every API key back to `ACTIVE`. A restart would undo a password change and **un-revoke a leaked key** |
| **Likelihood** | High, had the image ever reached a real environment |
| **Impact** | **Catastrophic** - a published admin password restored, and revocation rendered meaningless |
| **Severity** | **Critical** |
| **Mitigation** | Two independent gates. The entrypoint skips seeding unless `SEED_DEV_DATA=true`; the seed script itself refuses when `NODE_ENV=production` without that opt-in. `docker-compose.yml` sets it explicitly because that file is the development stack; a real deployment does not |
| **Why the overwrite was kept** | Restoring a known state is what a development seed is for. The defect was the missing gate, not the behaviour |
| **Automated verification** | **F02-T21** (non-zero exit with an explanation), **F02-T21b** (the refusal names no credential) |
| **Manual verification** | `NODE_ENV=production node dist/prisma/seed.js` |
| **Status** | `MITIGATED` |
| **Source** | Automated security review of commit `c7a024b` |

### R-22 - The credential redactor is a backstop with named gaps

| | |
|---|---|
| **Component** | `apps/api/src/common/redact.ts` |
| **Description** | The redactor rewrites credentials found in strings before they reach a log. It cannot be complete: a raw `/` or a raw quote inside a password is not redacted, because scanning past either mangles ordinary URLs and structured log lines. Both characters must be percent-encoded in a conforming URL |
| **Likelihood** | Low - it requires a non-conforming connection string **and** that string reaching a log |
| **Impact** | High - a credential in a log file |
| **Severity** | **Medium** |
| **Mitigation** | The real defence is structural: credentials are not placed into log messages in the first place, configuration errors name the variable rather than the value, and the seed refusal names no credential (F02-T21b). The redactor is the layer that catches a mistake, not the layer that prevents one. It also bounds its input at 8 KB, so a long line cannot turn redaction into a scan |
| **Residual hole** | **The two input shapes above, stated as KNOWN LIMITS in the file's own header** so nobody reads the function as a guarantee |
| **Why not keep fixing it** | Five rounds of review were applied, and the fifth proposed change **introduced a leak** - treating `,` and `;` as terminators broke passwords containing them, since both are RFC 3986 sub-delimiters (AI_LOG 14). A sixth finding could not be reproduced across 200 measured inputs. Continuing to adjust a backstop has a worse expected outcome than the structural work it displaces |
| **Automated verification** | F02 redaction suite, including a password containing a comma |
| **Manual verification** | Re-read the KNOWN LIMITS block before adding any new log statement that carries a connection string |
| **Status** | `ACCEPTED` - with the limits documented in the code, not only here |

### R-23 - The frontend's interaction behaviour has no automated test

| | |
|---|---|
| **Component** | `apps/web` - drawer, menu, double-submit guard, inline validation, responsive layout |
| **Description** | Eighteen F02.1 checks are scripted. Five are verified by hand in a real browser with their measurements recorded, and nothing re-runs them. A regression in focus return, scroll lock or the submit guard would ship silently |
| **Likelihood** | Medium once F06 to F08 add more screens to the same shell |
| **Impact** | Medium - an unusable drawer for keyboard and screen-reader users, or a duplicate submission |
| **Severity** | **Medium** |
| **Mitigation** | Each check is recorded in `docs/testing/F02.1-test-matrix.md` **with the values measured**, not as a tick, so it can be re-run by hand and compared. The two behaviours hardest to get right - focus trap and roving focus - are delegated to Radix rather than hand-rolled |
| **Residual hole** | **No regression protection.** Playwright is the answer and was deferred deliberately: at this size it is ceremony, and it would be added for the review queue in F07 where a wrong click has a real consequence |
| **Automated verification** | None, and that is the risk |
| **Manual verification** | The five rows marked *browser* in the F02.1 test matrix |
| **Status** | `ACCEPTED` - deferred with the trigger named |

### R-24 - Route protection could be mistaken for security

| | |
|---|---|
| **Component** | `apps/web/app/(app)/layout.tsx`, `admin/layout.tsx`, `lib/nav.ts` |
| **Description** | The web application redirects unauthenticated visitors, hides admin navigation from managers and renders an access-denied page. None of it is enforcement. The danger is not the code - it is a future contributor concluding that putting a page under `(app)` is what protects it, and building an endpoint that trusts the browser |
| **Likelihood** | Medium - this is the single most common misreading of this pattern |
| **Impact** | **Catastrophic** if it leads to an endpoint that takes the tenant or the role from the client |
| **Severity** | **High** |
| **Mitigation** | Stated in three places a contributor will actually be in: the comment at the top of `lib/auth.ts`, the architecture document, and the "Adding a page" checklist, which says *take the tenant from the server, never from a query parameter*. The API enforces independently and F02 proves it with no browser involved (T13-T29) |
| **Residual hole** | **Nothing mechanically prevents it.** The guard is the API's global `AuthorizationGuard`, which fails closed - a new route is protected until someone writes `@Public()` on it |
| **Automated verification** | F02-T23 to T29 (the API refuses regardless of the client), F02.1-T07b (no admin navigation leaks) |
| **Manual verification** | Review every new endpoint added in F03 onwards for `tenantScope()` |
| **Status** | `ACCEPTED` - a documentation risk, carried deliberately |

### R-25 - A single expense cannot exceed the int4 range

| | |
|---|---|
| **Component** | `Expense.amountMinor` |
| **Description** | The column is PostgreSQL `int4`, so one expense is capped at **2,147,483,647 minor units** - 21,474,836.47 of a two-decimal currency |
| **Likelihood** | Low for an expense-policy service; a single employee expense of 21 million riyals is not the case this system serves |
| **Impact** | Medium - a legitimate submission refused |
| **Severity** | **Medium** |
| **Mitigation** | Enforced in the DTO, so the caller gets a clear `400` naming the limit rather than a `500` from PostgreSQL rejecting the insert. The boundary value itself is accepted, and tested |
| **Residual hole** | **The cap is real.** `BigInt` would remove it and would change every arithmetic site, the JSON contract and the F04 comparisons. Not worth it against a limit nothing is near |
| **Automated verification** | **F03-T06** |
| **Manual verification** | - |
| **Status** | `ACCEPTED` - with the upgrade path named |

### R-26 - The canonicalisation is a public contract with no versioning

| | |
|---|---|
| **Component** | `apps/api/src/expenses/canonical-payload.ts` |
| **Description** | The payload hash decides which resubmissions are retries and which are conflicts. Every expense already stored was hashed under the rules in force when it arrived. Changing which fields are covered, or how they are normalised, makes every stored hash unreachable: a correct retry of an old expense would hash differently and be refused with a `409` the caller cannot resolve |
| **Likelihood** | Medium - adding a field to the expense is an obvious F04 or F06 change, and including it in the hash looks harmless |
| **Impact** | High - every historical expense becomes permanently conflicting |
| **Severity** | **High** |
| **Mitigation** | The exact canonical string is pinned by an equality assertion, so changing it requires editing a test on purpose rather than discovering it later. The file states in its own header that it is part of the public contract |
| **Residual hole** | **No hash versioning.** A `payloadHashVersion` column, with comparison falling back to the stored version, is the real fix. Not built: it adds a column and a branch for a change nobody has needed yet |
| **Automated verification** | The pinned canonical-string test, plus one test per covered field |
| **Manual verification** | Re-read the header before adding a field to the expense |
| **Status** | `ACCEPTED` - with the upgrade path named |

### R-27 - Nothing prevents an expense from being deleted

| | |
|---|---|
| **Component** | `expenses` |
| **Description** | `Company.onDelete: Restrict` is easy to read as a deletion guard. **It is not.** It prevents deleting a *company* that still has expenses, and says nothing about deleting an expense directly - a `DELETE FROM expenses`, a Prisma `expense.delete()`, or a future retention job would all succeed, cascading `rule_hits` away with it |
| **Why it matters beyond data loss** | Deleting an expense frees its `externalId`. A later retry of that same expense would then be treated as **new**, receive a fresh decision under whatever policy is current, and count toward a frequency window it had already contributed to |
| **Likelihood** | Low today - nothing in the application deletes one, and no endpoint exposes it |
| **Impact** | High - a decision silently reissued, and the audit trail broken |
| **Severity** | **Medium** |
| **Mitigation** | **Expense deletion is outside our supported operations**, stated in `docs/features/F03-expense-submission.md`. The `resolveLostRace()` path depends on the winning row still being there and raises an explicit `500` rather than a quiet success if it is not |
| **Residual hole** | **The schema does not prevent it.** Retention or erasure, if ever required, needs its own design - including what happens to the freed identifier |
| **Automated verification** | None, and that is the risk |
| **Manual verification** | Review any future retention or admin tooling against this entry |
| **Status** | `ACCEPTED` - stated rather than implied |

### R-28 - Keyset pagination has no backward cursor

| | |
|---|---|
| **Component** | `apps/web/components/expenses/expense-list.tsx` |
| **Description** | A keyset cursor is a position in **one** direction, and the API returns only a forward one. The cursors already visited are therefore kept in component state and "Newer" pops that stack. A link **pasted** with a `cursor` in it starts with an empty stack, so "Newer" from that page returns to the **first** page rather than the one before it |
| **Likelihood** | Low - it needs somebody to share a deep page rather than page there themselves |
| **Impact** | Low - the reader lands somewhere defined and can page forward again. Nothing is lost or shown incorrectly |
| **Severity** | **Low** |
| **Mitigation** | `?? null` on the empty pop, so the fallback is the first page rather than `undefined` being sent as a cursor. **And the button says where it goes**: it reads "First page" rather than "Newer" whenever this session has no previous page recorded, so the reader is not told one thing and given another (F06 closure) |
| **Residual hole** | Encoding the whole trail in the URL would fix it and would make every shared link unwieldy. A backward cursor on the API would fix it properly and is the real upgrade path |
| **Automated verification** | None - the forward path is covered by F06-T19 and T19b |
| **Manual verification** | Step 10 of the F06 manual cycle |
| **Status** | `ACCEPTED` - the cost of the fix exceeds the cost of the case |

### R-29 - The category filter offers only what the current page contains

| | |
|---|---|
| **Component** | `apps/web/components/expenses/expense-list.tsx` |
| **Description** | The category dropdown is derived from the categories present in the **page being displayed**, plus whatever is already selected. A company whose rarer categories only appear on page three cannot select one from page one |
| **Likelihood** | Medium once a company has more than one page of expenses |
| **Impact** | Low - the filter still works when set from the URL, and search covers the same ground by merchant or reference |
| **Severity** | **Low** |
| **Mitigation** | The selected value is always added to the list, so a category chosen from a shared link never disappears from the control. Stated as an omission in `docs/features/F06-manager-dashboard.md` rather than presented as complete |
| **Residual hole** | The correct fix is a distinct-categories endpoint. Not built: a second request on every page load to populate a convenience control was not judged worth it at this size |
| **Automated verification** | None |
| **Manual verification** | Step 5 of the F06 manual cycle |
| **Status** | **`MITIGATED`** - the upgrade path named here was built in the F06 closure pass |

### R-30 - A high-severity advisory in the Prisma CLI's dependency tree

| | |
|---|---|
| **Component** | `prisma` (devDependency) -> `@prisma/config` -> `effect` |
| **Description** | `npm audit` reports three **high** findings. All three are one chain: `effect <= 3.22.0` has a ReDoS in `Schema.TemplateLiteral`'s compiled regex, and `@prisma/config` and `prisma` are flagged only for depending on it |
| **Actual exposure** | `@prisma/config` is loaded by the Prisma **CLI**, to parse `prisma.config.ts`. The running server (`node apps/api/dist/main.js`) uses `@prisma/client` and `@prisma/adapter-pg`, which do **not** depend on it - verified with `npm ls @prisma/config`. The CLI is present in the runtime image because the entrypoint runs `prisma migrate deploy`, so the code is on disk at runtime but is executed **only at container start**, and its only input is a file in this repository |
| **Is the vulnerable path reachable from a request?** | **No.** No HTTP route, no user input and no database value reaches `Schema.TemplateLiteral`. A ReDoS needs attacker-controlled input; this input is our own config file, unchanged between runs |
| **Likelihood** | Very low |
| **Impact** | Low in this architecture - at worst a slow container start, not a request-path denial of service |
| **Severity** | **Low** (npm's "high" rates the library, not this usage) |
| **Available fix** | npm offers exactly one: **downgrade `prisma` 7.10.1 -> 6.12.0**, a major version backwards. That would undo ADR-009's driver-adapter architecture, the Prisma 7 config file and the generated client. `npm audit fix --force` was **not** run |
| **Decision** | Do not downgrade. Trading a working, documented data-access architecture for an audit count on an unreachable path is a worse engineering outcome than the finding itself |
| **Automated verification** | None. `npm ls` establishes the path; nothing tests an unreachable branch |
| **Manual verification** | Re-check when Prisma 7 ships a release carrying `effect > 3.22.0`, and upgrade then |
| **Status** | `ACCEPTED` - with the exposure analysed rather than the count dismissed |

**F09 re-review, with three things added to the above.**

1. **The vulnerable symbol is not present in the consumer.** `TemplateLiteral`
   appears **0 times** anywhere in `@prisma/config`, whose only direct
   `effect` import is `effect/Function`. So the sink is not merely
   unreachable from a request - the code that would call it is not in the
   calling package at all. `apps/api/dist/main.js` contains **0** references
   to `effect` or `@prisma/config`, and the API source imports
   `@prisma/client` (23 times) and `@prisma/adapter-pg` (twice) and nothing
   else.

2. **A compatible upgrade was attempted and does not take.**
   `@prisma/config@7.10.1` pins `effect` to **exactly** `3.20.0`; a patched
   `3.22.5` exists. An `overrides` entry - both the flat and the
   `@prisma/config`-scoped form - was added and `npm install` run. **npm
   10.9.3 reported "up to date" and left `3.20.0` resolved**, recording no
   override in the lockfile. Making it take effect means deleting and
   regenerating `package-lock.json`, re-resolving 907 packages days before
   submission. That trades a measured-unreachable advisory for a real risk to
   the reproducible build, so it was reverted rather than forced.

3. **Nineteen moderate findings share the same shape.** `jest` and
   `@nestjs/cli` reach `glob` (GHSA-3g3m-2fjr-6pw4) and `minimatch`
   (GHSA-g3hv-75wg-m249), both denial-of-service classes against a local
   build. npm's proposed fix is a major **downgrade** of Jest to 29.

**One residual worth stating plainly, because it is not in the row above.**
The runtime image keeps the **whole** dependency tree, devDependencies
included, because the entrypoint needs the Prisma CLI. So `jest`,
`@nestjs/cli` and `effect` are on disk in the production image even though
nothing executes them. Running migrations as a separate job and pruning the
image is the proper fix and is **not done**; it is named here rather than
implied.

### R-31 - Concurrent policy edits are last-write-wins

| | |
|---|---|
| **Component** | `PolicyService.update` |
| **Description** | Two managers editing the policy at the same moment is an ordinary UPDATE race. The later commit wins and the earlier one is overwritten with **no conflict reported**. There is no version column and no optimistic concurrency check |
| **Why it is not the review problem** | A review resolution has two managers racing as the EXPECTED case, which is why ADR-004 and the conditional UPDATE exist. A policy edit is an infrequent, deliberate act by a colleague. Adding a version column here would be machinery for a race nobody has |
| **Likelihood** | Low - it needs two managers of the same company editing within seconds |
| **Impact** | Medium - a silently reverted setting, discovered only by looking |
| **Severity** | **Low** |
| **Mitigation** | The save sends a PATCH of **only the fields that changed**, so editing the limit cannot revert a category somebody else added. The window narrows from the whole policy to one field |
| **What IS guaranteed** | A submitting expense always reads one internally consistent policy row and snapshots the object it evaluated against, so an edit landing mid-submission happened either before that read or after it - never half of it |
| **Residual hole** | No conflict detection. An `updatedAt` precondition on the PATCH is the upgrade path |
| **Automated verification** | None - there is no conflict behaviour to assert |
| **Manual verification** | Step 16 of the F07 manual cycle |
| **Status** | `ACCEPTED` - stated rather than implied to be handled |

**F09 re-review against the original assessment.** Section 6 asks that a
manager "edits the company's policy settings". It says nothing about
concurrent editing, and nothing in sections 2-8 requires conflict detection
for it - unlike section 5, which explicitly requires that two managers
resolving the same review produce exactly one winner and that the other "is
told clearly". The asymmetry in this codebase matches the asymmetry in the
brief. **No version column was added.** What F09 did verify is the guarantee
that actually matters for correctness: an expense is judged against **one
internally consistent policy row**, and changing the policy afterwards leaves
the historical decision, its snapshot, its rule hits and any human resolution
untouched - measured in the end-to-end cycle (P1-P5, including a replayed
idempotent retry that still returns the ORIGINAL decision after the limit was
raised).

### R-32 - A newly created company has no manager

| | |
|---|---|
| **Component** | `CompanyAdminService.create` |
| **Description** | Company creation makes the company, its policy and its first API key (assumption A5), but **no manager account**. The company can submit expenses immediately and nobody can sign in to review the ones the policy flags, so they accumulate |
| **Why it was not built** | The two options are both worse than the gap. Inventing a password means a predictable or exposed credential; an invitation flow means email delivery, token lifetimes and a password-reset path - a subsystem the assessment does not ask for |
| **Likelihood** | Certain for every company created this way |
| **Impact** | Medium - flagged expenses sit unresolved until a manager is provisioned by other means |
| **Severity** | **Medium** |
| **Mitigation** | **Surfaced, not hidden.** The company detail page opens with a warning stating the company has no manager, what that means, and that it is not automated. The API returns `managerCount` so the condition is machine-readable too |
| **Residual hole** | Provisioning happens outside the application. The schema already supports several managers per company (A6), so the endpoint is a small addition when a credential-delivery mechanism exists |
| **Automated verification** | F08-B05 asserts `managerCount: 0` on a newly created company - the limitation is pinned rather than incidental |
| **Manual verification** | Step 8 of the F08 manual cycle |
| **Status** | **`CLOSED` in F11.** See below |

**F11 - closed, with evidence.** The gap is gone rather than better
documented. `POST /v1/admin/companies/:companyId/managers` creates a manager
account, and the company detail page has a Managers panel that lists them and
adds one.

What makes this a closure rather than a smaller version of the same hole:

| The old objection | What was actually built |
|---|---|
| "Inventing a password means a predictable or exposed credential" | **Nothing is invented.** The administrator chooses the initial password and hands it over themselves. The response carries no credential at all - there is nothing to leak into a log, a proxy or a devtools panel |
| "An invitation flow is a subsystem the assessment does not ask for" | None was built. No email, no tokens, no reset path - and the UI says so plainly rather than implying a reset link exists |

- **Closing claim, verified:** F11-T22 creates a manager through the API, signs
  in as that account, submits an expense through the company's own key, and
  resolves the review it opens - asserting in PostgreSQL that
  `resolvedByUserId` is the account that did not exist when the test started.
- **Privilege escalation refused:** `role` and `companyId` are written by the
  server and are absent from a `.strict()` schema, so a body claiming
  `PLATFORM_ADMIN` or another tenant is a 400 that creates nothing (F11-T10,
  F11-T11). A provisioned manager cannot provision further managers (F11-T16b).
- **Still deliberately absent:** deletion, deactivation, a role editor,
  password reset, transfer between companies, and creating another platform
  administrator. Each is a wider authority than "set this company up".
- **New limitation, recorded as R-36:** there is no way to change or reset a
  manager's password in the application.

The F09 note below is kept as the record of what the scope was before, and why
the earlier answer was defensible rather than lazy.

**F09 re-review against the original assessment.** Section 2 asks for **two
seeded companies**, a manager for each and a platform admin; section 6 asks
that the admin panel let the platform admin "see all companies, creates new
ones and manages their API keys". Creating manager accounts is not among
them, and the seeded managers that section 2 does require exist. So the scope
stands and **no user-management subsystem was built**. What F09 added is a
documented, test-only provisioning recipe in the README, so a reviewer who
wants to drive a *newly created* company through the manager flow can, without
the application ever inventing a password.

### R-33 - API key issuance is not idempotent

| | |
|---|---|
| **Component** | `ApiKeyAdminService.issue`, `.rotate`, `CompanyAdminService.create` |
| **Description** | Each of these mints a credential and returns it once. A retried request mints **another**. If the response is lost in transit, a key exists that nobody has seen the value of and nobody knows to look for |
| **Why there is no idempotency key** | F03 solved exactly this for expenses with a caller-supplied `externalId` and a payload hash. It could be done here - but the caller is a human in a browser, not a retrying backend, and the recovery is cheap and visible: the orphan key appears in the list and can be revoked |
| **Likelihood** | Low - a dropped response on a short administrative request |
| **Impact** | Medium - an active credential nobody is tracking is exactly what revocation exists for |
| **Severity** | **Low** |
| **Mitigation** | Every mutation sets `retry: false`, so the client never produces a duplicate on its own. The key list shows every key with its state, so an orphan is **visible** rather than silent, and revocation is one click |
| **Residual hole** | An administrator must notice the extra row. There is no alert |
| **Automated verification** | None - the failure is a lost response, which the test harness cannot produce faithfully |
| **Manual verification** | Review the key list after any administrative action that appeared to fail |
| **Status** | `ACCEPTED` - with the recovery path named and made visible |

**F09 re-review.** The assessment's decision 6 asks how keys are stored and
what rotation looks like, not for idempotent issuance, so no idempotency
framework was built. The recovery workflow is now written down where somebody
would actually look - the README's key-management section - as four steps:
refresh the key list, identify the key nobody holds the value of (it is the
newest `ACTIVE` row the administrator did not record), revoke it, issue a
replacement deliberately. F09 re-confirmed the property that makes this safe:
every secret-returning mutation carries `retry: false`, so an ambiguous
network failure cannot mint a second credential by itself.

### R-34 - The Origin check refuses a different spelling of the same host

| | |
|---|---|
| **Component** | `CsrfGuard`, `APP_ORIGIN` |
| **Description** | The server-side `Origin` check compares the header **exactly** against `APP_ORIGIN`. A browser pointed at `http://127.0.0.1:3000` sends that spelling, which does not equal `http://localhost:3000`, so every state-changing request - login included - is refused `403` with no explanation a reviewer could act on |
| **How it was found** | F09's own end-to-end harness used `127.0.0.1` and could not log in. The control was working; the harness was wrong |
| **Why the check is not relaxed** | Accepting "any loopback spelling" means parsing and classifying the Origin instead of comparing it. An exact comparison is the property that makes this layer worth having, and the F02 negative control depends on it |
| **Likelihood** | Low - the README names the URL |
| **Impact** | Low - a confusing refusal, not a security hole |
| **Severity** | **Low** |
| **Mitigation** | The README's quick start now says which origin to open and that `APP_ORIGIN` must match it, with the symptom named so it is recognisable |
| **Automated verification** | F02-T30-live asserts a foreign Origin is refused |
| **Status** | `ACCEPTED` - documented where a reviewer will hit it |

### R-36 - A manager's password cannot be changed in the application

| | |
|---|---|
| **Component** | `ManagerAdminService`, and the absence of anything else |
| **Description** | An administrator sets a manager's initial password at creation. After that there is **no way to change it** - no self-service change, no administrator reset, and no forced change on first sign-in. The account keeps the password it was created with until somebody writes a new hash by hand |
| **Why it was not built** | A reset path needs either email delivery with token lifetimes, or an administrator-set replacement - and the second is a route that overwrites a credential, which deserves the same care as issuing one. Neither is asked for by the assessment, and F11's scope is "a company can be set up end to end", not "accounts can be administered" |
| **Likelihood** | Certain, for any account whose password needs changing |
| **Impact** | Low here - these are demonstration accounts on a local deployment. In a real deployment it would be **High**, because a password known to have leaked could not be replaced |
| **Severity** | **Low** in this deployment, stated honestly rather than scored by its worst case |
| **Mitigation** | **Said out loud in the interface.** The success panel after creating a manager states that nothing is emailed, that there is no reset link, and that the person cannot change it in the application. The code's comments say the same, so nobody reads the absence as an oversight |
| **Residual hole** | The whole of it. This is an accepted gap, not a mitigated one |
| **Automated verification** | None, deliberately - there is no behaviour to assert. The absence is documented, and F11-T13 pins the related property that no response ever carries a password or a hash |
| **Status** | `ACCEPTED` - scoped out, stated where a person sees it |

### R-35 - Webhook signing secrets are encrypted, not hashed

| | |
|---|---|
| **Component** | `WebhookIntegration`, `webhook-crypto.ts` |
| **Description** | Every other credential in this system is stored as a one-way hash. A webhook signing secret cannot be: HMAC verification needs the **key material**, because the provider sends a MAC computed with the secret rather than the secret itself. There is no digest that can stand in - HMAC keyed with `sha256(secret)` is a different function and would never match. So the secret is stored **reversibly** |
| **What protects it** | AES-256-GCM, with the key in `WEBHOOK_ENCRYPTION_KEY` - process configuration, never the database. A stolen dump is inert on its own; an attacker needs both. GCM is authenticated, so a tampered row fails to decrypt rather than silently yielding a different key, and the **company id is the additional authenticated data**, so a secret moved between rows fails too (F12-U13, F12-U14) |
| **Likelihood** | Not an event - it is a property of the design, present from the first deployment |
| **Impact** | High **if both** the database and the configuration are compromised: an attacker could forge signed events as any company. Each of those alone yields nothing usable |
| **Severity** | **Medium** - the impact is high, the precondition is two independent compromises rather than one |
| **Mitigation** | The key is required in every environment with no default, so a deployment that forgets it refuses to start rather than falling back to something weak. The compose file's development key is labelled as such in place. `F12-T03` asserts no plaintext is in the column; `F12-T02` asserts no response carries the secret, the ciphertext, the IV or the tag |
| **Residual hole** | The whole of it, by construction. The correct production answer is an external KMS or HSM, where the key never enters the application process at all - an entire subsystem the assessment does not ask for |
| **Status** | `ACCEPTED` - stated as weaker than hashing rather than presented as equivalent |

### R-37 - The retry backoff has no jitter, and there is one worker

| | |
|---|---|
| **Component** | `WebhookProcessorService.backoffMs`, `WebhookWorkerService` |
| **Description** | Failed events back off exponentially - 2s, 4s, 8s, 16s, 32s, capped at five minutes - with **no randomisation**. A thousand events failing together would retry together. The worker also runs inside the API process rather than separately, so queue work competes with request handling |
| **Why it is acceptable here** | Jitter spreads a herd. With one worker, a `BATCH_SIZE` of 20 and an inbox measured in tens of rows, the herd does not exist - the claim loop already serialises the retries it issues. Adding jitter would be machinery for a contention pattern this deployment cannot produce |
| **Likelihood** | Only at a volume this deployment does not see |
| **Impact** | Low here. At scale, a synchronised retry storm against a database that is already struggling - which is how a brief outage becomes a long one |
| **Severity** | **Low** |
| **Mitigation** | Attempts are bounded (`WEBHOOK_MAX_ATTEMPTS`), the batch is bounded, and the poll interval has a floor so a misconfiguration cannot busy-loop |
| **Upgrade path** | Full jitter on the backoff, and the worker as its own process reading the same table - which needs no code change, because the claim is already safe for several workers (F12-T73) |
| **Status** | `ACCEPTED` - a scale limitation, named rather than designed around prematurely |

### R-38 - An event the provider never delivered leaves no trace

| | |
|---|---|
| **Component** | The absence of a reconciliation path |
| **Description** | The assessment asks how you would find events the provider never sent. **This system cannot, on its own.** An event that never arrived leaves nothing here, and nothing in this repository reconciles against the provider |
| **Why it was not built** | It needs a provider API that this integration does not have - a "list transactions in a window" endpoint - and inventing one would be fabricating a contract |
| **Likelihood** | Certain over a long enough period. Providers drop deliveries |
| **Impact** | Medium - an expense that was never submitted is silently missing. Nothing is wrong; something is absent, which is harder to notice |
| **Severity** | **Medium** |
| **Mitigation** | None implemented. The gap is **answered in full** in the README and in [F12-card-webhook.md](../features/F12-card-webhook.md) §9, with the three approaches ranked by cost: an id-gap check (only if ids are sequential, which the assessment's `evt_8f2c1` gives no reason to think), a reconciliation job against a provider listing API (the real answer), and a liveness alert on companies that have gone quiet (cheap, weak, genuinely useful) |
| **Status** | `ACCEPTED` - an explained gap, which is what the assessment asks for here rather than an implementation |

### R-39 - The dashboard could be framed by any origin

> Raised and closed in F13, from the QA regression pass (MIN-01). It had never
> been written down, which is the part worth admitting: R-18 accepted the
> absence of a Content-Security-Policy but said nothing about clickjacking, so
> this was not a trade-off anybody had weighed.

| | |
|---|---|
| **Component** | Browser session security, web tier |
| **Description** | Neither tier sent `X-Frame-Options` or a `frame-ancestors` directive, so any page anywhere could load the dashboard in an invisible iframe and sit a decoy over a real control |
| **Why it mattered here specifically** | The session cookie is `SameSite=Lax`. That blocks a cross-site **POST**, but not a framed top-level **GET** - the frame loads fully authenticated. And the application has one-click state-changing confirmations: approving or rejecting an expense is a click behind a dialog, which is the exact target shape this attack is built for |
| **Likelihood** | Low - it needs the victim signed in and on the attacker's page |
| **Impact** | Medium - an approval or rejection the manager did not intend, with their name on the audit record |
| **Severity** | Medium |
| **Mitigation** | **Implemented in F13.** The web tier sends `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` on every route. They agree deliberately: the application is never framed by anything, so the strictest value costs nothing, and the older header is kept for the browsers that read only it |
| **Automated verification** | None. This is a header assertion, and it is verified by request rather than by suite - see the manual row |
| **Manual verification** | `curl -D -` against the running web tier, F13 |
| **Status** | `MITIGATED` - verified by response header |
| **What it does NOT close** | R-18. Script already running inside the page is unaffected by who is allowed to frame it |

### R-40 - Both tiers disclosed their framework

| | |
|---|---|
| **Component** | Response headers, both tiers |
| **Description** | `X-Powered-By: Express` and `X-Powered-By: Next.js` on every response, including to unauthenticated callers |
| **Likelihood** | Certain - it was on every response |
| **Impact** | Low - it names which CVE list to start from. It is reconnaissance, not a vulnerability |
| **Severity** | **Low** |
| **Mitigation** | **Implemented in F13:** `disable('x-powered-by')` on the Express instance, `poweredByHeader: false` in the Next config. Two further headers were added in the same pass: `X-Content-Type-Options: nosniff`, and `Referrer-Policy: strict-origin-when-cross-origin` so that expense and review ids travelling in paths are not sent to third-party origins in a `Referer` |
| **Honest limit** | **This is hygiene, not defence.** An attacker who cares can fingerprint the stack from error shapes and header ordering regardless. It was removed because it gave something away for no benefit, and its absence is not claimed as a control |
| **Automated verification** | None - verified by request |
| **Manual verification** | `curl -D -` against both tiers, F13 |
| **Status** | `MITIGATED` |

## Summary

| Severity | Open | In progress | Mitigated | Accepted |
|---|---|---|---|---|
| Critical | - | - | R-01, R-02, R-03, R-05, R-10, R-21 | R-20 |
| High | R-06, R-15 | - | R-04, R-07, R-08, R-12, R-14 | R-18, R-24, R-26 |
| Medium | R-13 | - | R-16, **R-39** | R-11, R-17, R-19, R-22, R-23, R-25, R-27, **R-35**, **R-38** |
| Low | - | - | **R-29**, **R-40** | R-09, R-28, R-30, R-31, **R-33**, **R-36**, **R-37** |

**Closed:** R-32, by F11. It is no longer an accepted limitation - the gap it
described does not exist any more, and the evidence is named in its entry.

## Review log

| Date | Trigger | Changes |
|---|---|---|
| 2026-11-19 | Initial architecture planning | R-01 to R-06 raised |
| 2026-11-19 | Architecture review by the project owner | R-07 to R-13 added |
| 2026-11-19 | F00 completed | R-14 added (realised during implementation). R-05 and R-12 moved to `MITIGATED` with named evidence. R-07, R-08 and R-10 moved to `IN PROGRESS` |
| 2026-11-19 | Automated security review of the F00 commit | R-16 added and mitigated: all published ports bound to `127.0.0.1` |
| 2026-11-20 | Automated security review of commit c7a024b | R-21 raised and mitigated: the seed could restore revoked credentials on any container restart |
| 2026-11-20 | F02 completed | R-18, R-19 and R-20 added and accepted. R-01, R-07 and R-08 moved to MITIGATED with named F02 evidence; R-01 keeps an explicit re-verification requirement for F03, F05 and F08 |
| 2026-11-20 | F01 completed | R-17 added and accepted. R-01 and R-03 moved to `IN PROGRESS` with named F01 evidence. R-05 re-verified now that migrations and a seed actually run. R-04 and R-08 gained supporting evidence |
| 2026-11-20 | F02.1 completed | R-22, R-23 and R-24 added and accepted. R-22 records a stopping point on the credential redactor with its gaps stated in the code; R-24 names the risk that frontend route protection is misread as enforcement |
| 2026-11-20 | F03 completed | R-25, R-26 and R-27 added and accepted. R-03 moved to `MITIGATED` with named F03 evidence; R-02 and R-10 keep explicit re-verification requirements for F04 |
| 2026-11-20 | F04 completed | R-02 moved to `MITIGATED` with measured evidence (F04-T26 and the F04-NC1 negative control). R-10 moved to `MITIGATED`: both concurrency features now ship a control that fails when the mechanism is removed. **R-11 stays ACCEPTED** - the advisory lock does not address out-of-order evaluation and is not claimed to. R-26 re-checked: the canonicalisation contract is unchanged, `normaliseCategory` being an extraction guarded by the pinned string test |
| 2026-11-20 | F05 completed | R-04 moved to `MITIGATED` with measured evidence (F05-T31, T33, T44 and the F05-NC1 negative control, with lock contention confirmed through `pg_blocking_pids()`). R-11 re-checked and left `ACCEPTED` - nothing in F05 touches out-of-order evaluation. R-27 re-checked: review resolution performs no deletes, and `Review -> Expense` is `onDelete: Restrict`, so a resolved review makes its expense harder to delete rather than easier |
| 2026-11-20 | F06 completed | R-28 and R-29 added and accepted, both naming their upgrade path. R-01 re-verified on three new read endpoints with a negative control (F06-NC1) that fails when the tenant predicate is removed. R-23 re-checked and left **ACCEPTED**: no DOM test runner was added, so frontend interaction scenarios remain browser-verified and are marked as such rather than as PASS. R-25 gained direct evidence - `formatMoney` is unit-tested at the top of the int4 range. R-24 re-checked: the new pages still enforce nothing, and every refusal is the API's (F06-T07 to T10) |
| 2026-11-21 | F06 closure | **R-29 moved to `MITIGATED`**: the category filter now reads the company's whole vocabulary from `GET /v1/dashboard/expense-categories`, bounded at 200 and flagging truncation, verified by F06-T51 to T55. R-28 stays `ACCEPTED` but the control no longer mislabels itself. **R-30 added and accepted** after analysing the dependency path rather than the audit count. R-23 re-checked and unchanged: the three remaining browser-only rows (T35, T45, T46) were executed and all three found real defects, which is evidence for the risk rather than against it |
| 2026-11-21 | F07 completed | **R-31 added and accepted**: concurrent policy edits are last-write-wins, narrowed to the changed field by sending a partial PATCH. R-01 re-verified on the two policy endpoints (F07-B08 to B12). R-04 re-checked: F07 added no resolution path of its own and ADR-004 semantics are unchanged - the conflict case is now exercised through the UI with two independent sessions (F07-F10). R-23 unchanged: the resolution and policy flows are browser-verified and recorded as such |
| 2026-11-21 | F08 completed | **R-32 and R-33 added and accepted**, both surfaced in the interface rather than only in this register. R-08 (API key handling) moved to `MITIGATED` with measured evidence: the plaintext appears nowhere in the table (F08-B20), no response carries a hash (F08-B22), the lifecycle is enforced inside the authentication WHERE clause (F08-B29 to B31, B36), and two concurrent rotations produce exactly one winner (F08-B34). R-01 re-verified on the one module that is deliberately NOT tenant-scoped: the company id is a selector applied after the role check, and a mismatched company/key pair mutates nothing (F08-B32, B38) |
| 2026-11-21 | F11 completed | **R-32 CLOSED**, not re-accepted: manager provisioning exists, and F11-T22 proves it by signing in as an account created through the API and resolving a real review. **R-36 added and accepted** - the gap F11 deliberately did not close, which is password change and reset. R-01 re-verified on the two new routes: `role` and `companyId` are written by the server and absent from a `.strict()` schema, so a body claiming either is a 400 that creates nothing (F11-T10, F11-T11), and a provisioned manager can reach neither another company's data nor platform administration (F11-T16, F11-T16b) |
| 2026-11-21 | F12 completed | The assessment's optional card webhook bonus. **R-35, R-37 and R-38 added and accepted**, each naming what it costs rather than what it avoids: a signing secret that must be reversible because HMAC needs key material, a backoff with no jitter at a scale that has no herd, and the absence of any way to find an event the provider never sent. R-01 re-verified on an entirely new authentication path: the company comes from the integration whose secret verified the signature, the body has no company field to ignore, and an attacker naming another company's delivery id is checked against a secret they do not hold (F12-T17, F12-T40 to T42, F12-T90). R-22 (the credential redactor) gained a new consumer - the worker's `lastError` is sanitised where it is written, because it is rendered in an administrator's browser (F12-T80) |
| 2026-11-21 | F13 QA regression pass | An independent black-box pass over the merged build found **no functional defect** and six minor findings. Two were previously unrecorded security-hygiene gaps and are now entries of their own: **R-39 added and MITIGATED** (the dashboard could be framed by any origin - raised because R-18 accepted the absence of a CSP but never mentioned clickjacking, so nobody had weighed it) and **R-40 added and MITIGATED** (both tiers disclosed their framework). **R-11 was widened, not re-accepted**: its scope was understated as back-dating when the same hole opens on an ordinary concurrent burst, and F04-T26b now pins the invariants that hold on every interleaving. R-18 re-checked and left `ACCEPTED`, with an explicit note that the new `Content-Security-Policy` header carries only `frame-ancestors` and does nothing for script injection. R-19 re-tested and unchanged: 15 consecutive wrong passwords, no throttling |
