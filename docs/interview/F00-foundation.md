# F00 - Interview defence

Five questions a LIMAZ interviewer could reasonably ask after reading the F00
code. Each attacks a decision we actually made.

---

## Q1 - Architecture

> Your Next.js app proxies `/api/*` to NestJS instead of letting the browser
> call the API directly. That is an extra network hop and an extra piece of code
> to maintain. Why?

**The short answer:** so the session cookie is first-party.

**The long answer:** if the browser talked to `api:3001` directly, every
authenticated request would be cross-origin. A cross-origin cookie must be
`SameSite=None`, and `SameSite=None` **switches off** the browser's built-in
CSRF protection. It also requires `Secure`, so HTTPS becomes mandatory even in
local development, and it requires a CORS configuration with
`Allow-Credentials` and an explicit origin - which is the single most
commonly misconfigured thing in a setup like this.

With one origin, `SameSite=Lax` works, there is no CORS configuration to get
wrong, and local development matches production. Test **F00-T05b** asserts that
no `access-control-allow-origin` header is present, which is positive proof the
deployment is genuinely same-origin rather than merely intended to be.

The extra hop is one in-datacentre request. The alternative is a weaker security
posture in exchange for it.

**Backed by:** [ADR-008](../adr/ADR-008-browser-session.md),
`apps/web/app/api/[...path]/route.ts`, risk R-12.

---

## Q2 - Implementation

> You started with `rewrites()` in `next.config.ts` and replaced it with a route
> handler. What exactly went wrong?

`rewrites()` is resolved at **build** time and frozen into
`.next/routes-manifest.json`. The destination string is interpolated once,
during `next build`, and never again.

Our image is built without `INTERNAL_API_URL` - correctly, because build time is
not deployment time and an image should not carry a deployment's topology. So
the fallback was used and the manifest contained:

```json
{ "source": "/api/:path*", "destination": "http://localhost:3001/:path*" }
```

Inside the web container, `localhost:3001` is the web container. Every proxied
request returned `500`.

A route handler reads `process.env` **per request**, so one image works
everywhere. It is also where cookie forwarding has to live from F02, and that
needs care: `headers.get('set-cookie')` collapses multiple `Set-Cookie` headers
into one malformed string, so the handler uses `getSetCookie()`.

Test **F00-T05** caught it. I confirmed the cause by reading
`routes-manifest.json` inside the running container rather than guessing.

**Backed by:** `apps/web/app/api/[...path]/route.ts`,
`docs/testing/F00-test-matrix.md` defect D-4.

---

## Q3 - Failure and concurrency

> `DB_POOL_MAX` is a validated environment variable in a feature with no
> business logic and no concurrency. Why does it exist already?

Because a concurrency test with too small a pool is a test that proves nothing,
and that failure is invisible.

If the pool holds one connection and five "simultaneous" requests arrive, they
queue **inside the pool** and execute one after another. The test asserts the
right final state and passes - whether or not the mechanism it claims to verify
exists at all. We would have evidence for a guarantee we had never tested.

F00 is where the control for that lands:

- Prisma 7's driver adapter makes the `pg` pool explicit, so `max` is a real
  configurable number rather than a hidden default (that is an upside of the
  Prisma 7 migration, not a chore).
- `DB_POOL_MAX` is validated at boot, with a range check and a comment stating
  the reason.
- The test setup pins it to `10`.
- Every concurrency test from F03 onwards ships with a **negative control** that
  disables the mechanism under test and must fail.

A test that passes with and without the thing it tests is not a test.

**Backed by:** `apps/api/src/config/env.schema.ts`,
[ADR-007](../adr/ADR-007-frequency-concurrency.md),
[ADR-009](../adr/ADR-009-prisma-7-driver-adapter.md), risk R-10.

---

## Q4 - Security and data integrity

> `/health` returns `"error": "database unreachable"` instead of the real error.
> That makes debugging harder. Why?

Because the real error contains the database password.

Prisma connection failures produce messages like:

```
Authentication failed against database server at `db`,
the provided database credentials for `limaz` are not valid
```

and in several failure modes the full connection string, password included.
`/health` is typically **unauthenticated** - load balancers and monitoring
systems poll it - so echoing a driver error would publish a credential to
anyone who can reach the port.

The detail is not lost. It is logged server-side at `error` level with the full
stack. The caller gets a stable, generic string.

`health.unit.spec.ts` injects a driver error containing the literal password
`hunter2` and asserts that neither the password nor the driver message appears
in the response. **F00-T02b** repeats that check against the live service.

The same reasoning drives the config error path: it names which variables are
wrong and never prints their values, because a malformed `DATABASE_URL` is still
a `DATABASE_URL`.

**Backed by:** `apps/api/src/health/health.service.ts`,
`apps/api/test/health.unit.spec.ts`, risk R-08.

---

## Q5 - Change impact and trade-offs

> Your build exited `0` and produced no output, and nothing caught it. What
> changed as a result?

The cause was `deleteOutDir: true` in `nest-cli.json` combined with
`incremental: true` in `tsconfig.build.json`. `dist/` was deleted, then `tsc`
consulted `tsconfig.build.tsbuildinfo`, concluded nothing had changed, and
emitted nothing - **while exiting 0**.

Two fixes:

1. `incremental: false` in the build config, with the reason in a comment so
   nobody re-enables it for speed.
2. `**/*.tsbuildinfo` in `.dockerignore`, so a stale host cache can never enter
   the build context.

But the real change was to the test. The original check was:

```
npm run build  ->  exit 0  ->  PASS
```

It passed throughout the entire failure. **F00-T11** now asserts
`apps/api/dist/main.js` and `apps/web/.next` **exist**, and **F00-T11b** runs
the build a second time, because the second run is the one that used to emit
nothing.

**The general lesson, which I applied to the rest of the suite:** assert on
artefacts and observable state, not on exit codes. The same reasoning drove
**F00-T12**, which runs a shell inside the built image and checks what is
actually in it - and that is how I found an `apps/api/.env` leaked into a layer
by a `.dockerignore` pattern that only matched the context root.

That leak is the other half of the answer. Fixing it immediately broke the
build, because the leaked `.env` had been silently supplying `DATABASE_URL` to
`prisma generate`. The security hole was load-bearing. If I had fixed it without
rebuilding from a clean context, I would have shipped a broken image.

**Backed by:** `apps/api/tsconfig.build.json`, `.dockerignore`,
`scripts/verify-f00.sh`, `docs/testing/F00-test-matrix.md` defects D-1 to D-3.
