# F02 - Authentication, authorization and tenant isolation

**Status:** Implemented, awaiting project-owner approval
**Date:** 2026-11-20
**Depends on:** F00, F01
**Blocks:** F03, F05, F06, F07, F08

## Objective

Two kinds of caller get in, each proves what it is, and neither can act
outside what it is. The tenant a request operates on is derived from the
verified credential and from nowhere else.

## Scope

### In scope

- API key authentication with full lifecycle enforcement
- Manager and platform-admin login, database-backed sessions, logout
- Three global guards: authentication, authorization, CSRF
- Typed principal, and a single tenant-scoping helper
- CSRF defence in four layers, including a server-side Origin check
- Credential redaction and a uniform error shape
- **A fix for a security defect shipped in F01** (below)
- 62 new automated tests; 16 acceptance checks

### Out of scope, deliberately

Expense submission, idempotency, the policy engine, frequency counting, review
resolution, admin company creation, **API key rotation endpoints** (the
lifecycle semantics are enforced, the endpoints are F08), any UI, OAuth,
password reset, MFA, webhooks, rate limiting.

---

## The security defect this feature had to fix first

An automated review of the F01 commit flagged the seed. It was right about the
dangerous part, and the dangerous part was not the hardcoded credentials - the
assessment asks for seeded development credentials and they are documented.

The problem was that the container entrypoint ran the seed **on every start**,
with `NODE_ENV=production`, and the seed's `update` branch rewrites:

```ts
update: { displayName, role, passwordHash: hash },  // resets the password
update: { keyHash, prefix, status: 'ACTIVE' },      // un-revokes the key
```

In any real environment that makes the seed a **privilege-restoration
mechanism**: an admin changes a password, the container restarts, and the
password published in this repository is back. An API key leaks and is
revoked, the container restarts, and it is `ACTIVE` again.

### The fix: two independent gates

| Gate | Where | What it does |
|---|---|---|
| 1 | `docker-entrypoint.sh` | Skips seeding unless `SEED_DEV_DATA=true` |
| 2 | `prisma/seed.ts` | Throws if `NODE_ENV=production` and the opt-in is absent |

`docker-compose.yml` sets `SEED_DEV_DATA: "true"` **explicitly**, because that
file *is* the development and review stack. A real deployment simply does not.

Two gates rather than one because they fail differently: the entrypoint only
covers this image, while the in-script check also covers `npm run db:seed`,
`prisma migrate reset`, a CI step, or a different Dockerfile.

**The overwrite behaviour was deliberately kept.** Restoring a known state is
what a development seed is *for*. The defect was the absence of a gate, not
the presence of the behaviour. Verified by **F02-T21**.

---

## Design decisions

### API keys and sessions are different kinds of caller

| | API key | Browser session |
|---|---|---|
| Authenticates | a **company** | a **person** |
| Arrives in | `x-api-key` header | `limaz_session` cookie |
| Subject to CSRF | **No** - no browser attaches it | **Yes** - the browser sends it unasked |

An API key is not a user. However valid it is, it can never take a
manager-only or admin-only action (F02-T19). The converse holds too.

### Password hashing and token hashing differ because entropy differs

| | Password | Session token / API key |
|---|---|---|
| Source | chosen by a person - **low entropy** | `randomBytes(32)` - **256 bits** |
| Threat | brute force is realistic | brute force is infeasible |
| Algorithm | **bcrypt**, cost 10 | **SHA-256** |

Slowness buys protection when entropy is low. At 256 bits it buys nothing -
and bcrypt's per-row salt makes `WHERE hash = $1` impossible, turning every
authenticated request into a full table scan.

### Database sessions rather than stateless JWT

A JWT cannot be revoked. A manager dismissed at 14:00 with a token valid until
18:00 keeps access for four hours. Logout, password change and F08's access
management all need revocation, so the session row is the authority
(F02-T11). The cost is one indexed read per request - the same profile as the
API key path.

### Guards rather than middleware

