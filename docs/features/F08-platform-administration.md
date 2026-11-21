# F08 - Platform administration, company onboarding and API keys

The administrator side. Companies are created, and the credentials their
backends authenticate with are issued, rotated and revoked.

---

## 1. What was built

### Backend - six routes, all `@Roles('PLATFORM_ADMIN')` on the class

| Route | Purpose |
|---|---|
| `GET /v1/admin/companies` | Keyset page, searchable by name |
| `POST /v1/admin/companies` | Company + policy + first key, **one transaction** |
| `GET /v1/admin/companies/:id` | Details, including the read-only policy |
| `GET /v1/admin/companies/:id/api-keys` | Safe metadata only |
| `POST /v1/admin/companies/:id/api-keys` | Issue an additional key |
| `POST /v1/admin/companies/:id/api-keys/:keyId/rotate` | Replace, with a grace window |
| `POST /v1/admin/companies/:id/api-keys/:keyId/revoke` | Stop immediately |

**No change to `ApiKeyService.resolve`.** Authentication, the grace window and
the expiry predicate all shipped in F02 and are used, not reimplemented.

### Frontend - two pages

| Route | Purpose |
|---|---|
| `/admin` | The companies workspace, and the create dialog |
| `/admin/companies/[companyId]` | Details, key management, the one-time secret |

A separate "Overview" page was dropped: the only figure worth knowing at a
glance - which companies cannot authenticate - is on the rows themselves, and
a summary screen would have needed either its own aggregate endpoint or
numbers derived from one page.

---

## 2. The authorisation model, and the one thing to check first

Every other controller in this codebase derives `companyId` from the session.
**These do not**, and that is not an oversight: an administrator has
`companyId: null` by construction, `tenantScope()` would throw for them, and
their job is to act across companies.

So the company id arrives in the **path**. That is safe for exactly one
reason:

> The path parameter is a **selector**, applied after the role has already
> been verified by `AuthorizationGuard`. It is never evidence of anything.

An untrusted `companyId` proving authority is the vulnerability this shape
could become if `@Roles` were removed - which is why it is on the **class**
rather than repeated per method, where one new route could miss it.

| Caller | Admin routes |
|---|---|
| Platform admin | ✅ |
| Company manager | 403 `insufficient_role` |
| Company API key | 403 `caller_type_not_allowed` - `@Roles` implies a human caller |
| Unauthenticated | 401 |

Verified at both layers: the API refuses a manager's list **and** create
(F08-B02, B02b), and the UI role gate from F02.1 shows them a 403 page.

### What an administrator still cannot do

- **Read a company's expenses.** Every expense and review route is
  `@Roles('MANAGER')`, so an administrator is refused there whatever the admin
  pages render. Managing an account is not the same authority as reading
  spending.
- **Edit a company's policy.** It is shown read-only. Deciding what another
  company auto-approves is an authority no approved contract grants; F07 gives
  it to that company's own manager.

---

## 3. Company creation: one transaction, three writes

```
company  +  policy  +  first API key
```

Assumption A5, agreed before any of this was built:

> Creating a company creates its policy and first API key, but not a manager.

Each write is meaningless without the others:

- a company **without a policy** accepts submissions and cannot decide any of
  them - `ExpenseSubmissionService` reads the policy inside its transaction
  and has no defined behaviour without one
- a company **without a key** cannot be reached by its own backend

If any write fails, none of them happened (F08-B10). The alternative - three
sequential calls - leaves a half-created tenant that looks fine in a listing
and fails on first use, with nothing reporting it.

**F08-B10b asserts the invariant across every company in the database**, not
only the ones a test created.

### No manager is created, and that is a decision

Creating one would mean either inventing a password - predictable, or exposed,
or both - or building an invitation flow with email delivery, which the
assessment does not ask for.

So the limitation is **surfaced rather than hidden**: the company detail page
opens with a warning saying the company has no manager, that its backend can
submit but nobody can review, and why. Recorded as **R-32**.

### The blocked list goes through the same normaliser

`normaliseBlockedCategories` from F07, which wraps `normaliseCategory` from
F03. A third implementation would be a third chance for a company's blocked
list to stop matching what its expenses actually carry.

---

## 4. Key generation

```ts
const secret = randomBytes(32).toString('base64url');   // 256 bits
const plaintext = `lmz_${environmentToken(...)}_${secret}`;
```

`crypto.randomBytes` draws from the OS CSPRNG. Everything convenient is
disqualified, and not narrowly:

| Rejected | Why |
|---|---|
| `Math.random()` | A non-cryptographic PRNG whose internal state can be recovered from a handful of previous outputs. Anyone who has seen a few keys can predict the next |
| `Date.now()` | Guessable to the millisecond by anyone who knows roughly when a key was issued |
| A UUID | v4 is 122 bits; v7 **embeds a timestamp**, the opposite of what a secret wants |

256 bits is the number that justifies SHA-256 over bcrypt for storage: brute
force is not in the threat model, so a slow hash buys nothing while making an
indexed lookup impossible (ADR-006).

### The environment token, and the defect in its first version

It is cosmetic - nothing authenticates on it - and it exists so a key pasted
into a support conversation says which **deployment** it belongs to.

The first version derived it from `NODE_ENV`, which was wrong in exactly the
way that defeats that purpose. `NODE_ENV=production` means *this is a
production build*, and the Docker image sets it everywhere - including a
developer running `docker compose up`. So a development stack minted keys
labelled `lmz_prod_` beside seeded keys saying `lmz_dev_`.

It now derives from `APP_ORIGIN`, which names the deployment rather than the
build. The limitation is narrow and stated: a staging deployment on a non-local
host reads `prod`. That is a label, not a capability. Caught by reading a key
the UI had just issued (AI_LOG 42), and now covered by six unit tests.

