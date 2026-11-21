# F09 - Integration, regression and security hardening

F09 adds **no features**. It executes the paths the earlier reports described
but had not run, and fixes what that found.

| | |
|---|---|
| Automated tests | **517** - 487 API in 34 suites, 30 web in 2 suites. Unchanged: no new feature, and the five defects are browser- and script-level |
| Acceptance scripts | F00 **18/18**, F01 **11/11**, F02 **16/16**, F02.1 **18/18** - all four run, from a destroyed and rebuilt volume |
| End-to-end business cycle | **79 checks, 0 failures**, against the running stack |
| Network-failure injection | **12 checks**, both failure modes, verified in PostgreSQL |
| Responsive measurement | **48 page/width measurements** on the nine screens, plus the long-content stress case. 0 px of horizontal overflow after one fix |
| Fresh installation | see section 8 |
| Defects found | **5** (AI_LOG 45-49) |

---

## 1. Baseline, discovered rather than assumed

The reported baseline was checked against the repository before anything else.

| Claim | Found |
|---|---|
| `f5d3d01` pushed, remote in sync, tree clean | **True** |
| 487 API tests in 34 suites | **True** |
| 30 web tests | **True** |
| `npm run verify` passes | **True** |
| F02 16/16, F02.1 18/18 | **True** |
| Docker healthy | **True** |
| *(not claimed)* F00 acceptance | **FAILING** - 16 passed, 1 failed, exit 1. Stale since F02.1 (AI_LOG 45) |

The report had quoted only the two scripts that were being run. F00 and F01
were treated as settled six features earlier.

---

## 2. F07-F13 - network failure recovery

The F07 report marked this PARTIAL: *"implemented and reachable; not injected
in the browser"*. It is now injected, with `window.fetch` patched in the real
page so the two failure modes are genuinely different events rather than two
mocked error codes.

### Scenario A - the request never reaches the server

```js
if (url.includes('/resolve') && method === 'POST') throw new TypeError('Failed to fetch');
```

| ID | Expectation | Result |
|---|---|---|
| F09-N01 | Exactly **1** resolve attempt, **0** requests sent | **PASS** - counted in the interceptor |
| F09-N02 | No false success - status still "Pending review" | **PASS** |
| F09-N03 | Recoverable feedback: *"The result is not confirmed …"* | **PASS** |
| F09-N04 | Review still `OPEN`, expense still `PENDING_REVIEW` **in PostgreSQL** | **PASS** - `psql`, both fixtures |
| F09-N05 | No automatic retry (`retry: false`) | **PASS** - 1 attempt, not 2 |
| F09-N06 | Both actions usable again | **FAIL, then PASS** - see AI_LOG 46 |

### Scenario B - the server commits and the answer is lost

```js
const r = await originalFetch(input, init);   // the server really does commit
throw new TypeError('Failed to fetch');       // the browser never sees it
```

| ID | Expectation | Result |
|---|---|---|
| F09-N07 | The request genuinely reached the server, which answered **200** | **PASS** - recorded before the throw |
| F09-N08 | **Exactly one** committed resolution | **PASS** - `count = 1` |
| F09-N09 | Reviewer is the authenticated manager, with a timestamp | **PASS** - `Nour Hassan`, `resolvedAt` set |
| F09-N10 | Original `decision` `REVIEW` preserved; `status` `REJECTED` | **PASS** |
| F09-N11 | The page reconciles to the real outcome and **offers no further action** | **PASS** - "Rejected by Nour Hassan", 0 resolve buttons |
| F09-N12 | Queue and dashboard refresh; the other review untouched | **PASS** - left the OPEN queue, "Rejected 3 · 1 rejected by a manager" |

Mocking an HTTP error would have proved none of N07-N10. The database is what
distinguishes the two scenarios, and it was read for both.

---

## 3. Tenant isolation and role boundaries, live

Executed against the running stack with the real seeded companies. Full table
in [endpoint-authorization.md](../security/endpoint-authorization.md).

| Group | Checks | Result |
|---|---|---|
| Cross-tenant reads and writes (T2-T5) | 4 | **PASS** - 404, and the target untouched |
| Manager refused administration (T6-T10) | 5 | **PASS** - 403 `insufficient_role`, nothing created |
| API key refused human routes (T11-T15) | 5 | **PASS** - 403 `caller_type_not_allowed` |
| Administrator refused company data (T16-T19) | 4 | **PASS** - 403 on expenses, reviews, policy, submission |
| Unauthenticated (T20) | 1 | **PASS** - 401 |
| Client-supplied identity (T21, T22) | 2 | **PASS** - **400**, the field is refused outright |
| CSRF (T23, T24) | 2 | **PASS** - missing header and foreign Origin both 403 |
| Session lifecycle (T25, T26) | 2 | **PASS** - logout 204, replay 401 |

