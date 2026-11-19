# ADR-006: How API keys are stored and rotated

- **Status:** Accepted, 2026-11-19
- **Assessment question:** 6
- **Implemented in:** F02 (authentication), F08 (admin management)
- **Related risk:** R-08

## Context

Company backends authenticate with an API key. The key identifies the tenant,
so it is the single most security-sensitive value in the system: whoever holds
it *is* that company.

## Decision summary

| Concern | Decision |
|---|---|
| Generation | 32 bytes from the OS CSPRNG, base64url encoded |
| Format | `lmz_<env>_<43 chars>` |
| Storage | SHA-256 hash only, in a `UNIQUE` column. Plaintext is never stored |
| Display | Shown exactly once, at creation or rotation |
| Lookup | Hash the incoming key, single indexed query |
| Rotation | New key active; old key enters a grace window, then expires |
| Revocation | Immediate, no grace |
| Expiry enforcement | Inside the `WHERE` clause, not in application code |
| Transport | Header only, never a query parameter |

## Generation and entropy

```ts
const secret = crypto.randomBytes(32).toString('base64url'); // 256 bits
const key = `lmz_${env}_${secret}`;
```

`crypto.randomBytes` draws from the operating system CSPRNG. `Math.random()` is
forbidden: it is a non-cryptographic PRNG whose internal state can be recovered
from previous outputs.

256 bits of entropy is what justifies the hashing choice below.

## Hashing and lookup

```ts
const keyHash = crypto.createHash('sha256').update(presentedKey).digest('hex');
```

### Correction to a common claim

A PostgreSQL `UNIQUE` constraint is backed by a **B-tree** index, so an equality
lookup is **O(log n)**, not O(1). In practice it is three or four page accesses,
nearly always served from `shared_buffers`, so the cost is effectively flat at
our scale - but the complexity class is logarithmic, not constant.

### Why SHA-256 rather than bcrypt or argon2

| | SHA-256 + unique index | bcrypt |
|---|---|---|
| Lookup cost | **O(log n)** index probe | **O(n)** full scan |
| Hash operations per request | **1** | **n**, one per stored key |
| Indexable? | Yes | **No** - every row has a distinct salt, so `WHERE hash = ?` is impossible |

Slow password hashing exists because passwords have low entropy and must be
expensive to guess. An API key has 256 bits of entropy from a CSPRNG; brute
force is not a threat model, so the slowness buys nothing while making lookup
unimplementable. bcrypt here is not merely slower - it is structurally the wrong
tool.

## Prefix representation

The `prefix` column stores `lmz_<env>_` plus the first 6 characters of the
secret, giving a display form like `lmz_dev_A7xK2p...`.

**The prefix plays no part in authentication.** It exists so the admin panel and
support conversations can identify a key ("the one starting A7xK2p") without
anyone handling the secret. It is deliberately not used to narrow the lookup,
because that would index a fragment of the secret for no benefit.

## Rotation and the grace period

| State | `status` | Authenticates? |
|---|---|---|
| New key | `ACTIVE` | Yes |
| Previous key, during grace | `ROTATING` with `expiresAt = now() + 24h` | Yes, until `expiresAt` |
| Previous key, after grace | `ROTATING`, expired | No |
| Revoked key | `REVOKED` with `revokedAt` | No, immediately |

Rotation without a grace window would mean every rotation is an outage: the
company cannot deploy the new key to all of its servers atomically. The grace
window is configurable and defaults to 24 hours.

Revocation is the separate, emergency path for a leaked key, and has no grace.

## Expiry enforcement

```sql
SELECT id, company_id FROM api_keys
 WHERE key_hash = $1
   AND status IN ('ACTIVE', 'ROTATING')
   AND revoked_at IS NULL
   AND (expires_at IS NULL OR expires_at > now());
```

The lifecycle conditions live in the `WHERE` clause rather than in an `if` after
the query. A future code path can forget an `if`; it cannot forget a condition
that prevents the row from being returned at all.

## Protecting the secret from logs, risk R-08

| Channel | Control |
|---|---|
| Request headers | A redaction interceptor scrubs `x-api-key` and `authorization` before any log write |
| Exception responses | The global exception filter never echoes request headers |
| Free-text logs | A scrubber replaces anything matching the key pattern |
| URLs | Keys travel in a header only. Query strings are logged by proxies, CDNs and browsers |
| DTOs | The key is never part of a DTO; it is read from the header and hashed immediately |
| HTTP responses | Plaintext appears exactly once, in the create or rotate response |
| Database | No column holds plaintext |

## Failure modes

| Failure | Effect | Mitigation |
|---|---|---|
| Plaintext logged | Full tenant compromise | Redaction interceptor plus a test asserting the key never appears in captured log output |
| Weak generator | Keys become guessable | CSPRNG only; a unit test asserts length and alphabet |
| Expiry checked in code, not SQL | An expired key keeps working on one forgotten path | Conditions live in the `WHERE` clause |
| Key accepted from a query string | Leak via access logs | Header-only extraction; a test asserts a query-string key is rejected |

## Test strategy

- Unit: generated keys have the expected prefix, length and alphabet; two
  generations never collide.
- Unit: the redaction interceptor removes the key from a representative log line.
- Integration: a valid key authenticates and resolves the correct company.
- Integration: revoked, expired and unknown keys all return `401`.
- Integration: after rotation, both keys work during the grace window and only
  the new one works after it.
- Integration: the plaintext key appears in the rotation response and in no
  subsequent `GET`.