---

## 5. Rotation

| State | `status` | Authenticates? |
|---|---|---|
| New key | `ACTIVE` | Yes |
| Previous key, during grace | `ROTATING`, `expiresAt = now + 24h` | **Yes** |
| Previous key, after grace | `ROTATING`, expired | No |
| Revoked | `REVOKED` | No, immediately |

Without a grace window **every rotation would be an outage**: a company cannot
deploy a new key to all of its servers atomically.

### Why both writes are in one transaction

Two failure shapes, and they are not symmetrical:

- new key created, old one **not** retired → the company has two permanently
  active keys, one of which everybody believes is on its way out. A credential
  that was supposed to stop working silently does not.
- old key retired, new one **not** created → access ends in 24 hours with no
  replacement, and nobody is told.

Neither state is reachable inside one transaction (F08-B33).

### Why a conditional update rather than an advisory lock

The invariant is **one row changing state** - exactly what a row lock and a
predicate re-check protect, which is the F05 lesson:

```ts
updateMany({ where: { id, companyId, status: 'ACTIVE', revokedAt: null } })
```

A second concurrent rotation finds `status` already `ROTATING`, matches zero
rows, and its whole transaction rolls back **including its new key**. F08-B34
runs two genuinely overlapping requests and asserts `[200, 409]` and exactly
one new row.

An advisory lock would serialise unrelated keys for no gain. F04 needs one
because its invariant is a COUNT across many rows; this one is not.

### Only an ACTIVE key may be rotated

| Source state | Result | Why |
|---|---|---|
| `ACTIVE` | Rotated | |
| `ROTATING` | **409** | "Rotate twice, live forever" - each rotation would push the expiry 24 hours further out |
| `REVOKED` | **409** | Rotating it would resurrect a credential somebody deliberately killed |

---

## 6. Revocation

Immediate, no grace. Rotation is a planned replacement; revocation is for a
leaked credential, where every extra minute is the problem.

**Idempotent in the way that matters.** Revoking twice returns 200 - the
caller wanted it dead and it is dead - but the `where` clause carries
`status: { not: 'REVOKED' }`, so the **original `revokedAt` is never
overwritten**. That timestamp is audit data: when the credential actually
stopped working (F08-B37).

### What revocation does not do

It does **not** cancel a request already in flight. Authentication resolves
the key at the start of a request; one that passed that check a millisecond
before the revocation commits will finish.

The guarantee is that every **subsequent** authentication fails, because
`ApiKeyService.resolve` has `revokedAt: null` inside its WHERE clause - a
revoked row cannot be returned at all. Claiming more would be claiming a
request-cancellation mechanism this system does not have.

---

## 7. The one-time secret

### Where it lives

**One piece of component state, in one component.** On close the parent sets
it to null and the value becomes unreachable.

| Not in | Why |
|---|---|
| A TanStack Query cache | Survives navigation, garbage-collected on its own schedule, walked by devtools and error reporters |
| `localStorage` / `sessionStorage` | Persist across reloads, readable by anything on the origin |
| The URL | Goes into history and referrers |
| Any global store | Same reasons, with a wider surface |
| Logs | - |

Verified in the browser: after the dialog closed, no full key was on screen,
both storages were **empty**, and the URL was clean. Only the 16-character
prefix remains, which takes no part in authentication.

### What "shown once" honestly means

The server stores only a SHA-256 hash, so after the dialog closes the value
**cannot be recovered through any application API** - not by an administrator,
not by support, not by reading the database. That is a real guarantee and it
is why the warning is worded strongly.

What it does **not** mean: once a person has copied it, this application has
no further control. Clearing component state cannot reach their clipboard,
their terminal scrollback, or a devtools panel they left open. The copy says
what is true - "you will not be able to retrieve the full key again **here**".

If it is lost, the recovery path is **revoke and issue another**. There is no
lookup, by design.

### The three responses that carry a secret say `no-store`

`POST /v1/admin/companies`, `POST .../api-keys` and `POST .../rotate` are the
only responses in this system that ever contain a plaintext credential. Each
sets `Cache-Control: no-store`.

A POST response is already uncacheable by default, so this changes nothing a
correct intermediary would do. It is there for the ones that are not, and for
the browser back/forward cache. Added in F09 when the headers were reviewed
and found to be absent rather than wrong (F08-B26).

### Integration guidance uses a placeholder

The company detail page shows a submission example with `YOUR_API_KEY`. A live
key is never injected into it - that would put a secret on a page that stays
on screen, defeating the one-time display entirely.

---

## 8. What was NOT built

| Not built | Why |
|---|---|
| Manager account creation | Would need an invented password or an invitation system. Surfaced as a warning and recorded as R-32 |
| A "reveal key" endpoint | Only the hash is stored. Such an endpoint could not exist without storing the secret, which is the thing being avoided |
| Administrator access to expenses | Managing accounts is not reading spending. The API refuses it |
| Administrator policy editing | That is the company manager's authority (F07) |
| A separate API keys section | A key only means anything in the context of its company |
| Automatic retry on key mutations | **Not idempotent**: a retry mints a second credential nobody can see the value of |
| Last-used tracking on keys | Not recorded anywhere today. Inventing it for visual completeness would be a fabricated metric |
| Company deletion or suspension | No `status` column exists, and the assessment does not ask |

---

## 9. Known limitations

| # | Limitation |
|---|---|
| R-32 | A new company has no manager, so nobody can review its flagged expenses until one is provisioned by other means |
| R-33 | A key issuance is not idempotent - a lost response leaves an unknown credential active until it is revoked |
| - | The environment token reads `prod` for any non-local deployment, including staging |
| - | Revocation does not cancel an in-flight request |
| - | No load testing anywhere in this repository |