Middleware cannot read route metadata, so it has to be attached by path
pattern - and the first route added outside that pattern is silently
unprotected. The guards are registered globally, so **every route is protected
the moment it exists** and opening one requires writing `@Public()` on it,
where a reviewer of that route will see it.

**Registration order is load-bearing:**

```
1. CsrfGuard            must run first - login is @Public(), so a CSRF guard
                        placed after authentication would never run for login,
                        leaving login CSRF wide open
2. AuthenticationGuard  resolves WHO, attaches the principal
3. AuthorizationGuard   decides WHAT, and needs the principal to exist
```

### Explicit tenant scoping rather than row-level security

| Option | Verdict |
|---|---|
| **`WHERE companyId` via `tenantScope()`** | **Chosen** - visible at the call site, greppable, testable |
| Prisma client extension injecting the filter | Rejected: hides the filter, and the admin path becomes an awkward exception |
| PostgreSQL RLS | Rejected **for now**: needs `SET LOCAL` per transaction, has no Prisma support, is awkward under transaction-mode pooling, and needs a `BYPASSRLS` role for the admin. Recorded as the upgrade path |

**The limitation is real and accepted:** a developer can forget to spread
`tenantScope()` into a query. Three things reduce it - the tenant comes from a
typed principal rather than a loose string, one helper is the only source, and
**F02-T29 is a negative control** proving the isolation tests would notice.

### Role authorization and resource authorization answer differently

```
Role level      "are you a MANAGER?"                 -> 403
Resource level  "does this row belong to you?"       -> 404
```

`403` means "this exists and you may not". At the role layer that leaks
nothing: the existence of admin routes is not a secret. At the row layer it
would be an **enumeration oracle**, so a foreign row is indistinguishable from
one that never existed (ADR-003, F02-T13).

### The typed principal

```ts
type Principal =
  | { kind: 'api-key';  apiKeyId: string; companyId: string }
  | { kind: 'user'; userId: string; sessionId: string; role: 'MANAGER';        companyId: string }
  | { kind: 'user'; userId: string; sessionId: string; role: 'PLATFORM_ADMIN'; companyId: null   };
```

A discriminated union, not an interface with optional fields. With optionals,
`principal.companyId!` compiles and tenant isolation depends on nobody writing
that `!`. Here the admin's `companyId` is typed `null`, so every call site is
forced to decide what happens when there is no tenant. **The compiler enforces
it, not discipline.**

It is attached to the request under a `Symbol`, which no JSON body can
contain, so no caller can pre-populate the field we are about to trust.

---

## CSRF: four layers, and what each one misses

| Layer | Stops | Leaves open |
|---|---|---|
| `SameSite=Lax` | cross-site `POST` from forms and fetch | a compromised sibling subdomain |
| **No CORS at all** | cross-origin `fetch` - the preflight gets no permission and the browser cancels | a plain cross-origin `<form>`, which needs no preflight |
| `X-Limaz-Client` required | that `<form>`, which cannot set headers | nothing on its own |
| **Server-side `Origin` check** | anything a browser labels as foreign | clients that send no Origin - but those carry no cookie either |

### Why there is no CORS configuration

CORS is not a lock the server applies; it is **permission the server grants**.
With no CORS headers the browser's default - deny - stands, which is the
strictest posture available. Enabling CORS could only ever *open* access that
is currently closed.

It is unnecessary because the browser never makes a cross-origin request here:
Next.js proxies `/api/*` server-side, so everything is same-origin (ADR-008).
Company backends authenticate from server code, where CORS does not apply at
all - which is also why CORS could never have been a security control: a
single `curl` ignores it.

### Why the Origin check is not a duplicate of CORS

| | CORS | Our Origin check |
|---|---|---|
| Enforced by | the **browser** | **our server** |
| If the browser is buggy or misconfigured | protection is gone | still holds |

`Origin` is a forbidden header name: page JavaScript cannot forge it, the
browser sets it. So when present it is trustworthy. The rule is **"if present,
must match"** rather than "must be present", because non-browser clients do
not send one and requiring it would break every API key caller (F02-T30c).

