# F02 - Interview defence

Five questions a LIMAZ interviewer could reasonably ask after reading the F02
code. Each attacks a decision actually made here.

---

## Q1 - Authentication versus authorization

> You have two separate guards. Merge them - one guard that looks up the
> credential and checks the role in the same pass. Fewer moving parts. Why
> not?

**Because they answer different questions, and one of them has to run for
callers the other one does not apply to.**

Authentication asks *who is this*. Authorization asks *may they*. A valid API
key proves a company is calling; it says nothing about whether a company may
resolve a review. Merging them makes it easy to write the code where
"credential was valid" slides into "request allowed", which is the shape of
most authorization bugs.

The concrete consequence here is the third guard and its position:

```ts
{ provide: APP_GUARD, useClass: CsrfGuard },            // 1
{ provide: APP_GUARD, useClass: AuthenticationGuard },  // 2
{ provide: APP_GUARD, useClass: AuthorizationGuard },   // 3
```

CSRF has to run **first**, because `POST /v1/auth/login` is `@Public()`. A
merged guard that resolved a credential before checking CSRF would skip the
check entirely on the one endpoint where login CSRF applies - a hostile page
POSTing the *attacker's* credentials so the victim ends up signed into the
attacker's account. F02-T16b is that test.

They are also registered globally rather than per controller, so everything is
protected the moment it exists and opening a route means writing `@Public()`
on it. The alternative - middleware matched to `/v1/*` - fails open: the first
route added outside the pattern is simply unguarded and nothing says so.

**Backed by:** `src/app.module.ts`, `src/auth/guards/`, F02-T16b, F02-T12.

---

## Q2 - Password hashing versus API key hashing

> Passwords use bcrypt, API keys and session tokens use SHA-256. That looks
> like you got bored halfway. Defend it.

**It follows from entropy, and the SHA-256 choice is forced, not preferred.**

| | Password | Session token / API key |
|---|---|---|
| Source | a person | `crypto.randomBytes(32)` |
| Entropy | low | **256 bits** |
| Brute force | realistic | infeasible |

bcrypt is deliberately slow because guessing a human-chosen password is cheap
and we need to make it expensive. At 256 bits of CSPRNG entropy there is
nothing to slow down.

The forcing argument is the other half: **bcrypt is not indexable.** Every
hash carries its own salt, so `WHERE key_hash = $1` cannot work - you would
have to load every key and bcrypt-compare each one. That is O(n) bcrypt
operations on every authenticated request. SHA-256 gives a single indexed
probe, O(log n) on a B-tree.

So using bcrypt for API keys would be slower *and* less secure in practice,
because the only way to make it workable is to stop hashing properly.

**The related detail I would raise unprompted:** `bcrypt.compare` runs on
login even when the email matched nothing, against a dummy hash created at
startup. Without it, an unknown email returns in microseconds and a known one
in ~100ms, and that difference enumerates accounts just as effectively as a
different error message would. F02-T08b measures it.

**Backed by:** `src/auth/password.service.ts`, `api-key.service.ts`,
`session.service.ts`, F02-T08, F02-T08b, F02-T18.

---

## Q3 - Database sessions versus JWT

> A database read on every authenticated request, when a signed JWT would be
> zero reads. You have made every request slower. Justify it.

**A JWT cannot be revoked, and this system needs revocation for reasons that
are in the requirements.**

A manager dismissed at 14:00 with a token valid until 18:00 keeps full access
for four hours. The only mitigations are a very short lifetime - which just
moves the cost to refresh requests - or rotating the signing key, which logs
out everybody.

We need revocation for logout (F02-T11), for password change, and for the
platform admin managing access in F08. With a session row it is one `UPDATE`,
effective on the next request.

**On the cost:** it is one indexed lookup on a hashed token - the same profile
as the API key path, which nobody objects to. Both conditions live in the
query:

```sql
WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
```

In the `WHERE`, not in an `if` afterwards, because a forgotten `if` on one
future code path means an expired session keeps working, while a missing row
cannot be forgotten by anyone.

And only the SHA-256 hash is stored, so a database dump yields hashes, not
live sessions (F02-T18c).

**Backed by:** `src/auth/session.service.ts`, ADR-008, F02-T10, F02-T11,
F02-T18c.

---

## Q4 - Tenant isolation

> Walk me through exactly what stops company A reading company B's expense.
> And convince me your test for it is not passing by accident.