The queries were read as well as the decorators: every company-scoped
statement in `apps/api/src` carries `companyId` inside its `where`, and the
two that do not are the administrator's deliberate cross-tenant listing and
the key lookup that establishes the tenant in the first place.

**A side finding worth recording.** The server-side `Origin` check compares
**exactly**: a browser at `http://127.0.0.1:3000` is refused `403` while
`http://localhost:3000` succeeds, because `APP_ORIGIN` names the latter. That
is the control working as designed, but a reviewer who types the wrong
spelling gets an unexplained refusal, so the README now says which URL to
open.

---

## 4. Server Component authorization

Both directions, read from the **RSC flight payload** rather than from what is
on screen.

| ID | Case | Result |
|---|---|---|
| F09-R01 | Manager requests `/admin` | Denial present; `Companies`, `Add a company`, `Delta Consulting` all **absent** |
| F09-R02 | Manager requests `/admin/companies/:id` (nested) | Same - the AI_LOG 44 fix holds one level down |
| F09-R03 | Administrator requests `/dashboard` | Denial present; `Total expenses`, `Recent expenses` **absent** |
| F09-R04 | …`/dashboard/expenses`, `/policy`, `/reviews`, `/expenses/:id` | Same on all four |
| F09-R05 | Direct navigation, not just a link | Same - every probe is a fresh request |

F09-R03 to R05 are new: before F09 those pages fetched first and reported the
API's 403 as *"The server did not answer"* (AI_LOG 47).

---

## 5. Authentication and session security

`verify-f02.sh` and `verify-f02-1.sh` re-run in full from a **destroyed and
rebuilt volume**: 16/16 and 18/18.

| Property | Evidence |
|---|---|
| Valid / invalid login, logout, replay after logout | F02-T20 to T20d, F09-E2E T25, T26 |
| Cookie flags survive the proxy | F02-T20b |
| No CORS header anywhere | F02-cors |
| Server-side Origin check | F02-T30-live |
| No credential in the container logs | F02-T24, T24b, T24c |
| Only hashes at rest | F02-T18-live |
| Cache isolation when the identity changes | `QueryProvider key={user.id}` (F06-T37); re-confirmed by switching manager → admin → manager in one browser during F09 |

Cookies are `Secure` in every environment, including development, because
Chrome and Firefox both treat `http://localhost` as a secure context. Making
the flag differ between environments is how production-only security bugs
happen.

---

## 6. Secret audit

Independent of the F08 report, and not trusting any filename.

| Check | Method | Result |
|---|---|---|
| Key-shaped strings in the working tree | `git grep -E 'lmz_[a-z]+_[A-Za-z0-9_-]{20,}'` | 19 matches in 11 files, **all seeded fixtures or negative-test values** |
| Key-shaped strings in **all** of git history | the same pattern over every commit in `git rev-list --all` | **The same 9 distinct values. No others, ever.** |
| Could any of them be a generated key? | A generated key is `lmz_<env>_` + **43** base64url characters = **51** characters exactly | The committed values are **43-47** characters and contain English words (`nile_`, `delta_`, `fake_`, `nope_`, `unknown_`). **None can be a generated credential** |
| Untracked and ignored files | every text file outside `node_modules` scanned for `lmz_[a-z]+_[A-Za-z0-9_-]{43}` | **0 matches** |
| `f08-key-reveal-redacted.png` | **the image was opened and looked at**, not trusted by its name | Shows `lmz_dev_•••••••• (redacted for documentation)`. No credential |
| `.env` | `git check-ignore` | ignored; `.env.example` is the only tracked one |
| `.agents/`, `.claude/`, `skills-lock.json` | `git check-ignore` | all ignored |

**What this does and does not establish.** There is **no evidence of a
committed credential**, and the length argument makes it structural rather
than a search that might have missed a pattern. The F08 incident key was
confirmed `REVOKED` in the database before its company was deleted. What
cannot be reconstructed here is whether the deleted intermediate file was ever
copied outside this repository; it never entered git history, and the company
it belonged to existed for about four minutes on a local database.

**The published fixtures are deliberate.** Two development API keys and three
passwords appear in the README, the seed and the acceptance scripts. They are
reachable only on a stack a reviewer runs themselves, the seed refuses to run
with `NODE_ENV=production` unless `SEED_DEV_DATA=true` is set explicitly, and
every one is documented as development-only. Removing them would make the
submission unrunnable.

