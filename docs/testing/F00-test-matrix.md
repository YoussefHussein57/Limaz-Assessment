# F00 test matrix

**Executed:** 2026-11-19
**Command:** `bash scripts/verify-f00.sh` and `npm test --workspace @limaz/api`
**Environment:** Windows 11, Docker 29.5.3, Compose v5.1.4, Node 22.20.0,
PostgreSQL 17-alpine

**Result: 18 of 18 acceptance checks PASS, 13 of 13 automated tests PASS.**

> F09 split F00-T04 into T04 and T04b after finding the original had been
> failing since F02.1 (AI_LOG 45). The script has been re-run in full since.

Nothing in this document is marked PASS without an actual execution behind it.

---

## Acceptance checks

### F00-T01 - Full stack starts from a cold state

| | |
|---|---|
| **Preconditions** | Docker running; `cp .env.example .env`; no containers or volumes from a previous run |
| **Steps** | `docker compose down -v` then `docker compose up -d --build`, poll each container's health |
| **Expected** | `db`, `api` and `web` all reach `healthy` within 300s |
| **Verification** | `docker inspect --format '{{.State.Health.Status}}'` per container |
| **Type** | Automated (scripted) |
| **Actual** | All three reached `healthy` |
| **Status** | **PASS** |

### F00-T02 - Health endpoint reflects real database state

| | |
|---|---|
| **Preconditions** | F00-T01 passed |
| **Steps** | `curl http://127.0.0.1:3001/health` |
| **Expected** | `200`; `status: ok`; `checks.database.status: up`; numeric `latencyMs` |
| **Verification** | HTTP status and response body assertions |
| **Type** | Automated |
| **Actual** | `200` with `{"status":"ok","uptimeSeconds":N,"checks":{"database":{"status":"up","latencyMs":2.57}}}` |
| **Status** | **PASS** |

### F00-T02b - Health endpoint leaks no connection string

| | |
|---|---|
| **Preconditions** | F00-T02 returned a body |
| **Steps** | Search the response body for `postgresql://` |
| **Expected** | Absent. Prisma connection errors embed the password, so the error path returns a generic `"database unreachable"` and logs the detail server-side only |
| **Verification** | String search; plus `health.unit.spec.ts` for the database-down path |
| **Type** | Automated |
| **Actual** | Not present |
| **Status** | **PASS** |

### F00-T03 - API waited for the database rather than crash-looping

| | |
|---|---|
| **Preconditions** | F00-T01 passed |
| **Steps** | `docker inspect --format '{{.RestartCount}}'` on the api container |
| **Expected** | `0`. `depends_on: condition: service_healthy` must hold the API back until `pg_isready` succeeds |
| **Verification** | Restart counter |
| **Type** | Automated |
| **Actual** | `0` |
| **Status** | **PASS** |

### F00-T03b - Entrypoint migration and seed steps run

| | |
|---|---|
| **Preconditions** | F00-T01 passed |
| **Steps** | `docker compose logs api`, search for the entrypoint's migration line |
| **Expected** | `no migrations present - skipping (expected in F00)`. The steps execute now even though they are no-ops, so F01 only has to supply the files |
| **Verification** | Log search |
| **Type** | Automated |
| **Actual** | Line present |
| **Status** | **PASS** |

### F00-T04 - The web root sends an anonymous visitor to the login page

| | |
|---|---|
| **Preconditions** | F00-T01 passed |
| **Steps** | `curl -s -o /dev/null -w '%{http_code} %{redirect_url}' http://127.0.0.1:3000/` |
| **Expected** | A redirect (`307`) to `/login` |
| **Verification** | HTTP status and `Location` |
| **Type** | Automated |
| **Actual** | `307` → `http://127.0.0.1:3000/login` |
| **Status** | **PASS** |

> **Rewritten in F09.** This originally asserted `200 text/html` on `/`, which
> was true until F02.1 turned the root into a server-side redirect - to the
> role's workspace when signed in, to `/login` when not. From that commit the
> check compared `307` against `200` and **failed**, and nothing ran it again
> for six features (AI_LOG 45). It now asserts the real contract, and
> F00-T04b covers the page the redirect lands on.

### F00-T04b - The login page itself is served

| | |
|---|---|
| **Preconditions** | F00-T04 passed |
| **Steps** | `curl -s -o /dev/null -w '%{http_code} %{content_type}' http://127.0.0.1:3000/login` |
| **Expected** | `200` with `content-type: text/html` |
| **Verification** | HTTP status and content type |
| **Type** | Automated |
| **Actual** | `200 text/html; charset=utf-8` |
| **Status** | **PASS** |

