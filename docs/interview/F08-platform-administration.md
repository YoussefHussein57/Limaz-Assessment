# F08 - Interview defence

Five questions a LIMAZ interviewer could reasonably ask after reading the F08
code.

---

## Q1 - Authentication versus platform authorization

> Every other service you wrote puts `companyId` from the session into its
> WHERE clause. The admin routes take it from the URL. Explain why that is not
> the vulnerability it looks like.

**Because the path parameter is a selector, not a proof - and the difference
is enforced before any of this code runs.**

`AuthorizationGuard` has already established that the caller is a
`PLATFORM_ADMIN` by the time a handler executes. The company id then only
answers *which* company to act on.

The tenant-scoped pattern is not available here anyway, and not by accident: a
platform admin has `companyId: null` **by construction** in the discriminated
union, and `tenantScope()` throws for them. The type system made "just use the
session's company" impossible, which forced the question to be answered
properly rather than copied.

**What makes it safe in practice** is that `@Roles('PLATFORM_ADMIN')` is on the
**class**, not repeated per method. A route added later inherits it; the
failure mode of per-method decorators is one new endpoint that forgets.

**And the selector is still load-bearing.** Every key query matches on
`companyId` **and** `keyId`. Without that,
`POST /companies/<A>/api-keys/<a key of B>/revoke` would revoke B's key while
every log line said A - an administrator could break a company they were not
looking at, and the audit trail would point at the wrong one. F08-B32 and
F08-B38 assert the mismatch is refused **and** that nothing was mutated.

**The boundary I would mention unprompted:** an administrator cannot read a
company's expenses. Managing accounts is not the same authority as reading
spending, and the API enforces that separately - every expense and review route
is `@Roles('MANAGER')`, so an administrator is refused there whatever the admin
pages render.

**Backs it up:** `admin.controller.ts`, `principal.types.ts`, F08-B01 to B04,
B32, B38.

---

## Q2 - Key generation and hash storage

> Walk me through minting a key. Why `randomBytes`, why SHA-256, and why not
> bcrypt when you used bcrypt for passwords?

**32 bytes from the OS CSPRNG, and the entropy is what decides the hash.**

`crypto.randomBytes(32)` is 256 bits. The alternatives are disqualified for
specific reasons, not stylistic ones: `Math.random()` is a non-cryptographic
PRNG whose internal state can be recovered from a few previous outputs;
`Date.now()` is guessable to the millisecond; a UUIDv4 is 122 bits and a
UUIDv7 **embeds a timestamp**, which is the opposite of what a secret wants.

**SHA-256, not bcrypt, and that is not a weaker choice - it is a different
problem.**

| | SHA-256 + unique index | bcrypt |
|---|---|---|
| Lookup | **O(log n)** index probe | **O(n)** full scan |
| Hash operations per request | **1** | **n**, one per stored key |
| Indexable? | Yes | **No** - every row has its own salt, so `WHERE hash = ?` is impossible |

Slow password hashing exists because passwords have low entropy and must be
expensive to guess. An API key has 256 bits from a CSPRNG: brute force is not
in the threat model, so the slowness buys nothing while making the lookup
unimplementable. bcrypt here is not slower - it is structurally the wrong tool.

**A correction worth making:** a unique index is a B-tree, so the lookup is
O(log n), not O(1). In practice three or four page accesses, nearly always from
`shared_buffers` - but the complexity class is logarithmic.

**The defect I would volunteer**, because it shows how the label was wrong
while the cryptography was right: the environment token in the key originally
came from `NODE_ENV`. The Docker image sets `NODE_ENV=production` in **every**
environment, because it is a production *build* - so a developer's local stack
minted keys saying `lmz_prod_` next to seeded keys saying `lmz_dev_`. The
token's entire purpose is to stop somebody wasting an afternoon on the wrong
deployment's key, and it was doing the opposite. It now derives from
`APP_ORIGIN`, which names the deployment rather than the build.

**Backs it up:** ADR-006, `api-key-generator.ts`, F08-B20, B24, F08-U01 to U06.

---

## Q3 - Rotation, revocation and lifecycle consistency

> What is the difference between rotating and revoking, and what stops a key
> that was supposed to die from staying alive?

**They solve different problems and must not look interchangeable in the UI.**

**Rotate** is a planned replacement. The new key is active immediately and the
old one enters a **24-hour grace window** - because a company cannot deploy a
new key to all of its servers atomically, and without the window every rotation
is an outage.

**Revoke** is an emergency. The key stops immediately, no grace, because the
reason you revoke is that it leaked.

So the UI renders them differently on purpose: rotate is secondary styling with
a confirmation explaining the grace period; revoke is danger styling and says
**immediately**. Two similar buttons would invite somebody reaching for a
routine replacement to cut a company off.

**What stops a key outliving its death** is that every lifecycle condition
lives in the WHERE clause of the authentication query, written in F02:

```sql
status IN ('ACTIVE','ROTATING') AND revokedAt IS NULL
  AND (expiresAt IS NULL OR expiresAt > now())
```

An `if (key.revokedAt) throw` after the query is a line a future code path can
forget, and forgetting it means a revoked key keeps working. A condition that
prevents the row from being **returned at all** cannot be forgotten.

