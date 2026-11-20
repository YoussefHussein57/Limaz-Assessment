# F02 test matrix

**Executed:** 2026-11-20
**Commands:** `npm test --workspace @limaz/api` and `bash scripts/verify-f02.sh`
**Environment:** Windows 11, Docker 29.5.3, Node 22.20.0, PostgreSQL 17-alpine

**Result: 112 of 112 automated tests PASS (62 new in F02), 16 of 16 acceptance
checks PASS. F00 (17/17) and F01 (11/11) regression suites still PASS.**

```
Test Suites: 10 passed, 10 total
Tests:       112 passed, 112 total
```

## How these tests reach protected routes

`ProbeController` is registered **only inside test modules**, never in
`AppModule`, so no route it declares exists in the deployed application. The
guards, decorators, `tenantScope()` and the seeded rows it exercises are all
production code; only the route definitions are scaffolding.

Only the `ENV` provider is overridden, so every service reads its
configuration through the same injection the running application uses.

---

## Required matrix

| ID | Scenario | Expected | Verification | Type | Result |
|---|---|---|---|---|---|
| F02-T01 | Valid API key | Resolves to its own company | Response body vs seeded company id | Integration | **PASS** |
| F02-T01b | A different key | Resolves to a different company | Body comparison | Integration | **PASS** |
| F02-T02 | Missing API key | `401 unauthenticated` | Status and body | Integration | **PASS** |
| F02-T02b | Public route vs protected route | Public `200`, protected `401` | Status | Integration | **PASS** |
| F02-T03 | Unknown API key | `401` | Status | Integration | **PASS** |
| F02-T03b | Unknown, revoked and expired keys | **Byte-identical bodies** | `JSON.stringify` comparison | Integration | **PASS** |
| F02-T04 | Revoked API key | `401` | Status, with the row restored afterwards | Integration | **PASS** |
| F02-T05 | Expired API key | `401` | Status | Integration | **PASS** |
| F02-T06 | `ROTATING` key inside its grace window | **Authenticates** | Status and resolved company | Integration | **PASS** |
| F02-T07 | Manager login | Session created, scoped to the right company | Body, cookie, and the stored row | Integration | **PASS** |
| F02-T08 | Wrong password vs unknown email | **Byte-identical `401`s**, no cookie | Body comparison | Integration | **PASS** |
| F02-T08b | Timing of the unknown-email path | Comparable to a wrong password | Elapsed-time ratio | Integration | **PASS** |
| F02-T09 | Platform admin login | Role correct, `company` is `null` | Body | Integration | **PASS** |
| F02-T10 | Expired session | `401` | Status after back-dating `expiresAt` | Integration | **PASS** |
| F02-T11 | Logout then replay | `204`, then `401`; `revokedAt` set | Status and database row | Integration | **PASS** |
| F02-T12 | Manager hits an admin route | `403 insufficient_role` | Status and error code | Integration | **PASS** |
| F02-T12b | Admin hits a manager route | `403` - roles are not a hierarchy | Status | Integration | **PASS** |
| F02-T12c | Each role on its own route | `200` | Status | Integration | **PASS** |
| F02-T13 | Cross-tenant read | `404`, **byte-identical to a nonexistent id** | Body comparison | Integration | **PASS** |
| F02-T13b | Same, as an API key caller | `404` | Status | Integration | **PASS** |
| F02-T13c | Isolation in the opposite direction | `404` | Status | Integration | **PASS** |
| F02-T14 | Cross-tenant mutation | `404` **and the row is untouched** | `merchant` and `updatedAt` before/after | Integration | **PASS** |
| F02-T15 | `companyId` in the body | Ignored; tenant stays the caller's | Echoed tenant | Integration | **PASS** |
| F02-T15b | `companyId` in a query string or header | Ignored | Echoed tenant | Integration | **PASS** |
| F02-T15c | Admin on a company-scoped route | `403 tenant_required`, not an empty filter | Status and error code | Integration | **PASS** |
| F02-T16 | Browser mutation without the CSRF header | `403 csrf_header_required` | Status and error code | Integration | **PASS** |
| F02-T16b | Login without the header | `403` - login CSRF is a real attack | Status | Integration | **PASS** |
| F02-T16c | API key mutation without header or Origin | `200` - exempt by design | Status | Integration | **PASS** |
| F02-T16d | Logout without the header | `403` | Status | Integration | **PASS** |
| F02-T16e | Safe method without the header | `200` | Status | Integration | **PASS** |
| F02-T16f | A fake API key used to skip CSRF | `401`, not a bypass | Status and error code | Integration | **PASS** |
| F02-T17 | Cookie attributes | `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age=28800`, **no `Domain`** | Header inspection | Integration | **PASS** |
| F02-T17b | `COOKIE_SECURE=false` | Drops only `Secure`; everything else unconditional | Header inspection | Integration | **PASS** |
| F02-T18 | Passwords at rest | bcrypt only; never the plaintext | Column inspection | Integration | **PASS** |
| F02-T18b | API keys at rest | SHA-256 of the plaintext; prefix is a strict prefix | Recomputation | Integration | **PASS** |
| F02-T18c | Session tokens at rest | Only the hash is stored | Lookup by raw vs hashed | Integration | **PASS** |
| F02-T18d | Full dump of every credential column | Contains no known secret | Serialise and search | Integration | **PASS** |
| F02-T18-live | The running database | No plaintext key, no non-bcrypt password | `psql` | Acceptance | **PASS** |
| F02-T19 | API key on a user-only route | `403 caller_type_not_allowed` | Status and error code | Integration | **PASS** |
| F02-T19b | API key on a role-gated route | `403` | Status | Integration | **PASS** |
| F02-T19c | API key attempting logout | `403` | Status | Integration | **PASS** |
| F02-T20 | Login through the Next proxy | `200`, correct role | Live `curl` via the web origin | Acceptance | **PASS** |
| F02-T20b | `Set-Cookie` across the proxy hop | Attributes intact | Header inspection | Acceptance | **PASS** |
| F02-T20c | Authenticated proxied request | `200`, correct company | Live `curl` | Acceptance | **PASS** |
| F02-T20d | Replay after a proxied logout | `401` | Live `curl` | Acceptance | **PASS** |
| F02-T20b (cors) | Any CORS header | **Absent** - browsers deny by default | Preflight header inspection | Integration + Acceptance | **PASS** |