### F00-T05 - Same-origin proxy reaches the API

| | |
|---|---|
| **Preconditions** | F00-T01 passed |
| **Steps** | `curl -D - http://127.0.0.1:3000/api/health` |
| **Expected** | `200` with the same body shape the API returns directly |
| **Verification** | Status line and body assertions |
| **Type** | Automated |
| **Actual** | `200` with `status: ok` and the database check |
| **Status** | **PASS** (failed on the first two runs - see "Defects found" below) |

### F00-T05b - No CORS header is present

| | |
|---|---|
| **Preconditions** | F00-T05 returned headers |
| **Steps** | Search response headers for `access-control-allow-origin` |
| **Expected** | Absent. Its presence would prove the deployment is not actually same-origin, which would force `SameSite=None` and disable CSRF protection (ADR-008, risk R-12) |
| **Verification** | Header search |
| **Type** | Automated |
| **Actual** | Not present |
| **Status** | **PASS** |

### F00-T06 - Invalid configuration fails fast

| | |
|---|---|
| **Preconditions** | `apps/api/dist/main.js` exists |
| **Steps** | `cd apps/api && env -u DATABASE_URL NODE_ENV=production node dist/main.js` |
| **Expected** | Non-zero exit; the message names `DATABASE_URL`; the variable's value is never printed |
| **Verification** | Exit code and stderr |
| **Type** | Automated |
| **Actual** | Exit `1`, with: `[config] Refusing to start. Invalid environment configuration: - DATABASE_URL: DATABASE_URL is required` |
| **Status** | **PASS** |

### F00-T06b - A readable config error, not a stack trace

| | |
|---|---|
| **Preconditions** | F00-T06 ran |
| **Steps** | Search the output for stack-trace markers (`at Object.`, `node_modules`) |
| **Expected** | Absent |
| **Verification** | String search |
| **Type** | Automated |
| **Actual** | No stack trace |
| **Status** | **PASS** |

### F00-T07 - No secrets tracked by git

| | |
|---|---|
| **Preconditions** | Repository initialised |
| **Steps** | `git check-ignore` for `.env`, `apps/api/.env`, `node_modules`; `git ls-files --error-unmatch .env` |
| **Expected** | All ignored; no env file tracked |
| **Verification** | Exit codes of the git commands |
| **Type** | Automated plus a manual review of staged files before each commit |
| **Actual** | All ignored; nothing tracked |
| **Status** | **PASS** |

### F00-T08 - Lint

| | |
|---|---|
| **Preconditions** | `npm ci` done |
| **Steps** | `npm run lint` |
| **Expected** | Exit `0`, zero errors |
| **Verification** | Exit code |
| **Type** | Automated |
| **Actual** | Exit `0` |
| **Status** | **PASS** |

### F00-T09 - Typecheck

| | |
|---|---|
| **Preconditions** | `npm ci` done; Prisma client generated |
| **Steps** | `npm run typecheck` |
| **Expected** | Exit `0` for both workspaces under `strict: true` |
| **Verification** | Exit code |
| **Type** | Automated |
| **Actual** | Exit `0` |
| **Status** | **PASS** |

### F00-T10 - Repeated cold start is idempotent

| | |
|---|---|
| **Preconditions** | A stack already ran once |
| **Steps** | `docker compose down -v` then `docker compose up -d`, twice in succession |
| **Expected** | Both runs reach `healthy`; no failure from leftover volume state |
| **Verification** | Health status after each run |
| **Type** | Automated |
| **Actual** | Both runs healthy |
| **Status** | **PASS** |

### F00-T11 - Build emits its artefacts

| | |
|---|---|
| **Preconditions** | `npm ci` done; stale `*.tsbuildinfo` removed |
| **Steps** | `npm run build`, then assert `apps/api/dist/main.js` and `apps/web/.next` exist |
| **Expected** | Exit `0` **and both artefacts present** |
| **Verification** | Exit code plus file existence |
| **Type** | Automated |
| **Actual** | Exit `0`, both present |
| **Status** | **PASS** |

> **Why this test checks artefacts and not only the exit code:** during F00,
> `nest build` exited `0` while emitting nothing at all. See "Defects found".

### F00-T11b - A repeated build still emits output

| | |
|---|---|
| **Preconditions** | F00-T11 passed |
| **Steps** | Run `npm run build --workspace @limaz/api` again immediately; assert `dist/main.js` still exists |
| **Expected** | Present |
| **Verification** | File existence |
| **Type** | Automated |
| **Actual** | Present |
| **Status** | **PASS** |