---

## 6b. Secret-returning responses now say `no-store`

B8 asked for the cache headers on the issuance responses to be reviewed. They
carried **none at all**.

That is not a defect: a POST response is uncacheable by default - a shared
cache may only store one that carries explicit freshness information - and
F08-B26 asserted the absence of anything marking it storable. But the
assertion was passive, and these are the only three responses in the system
that ever return a plaintext credential.

| | Response | Before | After |
|---|---|---|---|
| F09-C01 | `POST /v1/admin/companies` | no `cache-control` | `no-store` |
| F09-C02 | `POST /v1/admin/companies/:id/api-keys` | no `cache-control` | `no-store` |
| F09-C03 | `POST /v1/admin/.../api-keys/:keyId/rotate` | no `cache-control` | `no-store` |

F08-B26 now asserts `no-store` on all three rather than the absence of
`public`. Measured through the Next proxy as well as directly on the API, so
the header survives the hop a browser actually takes.

---

## 7. Dependency review

`npm audit`: **22 findings - 3 high, 19 moderate.** Analysed rather than
silenced; `npm audit fix --force` was not run.

### The three high findings are one chain

```
prisma (devDependency) -> @prisma/config -> effect@3.20.0
```

GHSA-7589-6fvf-x4pw - ReDoS in `Schema.TemplateLiteral`'s compiled regex.

| Question | Measured answer |
|---|---|
| Does the **serving** process load it? | **No.** `npm ls effect` gives exactly one path, through the CLI. The API imports `@prisma/client` (23 times) and `@prisma/adapter-pg` (twice) and nothing else; neither depends on `effect`. `apps/api/dist/main.js` contains **0** references |
| Does **container startup**? | **Yes** - the entrypoint runs `prisma migrate deploy`, which loads `@prisma/config`. R-30 already said so; the F08 *summary* that called it "CLI tooling, not runtime" was the loose wording |
| Is the vulnerable function reachable? | **No.** `TemplateLiteral` appears **0 times** in `@prisma/config`; its only direct effect import is `effect/Function` |
| Is any input attacker-controlled? | **No.** The CLI's inputs are `prisma.config.ts` (in the repository) and `DATABASE_URL` (operator-supplied). The process exits before the API listens |

### Why no upgrade was applied

`@prisma/config@7.10.1` pins `effect` to **exactly** `3.20.0`. A patched
`3.22.5` exists, and an `overrides` entry is the obvious fix - **but npm
10.9.3 did not apply it**, with or without a scoped form, reporting "up to
date" and leaving `3.20.0` resolved. Making it take effect would mean deleting
and regenerating `package-lock.json`, re-resolving 907 packages three days
before the deadline, which trades a measured-unreachable advisory for a real
risk to the reproducible build. npm's own offer, `prisma@6.12.0`, is a major
**downgrade** that breaks ADR-009.

Recorded as **R-30**, `ACCEPTED`, with the exposure analysed rather than the
count dismissed. The remediation is a Prisma release that moves off the pinned
version.

### The nineteen moderate findings

All in the development toolchain - `jest` and `@nestjs/cli` reaching
`glob` (GHSA-3g3m-2fjr-6pw4) and `minimatch` (GHSA-g3hv-75wg-m249), both
denial-of-service classes against a local build. Neither is reachable from the
running service; npm's proposed fix is a major **downgrade** of Jest to 29.
Recorded with R-30.

**One thing worth saying plainly:** the production image keeps the full
dependency tree, because the entrypoint needs the Prisma CLI. So `jest`,
`@nestjs/cli` and `effect` are *present* in the image even though nothing runs
them. Pruning after migration would be the fix; it is named in the risk, not
claimed as done.

---

## 8. Fresh installation

A `git clone` of the committed repository into an empty directory, brought up
as an **isolated compose project** (`-p limaz-fresh`) on its own ports and its
own volume. The development stack was never touched.

See section 8 results in the F09 report. The documented command is exactly
what was run:

```bash
cp .env.example .env
docker compose up
```

(only the three host ports and `APP_ORIGIN` were edited, so the isolated run
could not collide with the development stack).

---

## 9. Performance

Measured, and labelled for what it is. One laptop, one API container, Docker
Desktop on Windows. **This is not a capacity measurement.**

### Query plans, at 4,212 rows