## Additional scenarios

| ID | Scenario | Expected | Result |
|---|---|---|---|
| F02-T21 | Seed with `NODE_ENV=production` and no opt-in | Non-zero exit, explains why | **PASS** |
| F02-T21b | The refusal message | Names no credential | **PASS** |
| F02-T22 | Forged cookie value | `401` | **PASS** |
| F02-T22b | Malformed cookie headers, including a duplicated name | `401`, never `500` | **PASS** |
| F02-T23 | API key **and** cookie together | `400 ambiguous_credentials`, before either is validated | **PASS** |
| F02-T24 | Credentials in the container logs | None outside the labelled seed banner | **PASS** |
| F02-T24a | A rejection echoing the presented key | Never | **PASS** |
| F02-T24b | The seed banner | Present and clearly labelled | **PASS** |
| F02-T24c | Logs after handling a real login and a real key | Nothing written | **PASS** |
| F02-T24 (unit) | `redact()` by header, by key, by pattern, and on a cyclic object | Scrubbed; terminates | **PASS** |
| F02-T25 | Two logins | Independent sessions, both valid | **PASS** |
| F02-T26 | Logging out of one | The other keeps working | **PASS** |
| F02-T27 | Malformed login bodies | `400`, never `500` | **PASS** |
| F02-T27b | Extra fields in the login body | `400` - the schema is `.strict()` | **PASS** |
| F02-T28 | Any response containing a password hash | Never | **PASS** |
| **F02-T29** | **Negative control: the same lookup without the tenant filter** | **Returns the other tenant's row** | **PASS** |
| F02-T30 | Mutation from a foreign `Origin`, header present | `403 cross_origin_rejected` | **PASS** |
| F02-T30b | The application origin | Accepted | **PASS** |
| F02-T30c | No `Origin` at all | Accepted - non-browser clients send none | **PASS** |

---

## Negative control: is F02-T13 testing anything?

A tenant-isolation test that passes because the row happened not to exist is
worthless. **F02-T29** runs the same lookup twice against the same seeded data:

```ts
// Without the tenant filter
await prisma.expense.findFirst({ where: { id: deltaExpenseId } });
// -> returns company B's row

// With it, on company A's behalf
await prisma.expense.findFirst({ where: { id: deltaExpenseId, companyId: COMPANY_A.id } });
// -> null
```

The row is there, it is reachable, and the filter is the only thing keeping it
out of company A's hands.

---

## Defects found and fixed during F02

### D-9 - The seed could restore revoked credentials (security, shipped in F01)

Described in full in [`docs/features/F02-authentication.md`](../features/F02-authentication.md).
Found by an automated review of the F01 commit; the flagged "hardcoded
credentials" were acceptable and documented, but the **unconditional execution
of a privilege-restoring script** was not.

**Fixed by:** two independent gates - `SEED_DEV_DATA=true` in the entrypoint,
and a `NODE_ENV=production` refusal inside the seed script.
**Guarded by:** F02-T21, F02-T21b.

### D-10 - A log-leak test that reported the intended banner as a leak

F02-T24 searched the whole API log for the seeded password and found it - in
the seed's own startup banner, which prints the development credentials on
purpose so a reviewer can sign in.

The test asked the wrong question. What matters is whether the **application**
leaks a credential while serving requests, not whether the seed prints what it
was designed to print.

**Fixed by:** excluding the seed's output block and asserting on everything
else, plus F02-T24c, which issues a real login and a real API key request and
then re-reads the logs.