### Why login needs CSRF protection despite having no session

**Login CSRF.** A hostile page POSTs the *attacker's* credentials; the victim
is signed into the attacker's account without noticing, and everything they
then do lands there. So the rule is not "requests with a session" but
"requests that are not API-key authenticated" (F02-T16b).

### What none of this stops

**XSS.** Script injected into our own page runs same-origin: it can set the
custom header, it sends a correct `Origin`, and the browser attaches the
cookie. It still cannot *read* the cookie, but it does not need to. CSRF
defence and XSS defence are different problems; the latter needs CSP and
output escaping. Recorded as risk **R-18**.

---

## API contract

| Endpoint | Callers | Auth | Body | Success | Failure |
|---|---|---|---|---|---|
| `POST /v1/auth/login` | browser | **Public** + CSRF header + Origin | `{email, password}` | `200` identity, `Set-Cookie` | `400` malformed, `401` generic, `403` CSRF |
| `GET /v1/auth/me` | **both** | session or API key | - | `200` discriminated identity | `401` |
| `POST /v1/auth/logout` | user only | session + CSRF header | - | `204`, cookie cleared | `401`, `403` for an API key |

```jsonc
// GET /v1/auth/me, discriminated by caller type
{ "callerType": "api-key", "user": null, "company": { "id": "…", "name": "Nile Logistics" } }
{ "callerType": "user", "user": { "id": "…", "email": "…", "displayName": "…", "role": "MANAGER" },
  "company": { "id": "…", "name": "Nile Logistics" } }
{ "callerType": "user", "user": { …, "role": "PLATFORM_ADMIN" }, "company": null }
```

**Three endpoints, no fourth.** Every public surface is something that has to
be defended in review.

### Cookie

```
limaz_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800
```

No `Domain`, so it stays host-only and never reaches a sibling subdomain.
`Secure` in **every** environment: `http://localhost` is a secure context in
Chrome and Firefox, and making this differ between dev and prod is how
production-only security bugs happen. `COOKIE_SECURE=false` exists as an
escape hatch and weakens nothing else (F02-T17b).

### Two details that are easy to miss

**`bcrypt.compare` always runs**, against a dummy hash when the email matched
nothing. Otherwise an unknown email returns in microseconds and a known one in
~100ms, and the timing alone enumerates accounts as effectively as a different
error message would (F02-T08b).

**The login DTO is `.strict()`**, so a body carrying `companyId`, `role` or
`userId` is refused outright rather than parsed and partly ignored. There is
no shape of request in which a caller-supplied tenant reaches the service layer
(F02-T15, F02-T27b).

---

## Testing the guards without building endpoints that are out of scope

F02-T12 through T19 need protected routes, and the admin and expense endpoints
are explicitly excluded from this feature.

`ProbeController` is registered **only inside test modules** and is not part of
`AppModule`, so it adds **zero production surface** - the assessment's warning
about temporary insecure endpoints is respected literally.

| Scaffolding | Production code under test |
|---|---|
| the route definitions | the three guards, the decorators, `tenantScope()`, the principal type, the real seeded rows |

Only the ENV provider is overridden in the test module, so `PrismaService`,
`PasswordService` and `CsrfGuard` all read their configuration through the
same injection the running application uses.

F03, F05 and F08 re-test tenant isolation on the real endpoints. This is the
first layer, not a substitute.

---

## Files

### Created