**Only an ACTIVE key may be rotated**, and both refusals matter: rotating a
`ROTATING` key would push its expiry another 24 hours out every time - "rotate
twice, live forever" - and rotating a `REVOKED` one would resurrect a
credential somebody deliberately killed. Both answer 409 with a message naming
the real state.

**Revocation is idempotent in the one way that matters:** revoking twice
returns 200, because the caller wanted it dead and it is dead - but the `where`
carries `status: { not: 'REVOKED' }` so the **original `revokedAt` is never
overwritten**. That timestamp is audit data.

**The honest limitation:** revocation does not cancel a request already in
flight. Authentication resolves the key at the start of a request, and one that
passed a millisecond earlier will finish. The guarantee is that every
*subsequent* attempt fails. Claiming more would be claiming a
request-cancellation mechanism this system does not have.

**Backs it up:** ADR-006, `api-key-admin.service.ts`, `ApiKeyService.resolve`,
F08-B29 to B31, B35 to B37.

---

## Q4 - Transactions and concurrent administrative operations

> Two administrators click Rotate on the same key at the same moment. What
> happens, and how do you know?

**Exactly one wins, and the loser leaves nothing behind.**

Rotation is two writes - retire the old key, create the new one - and they are
in one transaction because the two failure shapes are both bad and not
symmetrical. New key without retiring the old: the company has two permanently
active keys, one of which everybody believes is expiring. Retiring without
creating: access ends in 24 hours with no replacement and nobody is told.

The retire step is a **conditional update**:

```ts
updateMany({ where: { id, companyId, status: 'ACTIVE', revokedAt: null } })
```

The second transaction finds `status` already `ROTATING`, matches zero rows,
and the whole transaction rolls back - **including the replacement key it had
already created**. That is why the new key is created *after* the conditional
update and not before.

**Why not an advisory lock**, when F04 uses one: the invariants are different
shapes. F04 protects a COUNT across many rows, which no row lock can cover
because there is no single row to lock. This protects **one row's state
transition** - exactly what a row lock and a predicate re-check do protect,
which is the F05 lesson. An advisory lock here would serialise unrelated keys
for no gain.

**How I know it works** is F08-B34: two genuinely overlapping requests against
real PostgreSQL, asserting `[200, 409]` **and** that exactly one new row
exists. Two would mean both transactions committed their replacement.

**The detail that makes that test real** rather than theatre: `.then(r => r)`
on each supertest request. Supertest's `Test` is **lazy** and does not send
until something awaits it - without that the two run sequentially and the test
passes while proving nothing. That cost real time to learn in F05 (AI_LOG 29).
And `DB_POOL_MAX` is 10, above the concurrency, so they contend in the database
rather than queueing in the pool.

**Company creation has the same shape for a different reason:** company,
policy and first key in one transaction, because a company without a policy
accepts submissions and cannot decide any of them. F08-B10b asserts that
invariant across **every** company in the database, not only the ones a test
created.

**Backs it up:** `api-key-admin.service.ts`, `company-admin.service.ts`,
F08-B33, B34, B39, B10, B10b.

---

## Q5 - One-time secret display and frontend security trade-offs

> You show the raw key once. Where does it live in the browser, and what
> exactly are you promising the user?

**One piece of component state, in one component, cleared on close.**

Where it is deliberately not:

| | Why not |
|---|---|
| A TanStack Query cache | Survives navigation, is garbage-collected on its own schedule, and is walked by devtools and error reporters |
| `localStorage` / `sessionStorage` | Persist across reloads, readable by anything on the origin |
| The URL | Goes into browser history and referrer headers |
| A global store | Same, with a wider surface |

Verified in the browser rather than asserted: after the dialog closed, no full
key was on screen, both storages were **empty**, and the URL was clean. Only
the 16-character prefix remains, and it takes no part in authentication.

**What I promise, precisely:** the server stores only a SHA-256 hash, so after
that dialog closes the value cannot be recovered **through any application
API** - not by an administrator, not by support, not by reading the database.

**What I do not promise:** that the secret is gone from the world. Once a
person has copied it, this application cannot reach their clipboard, their
terminal scrollback, or a devtools panel they left open. The copy says exactly
that - "you will not be able to retrieve the full key again **here**" - because
a stronger claim would be false, and a security claim that is false is worse
than none.

If the response is lost, the recovery path is **revoke this key and issue
another**. There is no lookup, by design. That also makes key issuance
non-idempotent, which is why those mutations have `retry: false`: an automatic
retry mints a **second** credential nobody can see the value of. Recorded as
R-33.

**And the integration example uses `YOUR_API_KEY`**, never a live key -
injecting the real one would put a secret on a page that stays on screen,
defeating the one-time display entirely.

**The mistake I would own unprompted**, because it is the sharpest thing F08
taught me: while capturing a screenshot of this dialog, I set the input's DOM
value to a placeholder and took the picture. React re-rendered from its own
state first, and **the real key was written into the image file**. I caught it
reading the screenshot back, deleted the file before any commit, verified it
had never entered git history, and revoked the key. The fix was to mask at the
**paint** layer, because the image is what gets committed - not the DOM. It is
the same lesson as the rest of this feature: the guarantee has to be in the
layer that actually produces the artefact.

**Backs it up:** `secret-reveal.tsx`, `api-key-panel.tsx`, F08-F16, F08-F33,
AI_LOG 43, R-33.