**Why it is recorded:** the first instinct was to loosen the assertion. The
right fix was to make the assertion more precise - and the narrower test then
caught more, not less.

### D-11 - A log filter that silently suppressed the entire log

The first version of that exclusion used `awk '/\[entrypoint\] seeding/'`. The
backslashes were lost in the shell plumbing, leaving `/[entrypoint]/` - which
in awk is a **character class** matching any one of those letters, so almost
every line matched and the filter blanked the log. Both log tests then
"passed" by having nothing to search.

**Found by:** the counts not adding up - a filter that drops 64 of 64 lines is
not filtering, it is deleting.
**Fixed by:** `index($0, "literal string")` instead of a regex, removing the
escaping question entirely.
**Verified by:** a direct count - 64 lines in, 39 kept, 25 dropped, the
startup line retained and the banner gone.

> This is the second time lost backslashes have produced a silently wrong
> result in this project (F00 defect D-2 was the first). The lesson applied
> both times: assert on the artefact, not on the exit status.

### D-12 - A test helper that broke supertest's chaining

`login()` was written `async`, so it returned a `Promise<Response>` rather
than supertest's thenable `Test` object, and `.expect(200)` no longer existed
on it.

**Found by:** `tsc`, before a single test ran.
**Fixed by:** dropping `async` so the chain survives.

---

## Manual verification

Preconditions: `docker compose up` is running and the seed has applied.

```bash
# Manager login through the browser origin, exactly as the UI will
curl -i -X POST http://localhost:3000/api/v1/auth/login \
  -H 'content-type: application/json' -H 'x-limaz-client: 1' \
  -d '{"email":"manager@nile-logistics.test","password":"NileManager!2026"}'
```
Expect `200`, a body with `"role":"MANAGER"`, and a `Set-Cookie` carrying
`HttpOnly; Secure; SameSite=Lax; Path=/` and no `Domain`.

```bash
# Admin login - note the null company
curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'content-type: application/json' -H 'x-limaz-client: 1' \
  -d '{"email":"admin@limaz.test","password":"PlatformAdmin!2026"}'
```
Expect `"role":"PLATFORM_ADMIN"` and `"company":null`.

```bash
# Current user, using the cookie from the login above
curl -s http://localhost:3000/api/v1/auth/me -H 'cookie: limaz_session=<TOKEN>'
```
Expect `"callerType":"user"` and the manager's own company.

```bash
# API key authentication
curl -s http://localhost:3001/v1/auth/me -H 'x-api-key: lmz_dev_nile_7Qk2PmXaR4tVbN8cLw3ZyH6dJeF5uG9s'
```
Expect `"callerType":"api-key"`, `"user":null`, and Nile Logistics.

```bash
# Invalid key, and no key at all
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/v1/auth/me -H 'x-api-key: nope'
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/v1/auth/me
```
Expect `401` for both, with identical bodies.

```bash
# An API key is not a person
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3001/v1/auth/logout \
  -H 'x-api-key: lmz_dev_nile_7Qk2PmXaR4tVbN8cLw3ZyH6dJeF5uG9s'
```
Expect `403`.

```bash
# CSRF: a state-changing browser request with no custom header
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3001/v1/auth/logout \
  -H 'cookie: limaz_session=<TOKEN>'
```
Expect `403`.

```bash
# A foreign Origin, even with the header
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3001/v1/auth/logout \
  -H 'cookie: limaz_session=<TOKEN>' -H 'x-limaz-client: 1' -H 'origin: https://evil.example'
```
Expect `403`.

```bash
# No CORS is granted to anyone
curl -s -D - -o /dev/null -X OPTIONS http://localhost:3001/v1/auth/me \
  -H 'origin: https://evil.example' -H 'access-control-request-method: GET'
```
Expect **no** `access-control-allow-origin` header at all.

```bash
# Logout, then replay the same cookie
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/v1/auth/logout \
  -H 'cookie: limaz_session=<TOKEN>' -H 'x-limaz-client: 1'
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/v1/auth/me \
  -H 'cookie: limaz_session=<TOKEN>'
```
Expect `204` then `401`. Database: that session's `revokedAt` is set.

```bash
# Nothing is stored in plain text
docker exec limaz-expense-policy-db-1 psql -U limaz -d limaz \
  -c 'SELECT email, left("passwordHash",7) FROM users'
docker exec limaz-expense-policy-db-1 psql -U limaz -d limaz \
  -c 'SELECT prefix, left("keyHash",12) FROM api_keys'
```
Expect `$2b$10$` prefixes and 64-character hex hashes.

---

## Not covered by F02

| Area | Lands in |
|---|---|
| Tenant isolation on the real expense, review and admin endpoints | F03, F05, F08 |
| Idempotency under concurrency | F03 |
| Policy evaluation and precedence | F04 |
| Concurrent review resolution | F05 |
| API key issuing and rotation endpoints | F08 |
| Rate limiting on login | Out of scope; risk R-19 |
| XSS defence (CSP, output escaping) | Out of scope; risk R-18 |