| File | Responsibility |
|---|---|
| `src/auth/principal.types.ts` | The discriminated union and the request symbol |
| `src/auth/api-key.service.ts` | SHA-256, indexed lookup, lifecycle in SQL |
| `src/auth/session.service.ts` | Issue, resolve, revoke, and the hand-built `Set-Cookie` |
| `src/auth/password.service.ts` | bcrypt plus the dummy hash timing floor |
| `src/auth/auth.service.ts` | Login, logout, identity description |
| `src/auth/auth.controller.ts` | The three endpoints |
| `src/auth/guards/authentication.guard.ts` | Resolves WHO; refuses ambiguous credentials |
| `src/auth/guards/authorization.guard.ts` | Caller type and role; always 403 |
| `src/auth/guards/csrf.guard.ts` | Custom header and Origin, for non-API-key mutations |
| `src/auth/decorators/*.ts` | `@Public`, `@AllowCallerTypes`, `@Roles`, `@CurrentPrincipal` |
| `src/auth/dto/login.dto.ts` | Strict Zod schema |
| `src/common/tenant.ts` | `tenantScope()` - the only source of a tenant filter |
| `src/common/redact.ts` | Credential scrubbing by key, by header and by pattern |
| `src/common/http-exception.filter.ts` | One error shape; never echoes headers |
| `test/auth/*.spec.ts` + `probe.controller.ts` | 62 tests and the test-only probe |
| `scripts/verify-f02.sh` | 16 acceptance checks |

### Modified

| File | Change |
|---|---|
| `src/app.module.ts` | Three global guards in order, plus the exception filter |
| `src/main.ts` | Records **why** there is no `enableCors()` |
| `src/health/health.controller.ts` | `@Public()` - probes hold no credential |
| `src/config/env.schema.ts` | `APP_ORIGIN`, `SESSION_TTL_HOURS`, `COOKIE_SECURE`, `BCRYPT_COST` |
| `docker-entrypoint.sh`, `prisma/seed.ts`, `docker-compose.yml`, `.env.example` | The seed gate |

**New dependencies: none.** The cookie is parsed and built by hand so the
security-relevant attributes are visible in code and assertable, rather than
implied by a library's defaults.

---

## Change impact

| Remove this | What breaks | Caught by |
|---|---|---|
| `tenantScope()` from a query | **Every company sees everything**, and the endpoint still "works" | F02-T13, T14, **T29** |
| The refusal to read `companyId` from a request | **The attacker picks their own tenant.** The worst failure available | F02-T15, T15b |
| `AuthorizationGuard` | Any manager becomes a platform admin | F02-T12 |
| The caller-type check | A company backend acts as a manager | F02-T19 |
| `HttpOnly`, storing the token client-side | Any XSS becomes session theft | F02-T17 |
| The expiry condition in the session query | Sessions never end; dismissal means nothing | F02-T10 |
| `CsrfGuard` | A hostile page resolves reviews as you | F02-T16, T16b, T30 |
| Hashing of credentials | A database dump is every account and key | F02-T18 |
| The CSRF guard's position before authentication | Login CSRF returns silently - login is `@Public()` | F02-T16b |
| The seed gate | A restart restores a published admin password and un-revokes keys | F02-T21 |

---

## Limitations

| | |
|---|---|
| **XSS** | None of the CSRF layers help. Injected script is same-origin: it can set the header and the browser attaches the cookie. Needs CSP and output escaping. Risk **R-18** |
| **No rate limiting** | Login is not throttled, so password guessing is bounded only by bcrypt's cost. Out of scope; risk **R-19** |
| **No sliding expiry** | An 8-hour absolute lifetime, so an active user is logged out mid-session |
| **Forgetting `tenantScope()`** | Possible. Mitigated by the typed principal, the single helper and F02-T29; closed properly only by RLS |
| **Session lookup per request** | One indexed read. The price of revocability |
| **Tenant isolation on real endpoints** | Proven here through a test-only controller. F03, F05 and F08 must re-prove it on the actual routes |

---

## Test results

112 of 112 automated tests pass; 16 of 16 F02 acceptance checks pass; F00
(17/17) and F01 (11/11) still pass. Detail, including the defects found during
implementation, is in [`docs/testing/F02-test-matrix.md`](../testing/F02-test-matrix.md).

## Next feature

**F03 - Expense submission and idempotency.** It is the first consumer of
`tenantScope()` on a real endpoint, and the first place `UNIQUE (companyId,
externalId)` is exercised under concurrency.