### F00-T12 - No secrets or stale caches in the image

| | |
|---|---|
| **Preconditions** | API image built |
| **Steps** | Run a shell in the image and check for `dist/main.js`, `apps/api/.env`, any `*.tsbuildinfo`, and the effective user |
| **Expected** | Application present; **no `.env`**; no stale cache; running as `node`, not `root` |
| **Verification** | `ls`, `find`, `id -un` inside the container |
| **Type** | Automated |
| **Actual** | `dist/main.js` present; `.env` absent; no `tsbuildinfo`; user `node` |
| **Status** | **PASS** |

---

## Automated test suite

```
npm test --workspace @limaz/api

Test Suites: 3 passed, 3 total
Tests:       13 passed, 13 total
Time:        5.693 s
```

| Suite | Tests | Covers |
|---|---|---|
| `test/env.spec.ts` | 9 | Config validation: defaults, missing and malformed variables, all problems reported at once, and that an error never echoes a variable's value |
| `test/health.unit.spec.ts` | 2 | Database-down path: `503`, and that the driver error and embedded password never reach the response |
| `test/health.e2e-spec.ts` | 2 | Real PostgreSQL round trip through the full Nest application, and that the response carries no connection string |

Run the e2e suite with the database available:

```bash
docker compose up -d db
npm test --workspace @limaz/api
```

The test setup resolves `DATABASE_URL` from an explicit variable, then
`apps/api/.env`, then the documented local default on host port 5433, so no
extra step is needed on a fresh clone.

---

## Defects found and fixed during F00

Four real defects. Each was found by a test, not by inspection.

### D-1 - `.env` copied into the Docker image (security)

`.dockerignore` listed `.env`, which matches only at the context root.
`apps/api/.env` was therefore copied into an image layer by
`COPY apps/api apps/api`.

**Found by:** inspecting the build-stage image while diagnosing D-2.
**Fixed by:** adding `**/.env` and `**/.env.*` patterns.
**Guarded by:** F00-T12.
**Risk:** R-08.

### D-2 - Build exited 0 while emitting nothing

`nest-cli.json` sets `deleteOutDir: true` and `tsconfig.build.json` had
`incremental: true`. `dist/` was deleted, then tsc consulted
`tsconfig.build.tsbuildinfo`, concluded nothing had changed, and emitted
nothing - **while exiting 0**. The Docker image then failed at
`COPY /app/apps/api/dist`. The same silent failure occurred locally.

**Found by:** the Docker build failing on a missing `dist`, then reproduced on
the host.
**Fixed by:** `incremental: false` in `tsconfig.build.json`, plus `**/*.tsbuildinfo`
in `.dockerignore`.
**Guarded by:** F00-T11 and F00-T11b, which assert artefacts rather than exit codes.
**Risk:** R-14.

### D-3 - A build failure masked by D-1

Once the `.env` leak was fixed, `prisma generate` began failing with
`PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL`. The
leaked `.env` had been silently supplying it. `prisma generate` needs no
database, but Prisma's `env()` helper resolves eagerly at config load.

**Found by:** the Docker build failing immediately after D-1 was fixed.
**Fixed by:** attaching `datasource` in `prisma.config.ts` only when
`DATABASE_URL` is present.
**Guarded by:** F00-T01, which builds the image from a clean context.

> A security fix uncovered a correctness bug that had been hidden by the
> security hole. The leak was holding the build together.

### D-4 - Same-origin proxy baked the wrong destination

`rewrites()` in `next.config.ts` is resolved at **build** time and frozen into
`.next/routes-manifest.json`. The image builds without `INTERNAL_API_URL`, so
the destination was baked as `http://localhost:3001` - which, inside the web
container, is the web container. Every proxied request returned `500`.

**Found by:** F00-T05.
**Fixed by:** replacing the rewrite with a runtime route handler at
`app/api/[...path]/route.ts`, which reads the environment per request and
forwards `Set-Cookie` correctly via `getSetCookie()` - needed from F02.
**Guarded by:** F00-T05 and F00-T05b.
**Risk:** R-12.

---

## Not covered by F00

| Area | Lands in |
|---|---|
| Tenant isolation | F02 |
| Idempotency, including concurrent duplicates | F03 |
| Policy rules and decision precedence | F04 |
| Concurrent review resolution | F05 |
| Frequency evaluation under concurrency, with its negative control | F04 |
| Any UI behaviour beyond the placeholder page | F06 to F08 |
| Browser end-to-end tests | Deferred; see the README |