| Path | Plan | Buffers | Time |
|---|---|---|---|
| Expense listing, 26 rows | `Index Scan Backward using expenses_companyId_spentAt_idx` | 15 | **0.127 ms** |
| Frequency count | **`Index Only Scan using expenses_companyId_employeeId_spentAt_idx`** | **5** | **0.046 ms** |
| Dashboard aggregate | one `HashAggregate` over a seq scan, **one statement** | 110 | 1.47 ms |

The frequency count uses the three-column index exactly as designed. At **212**
rows the same query used the two-column index and filtered 190 rows, and the
listing seq-scanned - the planner being right about a table that fits in a
handful of pages. That pair is the honest answer to "is the index used": it is,
once the size makes it worth using.

The same explains `api_keys`: with two rows the planner reads the single heap
page rather than `api_keys_keyHash_key`. The O(log n) claim in ADR-006 rests on
the index, which is what the planner reaches for once the table grows - just
demonstrated on `expenses`.

### Latency smoke test

1,200 requests, concurrency 10, **0 errors**.

| Path | p50 | p95 | req/s |
|---|---|---|---|
| `GET /health` | 12 ms | 28 ms | 669 |
| `GET /v1/auth/me` (API key lookup) | 15 ms | 32 ms | 580 |
| `GET /v1/reviews?state=OPEN` | 46 ms | 89 ms | 198 |
| `GET /v1/dashboard/summary` | 53 ms | 92 ms | 176 |
| `GET /v1/expenses?limit=25` | 54 ms | 86 ms | 178 |
| `POST /v1/expenses` (lock, evaluate, write) | 59 ms | 84 ms | 161 |

The four manager reads go through the Next proxy, so they cross two Node
processes; the two API-direct paths do not, which is most of the difference.

**No N+1 was introduced**: the statement counts measured in F05 and F06 are
unchanged, and they are bounded by the query's shape rather than by the number
of rows.

---

## 10. Accessibility

Audited on every major screen by reading the live DOM, plus keyboard-only
journeys.

| Property | Result |
|---|---|
| Landmarks (`main`, `nav`, `banner`, `complementary`) | Present on every page |
| One `h1` per page, no skipped levels | **PASS** on all audited pages |
| Controls with an accessible name | **0 unnamed** across all pages |
| Form controls with a label | **0 unlabelled** |
| Table semantics | `<th scope>` on every header, table named |
| Visible focus indicator | `solid 1.6px rgb(37,99,235)` |
| Skip link, `lang` | Present |
| Keyboard-only login | **PASS** - focus order email → password → show → submit, Enter submits |
| Dialog | `role="dialog"`, labelled **and** described, focus moves inside, background `aria-hidden`, **Escape closes**, **focus returns to the trigger** |
| Error announcement | **Was silent on the resolve failure path.** Fixed (AI_LOG 46) |
| Reduced motion | Every keyframe cancelled under `prefers-reduced-motion` (F06) |

**Honest limits.** No conformance claim is made. Two inline text links on the
company detail page are 16px and 20px tall, below the 24×24 target size of
WCAG 2.5.8 - inline links in a sentence are exempt, and they are recorded here
rather than padded to hide the question. No screen-reader session with an
actual assistive technology was run; the live region is verified structurally.

---

## 11. Responsive

Every page rendered at its true width in an isolated frame, measuring
`scrollWidth - clientWidth`.

| Pages | 360 | 390 | 768 | 1024 | 1440 | 1920 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Overview, Expenses, Expense detail, Reviews, Review detail, Policy, Login | 0 | 0 | 0 | 0 | 0 | 0 |
| Admin companies, Company detail | 0 | - | 0 | - | 0 | - |

**48 measurements, 0 px of horizontal page overflow.**

### Long content

The stress input was changed from the F06 one, and that is what found AI_LOG 48.

| Input | Before | After |
|---|---|---|
| 200-character merchant (F06's case) | fixed in F06 | 0 |
| **64-character `externalId`, no break opportunity** | **192 px at 360, 129 px at 1440** | **0** |
| 36-character category | 7 px at 360 | 0 |
| 46-character employee id | included above | 0 |

---

## 12. What F09 did NOT do

| Not done | Why |
|---|---|
| Load or capacity testing | A laptop smoke test is not capacity. The scaling discussion in the README is architectural and says so |
| A screen-reader session | No assistive technology was driven. Structure is verified; the experience is not claimed |
| WCAG conformance audit | Specific criteria checked, no conformance claim |
| An automated DOM test runner | R-23 stands. The browser evidence is recorded as browser evidence |
| The `effect` upgrade | npm would not apply the override; regenerating the lockfile now is the larger risk (R-30) |
| Image pruning of dev dependencies | Named in R-30, not done |
| F10 work | Separate commit |