**Three layers, and the third is the one I would check first in a review.**

**1. The tenant cannot come from the request.** The login DTO is `.strict()`,
so a body carrying `companyId`, `role` or `userId` is refused outright rather
than parsed and partly ignored. There is no decorator anywhere that reads a
company from a body, a query parameter or a header. F02-T15 and T15b send it
all three ways and the resolved tenant never moves.

**2. The tenant is typed.** `Principal` is a discriminated union, so a
platform admin's `companyId` is `null`, not optional. With an optional field,
`principal.companyId!` compiles and isolation depends on nobody writing that
`!`. Here the compiler forces every call site to handle the no-tenant case -
and `tenantScope()` throws rather than returning an empty filter, because an
empty filter means either "no rows" or, far worse, "all rows" (F02-T15c).

**3. The answer is 404, never 403.** `403` would confirm the row exists,
turning the endpoint into an enumeration oracle: company A walks ids and
learns which are real, how many B has, roughly when they were created. F02-T13
asserts the body is **byte-identical** to the response for an id that exists
nowhere.

**On whether the test is accidental - F02-T29 is the negative control.** It
runs the same lookup twice against the same seeded row:

```ts
findFirst({ where: { id: deltaExpenseId } })                        // returns B's row
findFirst({ where: { id: deltaExpenseId, companyId: COMPANY_A.id } }) // null
```

The row is there and reachable; the filter is the only thing keeping it out.

**What I would not claim:** this does not make forgetting `tenantScope()`
impossible. PostgreSQL row-level security would, and I rejected it for now -
it needs `SET LOCAL` per transaction, has no Prisma support, is awkward under
transaction-mode pooling, and needs a `BYPASSRLS` role for the admin. It is
recorded as the upgrade path, and the limitation is written down rather than
glossed over.

**Backed by:** `src/common/tenant.ts`, `src/auth/principal.types.ts`,
ADR-003, F02-T13, T14, T15, T15c, **T29**.

---

## Q5 - Cookies, CSRF and revocation

> You have no CORS configuration at all. That sounds like something you
> forgot.

**CORS is not a lock the server applies; it is permission the server grants.**

With no CORS headers, the browser's default - deny - stands. That is the
strictest posture available. Enabling CORS could only ever *open* access that
is currently closed. So "no CORS config" is the secure state, not the missing
one.

It is unnecessary because the browser never makes a cross-origin request here:
Next.js proxies `/api/*` server-side, so everything is same-origin. And it
could never have been a security control anyway - CORS is enforced by
browsers. A single `curl` ignores it completely.

**What actually stops a hostile page**, in layers, each covering the previous
one's gap:

| Layer | Stops | Gap it leaves |
|---|---|---|
| `SameSite=Lax` | cross-site POST | a compromised sibling subdomain |
| No CORS | cross-origin `fetch` - preflight gets no permission, browser cancels | a plain `<form>`, which needs no preflight |
| `X-Limaz-Client` required | that `<form>` - forms cannot set headers | - |
| **Server-side `Origin` check** | anything the browser labels as foreign | clients sending no Origin - but those carry no cookie |

That fourth layer is the one I would point at. `Origin` is a forbidden header
name: page JavaScript cannot forge it, the browser sets it. So when present it
is trustworthy, and checking it **on our server** moves the judgement out of
the browser's CORS implementation and into code we control. The rule is "if
present, must match" rather than "must be present", because non-browser
clients do not send one and requiring it would break every API key caller
(F02-T30c).

**On the cookie:** `HttpOnly; Secure; SameSite=Lax; Path=/`, and **no
`Domain`** so it stays host-only and never reaches a sibling subdomain.
`Secure` in every environment, including development - `localhost` is a secure
context in Chrome and Firefox, and making this differ between dev and prod is
how production-only security bugs happen.

**And the honest limit:** none of this stops XSS. Script injected into our own
page runs same-origin, so it can set the custom header, it sends a correct
`Origin`, and the browser attaches the cookie. It still cannot *read* the
cookie - that is what `HttpOnly` buys - but it does not need to. CSRF defence
and XSS defence are different problems, and the second one needs CSP and
output escaping. It is recorded as risk R-18 rather than left implied.

**Backed by:** `src/auth/guards/csrf.guard.ts`, `src/main.ts`, ADR-008,
F02-T16, T16b, T16f, T17, T30, T30c.
