# F00 - Project foundation

**Status:** Implemented, awaiting project-owner approval
**Date:** 2026-11-19
**Depends on:** nothing
**Blocks:** F01 (database and seed)

## Objective

A reviewer with no prior context can clone the repository, run one command, and
get a working three-service stack. Nothing more.

This feature deliberately contains no business logic. Its value is that every
later feature starts from a base that is known to build, start, connect to a
database, and refuse to run when misconfigured.

## Scope

### In scope

- npm workspaces monorepo with `apps/api` and `apps/web`
- NestJS API exposing `GET /health` only
- Next.js web app with a placeholder page and a same-origin API proxy
- PostgreSQL in Docker Compose, with a readiness healthcheck
- Container entrypoint with migration and seed steps wired but empty
- Environment validation that refuses to start on bad configuration
- Prisma 7 with a driver adapter, against a schema with **no models**
- ESLint, Prettier, strict TypeScript, and a single `npm run verify` gate
- `docs/` structure, ADRs, risk register, this feature document, test matrix
- `.gitignore` and `.dockerignore` verified against real leaks

### Out of scope, deliberately

| Excluded | Reason |
|---|---|
| Any business table | F01 |
| Authentication, guards, sessions | F02 |
| Expense, policy or review logic | F03 to F05 |
| Seed script | F01 |
| `packages/contracts` | Created in F03, when a shared type actually exists. An empty package is a speculative abstraction |
| shadcn/ui installation | Only the primitives actually used will be copied, in F06 |
| TanStack Query, Swagger | Introduced where they are first needed |
| Real UI | F06 to F08 |

### Deferred

| Item | Condition |
|---|---|
| Playwright end-to-end tests | Only if time remains after F08. None of the four core guarantees is provable by a browser test |
| Next `standalone` output | Image size optimisation; not graded, and a known source of broken workspace images |
| Pre-lock idempotency fast path (ADR-007) | Only against measured contention |

## Architecture

```
browser ──▶ web :3000 ──(server-side)──▶ api :3001 ──▶ db :5432
                │                           │
                └── app/api/[...path] ──────┘
                    runtime proxy
```

The browser talks to one origin. `/api/*` is proxied server-side, which is what
makes the session cookie first-party in F02 and removes CORS entirely
(ADR-008).

Company backends call `api:3001` directly. They authenticate with an API key,
not a cookie, so the browser's same-origin rules do not apply to them.

### Request lifecycle for `GET /health`

1. `main.ts` validates the environment **before** building the Nest container.
   Invalid configuration exits non-zero with a message naming the variables.
2. `ConfigModule` provides the parsed, typed environment under the `ENV` token.
   Nothing else in the codebase reads `process.env`.
3. `PrismaService` constructs `PrismaClient` with a `PrismaPg` adapter built
   from `DATABASE_URL` and `DB_POOL_MAX`, and connects in `onModuleInit` - so an
   unreachable database fails at boot, not on the first request.
4. `HealthController` calls `HealthService`, which issues a real
   `SELECT 1` and times it.
5. Database up gives `200`; database down gives `503` with the same body shape
   and a generic error string.

## Files created

### Root

| File | Responsibility |
|---|---|
| `package.json` | Workspaces, the shared toolchain, and the `verify` gate |
| `tsconfig.base.json` | Strict compiler options shared by both workspaces |
| `eslint.config.mjs` | Flat config covering both workspaces |
| `.prettierrc`, `.prettierignore`, `.editorconfig` | Formatting |
| `.gitignore` | Verified by F00-T07 |
| `.dockerignore` | Verified by F00-T12. Uses `**/` forms - see D-1 |
| `.env.example` | Every variable, with development-only placeholders |
| `docker-compose.yml` | Three services, healthchecks, ordered startup |
| `README.md`, `AI_LOG.md` | Submission documents |

### `apps/api`

| File | Responsibility |
|---|---|
| `src/main.ts` | Validate config, create the app, bind `0.0.0.0`, enable shutdown hooks |
| `src/config/env.schema.ts` | Zod schema, `parseEnv` (pure), `loadEnv` (exits on failure, memoised) |
| `src/config/config.module.ts` | Global provider for the typed environment |
| `src/prisma/prisma.service.ts` | Single `PrismaClient` with an explicit `pg` pool |
| `src/prisma/prisma.module.ts` | Global, so feature modules inject without re-importing |
| `src/health/health.service.ts` | Real `SELECT 1` with timing; never returns driver detail |
| `src/health/health.controller.ts` | `200` or `503`, same body shape |
| `src/health/health.types.ts` | The response contract |
| `prisma/schema.prisma` | Datasource and generator only - **no models** |
| `prisma.config.ts` | Prisma 7 CLI config; attaches the datasource only when the URL exists |
| `Dockerfile` | Multi-stage, `npm ci` from the lockfile, non-root |
| `docker-entrypoint.sh` | Migration and seed steps, both no-ops in F00 |
| `jest.config.js`, `test/jest.setup.ts` | Test runner and `DATABASE_URL` resolution |
| `test/*.spec.ts` | 13 tests |

### `apps/web`

| File | Responsibility |
|---|---|
| `app/api/[...path]/route.ts` | Runtime same-origin proxy, forwards `Set-Cookie` correctly |
| `app/page.tsx` | Placeholder that reports real backend connectivity |
| `app/layout.tsx`, `app/globals.css` | Shell and Tailwind entry |
| `lib/api.ts` | Server-side fetch helper |
| `next.config.ts` | Minimal; records **why** there is no `rewrites()` |
| `Dockerfile` | Multi-stage, non-root |

## What breaks if a key piece changes

| Change | Breaks | Detected by |
|---|---|---|
| Remove `condition: service_healthy` | API starts before PostgreSQL accepts connections; crash loop on a cold machine | F00-T01, F00-T03 |
| Remove `incremental: false` from `tsconfig.build.json` | Builds exit 0 and emit nothing | F00-T11, F00-T11b |
| Remove `**/.env` from `.dockerignore` | Secrets ship inside image layers | F00-T12 |
| Replace the proxy route with `rewrites()` | The API address is frozen at build time; all proxied requests `500` in the container | F00-T05 |
| Return the raw driver error from `/health` | The database password is exposed over HTTP | `health.unit.spec.ts`, F00-T02b |
| Read `process.env` directly in a service | Unvalidated configuration reaches business code | Code review; `ConfigModule` makes the correct path the easy one |
| Make `loadEnv` non-fatal | A misconfigured process starts and fails later on a request path | F00-T06 |
| Drop `DB_POOL_MAX` | Concurrency tests silently serialise inside the pool and prove nothing | Risk R-10; the negative control in F04 |

## Test results

17 of 17 acceptance checks pass; 13 of 13 automated tests pass.
Full detail, including the four defects found and fixed, is in
[`docs/testing/F00-test-matrix.md`](../testing/F00-test-matrix.md).

## Limitations

- The images carry the full dependency tree rather than a pruned one. The
  Prisma CLI is needed at runtime for `migrate deploy` from F01, so pruning
  would break the single-command startup promise. Size is traded for
  reliability, and the trade is recorded here.
- `apps/web` uses `next start` rather than `standalone` output. Standalone in a
  workspace needs `outputFileTracingRoot` and a nested copy layout, which is a
  common source of silently broken images.
- The health check covers the database only. There is nothing else to check yet.

## Next feature

**F01 - Database and seed.** It introduces the business schema, the first
migration, and the seed script, and fills in the two entrypoint steps that F00
left as verified no-ops.
