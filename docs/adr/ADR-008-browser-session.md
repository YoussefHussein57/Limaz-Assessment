# ADR-008: Where the browser keeps the login session

- **Status:** Accepted, 2026-11-19
- **Assessment question:** 8
- **Implemented in:** F02
- **Related risks:** R-07, R-12
- **Related assumption:** A10 (same-origin deployment)

## Context

Managers and the platform admin log in through the browser. The session
credential has to survive page loads, reach the API on every request, and be
revocable.

## Decision

A **server-side session record** in PostgreSQL, referenced by an opaque token in
an **`HttpOnly`, `Secure`, `SameSite=Lax`** cookie.

```
Set-Cookie: limaz_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800
```

No `Domain` attribute, so the cookie stays host-only and is never sent to a
sibling subdomain.

## Why not `localStorage`

`localStorage` is readable by any JavaScript running on the page. A single XSS -
in our code or in any dependency - turns into complete session theft with
`localStorage.getItem('token')`. `HttpOnly` means the JavaScript engine cannot
see the cookie at all, so the same XSS cannot exfiltrate it.

## Why a database session and not a stateless JWT

**A JWT cannot be revoked.** If a manager leaves at 14:00 and their token
expires at 18:00, they keep access for four hours and there is nothing to be
done about it short of rotating the signing key for everyone.

The system needs revocation for real reasons: logout, password change, and the
platform admin managing access in F08. A session row is revoked with one
`UPDATE`, effective on the next request.

The cost is a database read per authenticated request. It is an indexed lookup
on a hashed token - the same cost profile as the API key path - and buys
correctness that a JWT cannot provide at any price.

## Token storage and hashing

```
token  = base64url(randomBytes(32))   // 256 bits - this is the cookie value
stored = sha256(token)                 // UNIQUE column - this is in the database
```

The raw token is never stored. A database dump yields hashes, not usable
sessions. SHA-256 rather than bcrypt for the same reason as API keys (ADR-006):
the token is high-entropy and the lookup must be indexable.

## CSRF protection, risk R-07

A cookie is attached by the browser to **every** request to its origin,
including ones initiated by another site. That is the CSRF problem, and
`HttpOnly` does nothing about it.

Three layers, each covering a gap in the others:

| Layer | Covers | Gap it leaves |
|---|---|---|
| `SameSite=Lax` | Cross-site `POST`, `PUT`, `DELETE` from forms and XHR | Does not isolate sibling subdomains |
| Strict CORS allowlist | Cross-origin XHR and `fetch` | Does not stop a plain cross-origin `<form>` |
| Required custom header on mutations | Cross-origin forms (cannot set headers) and XHR (triggers a preflight we reject) | - |

All state-changing endpoints are `POST`, `PATCH` or `DELETE`, so the top-level
`GET` navigations that `SameSite=Lax` permits cannot mutate anything.

A double-submit CSRF token is the documented next step. With the same-origin
deployment below, the marginal gain is small relative to the added moving
parts; it is recorded as an upgrade, not built now.

## Same-origin deployment, assumption A10, risk R-12

| | Cross-origin (`web:3000` to `api:3001`) | **Same-origin (chosen)** |
|---|---|---|
| Cookie attributes | `SameSite=None; Secure` - **CSRF protection switched off** | `SameSite=Lax` fully effective |
| HTTPS | Mandatory even in development | Not required locally |
| CORS | `credentials: include`, explicit origin, `Allow-Credentials` | **None at all** |
| Common failure | The single most frequent bug in this kind of project | Eliminated by construction |

The browser only ever talks to the web origin. Next.js rewrites `/api/*`
server-side to the NestJS service over the Docker network:

```ts
async rewrites() {
  return [{ source: '/api/:path*', destination: `${internalApiUrl}/:path*` }];
}
```

This is already implemented and verified in F00 by test **F00-T05**, which
asserts both that the proxy works and that **no CORS header is present** -
positive proof that the deployment is genuinely same-origin.

The API also remains directly reachable, because company backends authenticate
with an API key rather than a cookie and are not subject to the browser's
same-origin rules.

## Secure cookies in local development

`Secure` normally requires HTTPS. Chrome and Firefox both treat `http://localhost`
as a secure context and accept `Secure` cookies there, so `secure: true` is set
in **every** environment.

The common `secure: NODE_ENV === 'production'` pattern is deliberately avoided:
it makes development and production differ in a security-relevant way, which
produces bugs that only appear in production. A `COOKIE_SECURE` environment
variable exists as an escape hatch and defaults to `true`.

## Expiration, logout and revocation

| Concern | Mechanism |
|---|---|
| Absolute expiry | `expiresAt = createdAt + 8h`, with the cookie `Max-Age` matching |
| Enforcement | In the query: `WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()` |
| Logout | `revoked_at = now()` plus a `Set-Cookie` with `Max-Age=0` |
| Logout everywhere | `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL` |
| Password change | Revokes all of that user's sessions |
| Idle timeout | `lastSeenAt` with sliding renewal - optional, built only if time allows |

The database is the authority on expiry. The cookie `Max-Age` is a client-side
courtesy and is assumed to be manipulable.

## Failure modes

| Failure | Effect | Mitigation |
|---|---|---|
| Cookie readable by JavaScript | XSS becomes session theft | `HttpOnly`; integration test asserts the attribute is present |
| Origins split in deployment | `SameSite=None` required, CSRF protection lost | Same-origin proxy; F00-T05 asserts no CORS header |
| Expiry checked in code, not SQL | An expired session works on a forgotten path | Conditions live in the `WHERE` clause |
| Raw token stored | A database leak yields live sessions | Only the SHA-256 hash is stored |
| Reviewer or user id taken from the body | Impersonation | Identity always comes from the session (ADR-004) |

## Test strategy

- Integration: login sets a cookie carrying `HttpOnly`, `Secure`, `SameSite=Lax`
  and no `Domain`.
- Integration: the response body contains no token.
- Integration: an expired or revoked session returns `401`.
- Integration: logout invalidates the session immediately.
- Integration: a cross-origin request without the required custom header is
  rejected.
- Integration: the stored value is a hash, never the cookie value.
