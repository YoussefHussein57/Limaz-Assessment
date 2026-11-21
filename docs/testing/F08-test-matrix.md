# F08 - Test matrix

**42 new backend tests** (36 e2e + 6 unit), plus browser verification against
the real Docker stack.

| | Before F08 | New | After |
|---|---|---|---|
| API suites | 31 | 3 | **34** |
| API tests | 445 | 42 | **487** |
| Web suites | 2 | 0 | **2** |
| Web tests | 30 | 0 | **30** |

> `PASS` means executed and the assertion held. `PASS (browser)` means
> verified against the running application, with the evidence named.

---

## 1. Authorization and company management

`apps/api/test/admin/admin-companies.e2e-spec.ts`

| ID | Scenario | Expected | Result |
|---|---|---|---|
| F08-B01 | Admin lists companies | Both companies - across tenants, which no other endpoint allows | **PASS** |
| F08-B02 | Manager lists companies | 403 `insufficient_role` | **PASS** |
| F08-B02b | Manager creates a company / reads keys | 403, and **nothing was created** | **PASS** |
| F08-B03 | API key lists companies | 403 `caller_type_not_allowed` | **PASS** |
| F08-B04 | Unauthenticated | 401 | **PASS** |
| F08-B05 | Valid creation | Company, policy and first key together; `sar` uppercased to `SAR`; categories normalised and deduplicated (3 in, 2 out) | **PASS** |
| F08-B05b | Creation without a policy block | Defaults applied: 50000 / 3 / 60 / none | **PASS** |
| F08-B06 | Invalid payload | 400 for empty name, bad currency, negative limit, zero count, missing name | **PASS** |
| F08-B08 | Unknown property (`autoApproveLimit`) | **400**, not silently dropped - a quietly ignored field means a company configured differently from what somebody believes | **PASS** |
| F08-B09 | Company creation includes its policy | Asserted in B05 | **PASS** |
| F08-B10 | Failed creation | Company count unchanged; no orphan row | **PASS** |
| F08-B10b | **Every** company in the database | Has a policy and at least one key - the invariant, not just the rows this suite made | **PASS** |
| F08-B11 | Company details | Safe metadata; no `keyHash`, `passwordHash`, `tokenHash`; **no expenses** | **PASS** |
| F08-B12 | Unknown company / malformed id | 404 / **400** - an unusable id is a different fact from a missing row | **PASS** |
| F08-B13 | Pagination with `limit=1` | Every company exactly once; `limit=101` refused | **PASS** |
| F08-B13b | Search by name | Correct single match | **PASS** |
| F08-B14 | Missing CSRF header / foreign Origin | 403 both ways, and nothing created | **PASS** |
| F08-B15 | **End to end** | The new company's key authenticates a real submission, and the policy created in the same transaction decides it (`autoApproveLimitMinor: 10000`) | **PASS** |

---

## 2. API key lifecycle

`apps/api/test/admin/api-key-lifecycle.e2e-spec.ts`

| ID | Scenario | Expected | Result |
|---|---|---|---|
| F08-B16 / B21 | Issued key authenticates | A real expense submitted with it, 201 | **PASS** |
| F08-B17 / B18 | Manager / API key issues a key | 403 both | **PASS** |
| F08-B19 | Issue for a missing company | 404 | **PASS** |
| F08-B20 | Persisted representation | `keyHash === sha256(plaintext)`; **the plaintext appears nowhere in the table**, checked across every column | **PASS** |
| F08-B22 | Key listing | No plaintext, no `keyHash`; prefix and state only | **PASS** |
| F08-B23 | Key carries company identity | The expense lands on the key's company, taken from the matched row | **PASS** |
| F08-B24 | Five generated keys | All distinct, each 43 base64url characters | **PASS** |
| F08-B24b | Generator unit tests | Six cases - see section 3 | **PASS** |
| F08-B25 | Failure before commit | Covered by B33 | **PASS** |
| F08-B26 | Issuance response caching | No `public`, no positive `max-age` | **PASS** |
| F08-B27 | Rotate an active key | 200, replacement issued, original → `ROTATING` with an expiry | **PASS** |
| F08-B28 | New key after rotation | Authenticates | **PASS** |
| F08-B29 | Old key during grace | **Still authenticates** - without this every rotation is an outage | **PASS** |
| F08-B29b | Grace length | Within a minute of 24 hours, per ADR-006 | **PASS** |
| F08-B30 | Old key after grace | 401, and **byte-identical** to an unknown key's refusal | **PASS** |
| F08-B31 | Rotate a revoked / already-rotating key | 409 with a message naming the real state | **PASS** |
| F08-B32 | Rotate with a mismatched company | 409, and the other company's key **unmutated** | **PASS** |
| F08-B33 | Rotation whose conditional update fails | **No orphan replacement** - the key count is unchanged | **PASS** |
| F08-B34 | **Two concurrent rotations** | Exactly `[200, 409]`, and exactly **one** new row | **PASS** |
| F08-B35 / B36 | Revoke | Works before, 401 immediately after | **PASS** |
| F08-B37 | Revoke twice | 200 again, and the **original `revokedAt` is unchanged** | **PASS** |
| F08-B38 | Revoke with a mismatched company | 404, target untouched, still authenticates | **PASS** |
| F08-B39 | Rotate and revoke competing | One coherent final state, and the key cannot authenticate | **PASS** |
| F08-B40 | Operations on one company | The other company's keys **byte-identical** | **PASS** |
| F08-B41 | Unknown / expired / revoked refusals | One shape for all - telling them apart tells an attacker which guess was closer | **PASS** |
| F08-B42 | Seeded keys | Still authenticate | **PASS** |

### How F08-B34 was actually made concurrent

`.then((r) => r)` on each request. Supertest's `Test` is **lazy** and does not
send until something awaits it - without that, the two requests run one after
the other and the test passes while proving nothing. That is the F05-T38
lesson (AI_LOG 29) applied here deliberately.

`DB_POOL_MAX` is 10, above the concurrency, so the requests contend in
PostgreSQL rather than queueing in the connection pool (risk R-10).

---

## 3. Key generation unit tests

`apps/api/test/admin/api-key-generator.spec.ts` - pure functions, no database.

| ID | Scenario | Result |
|---|---|---|
| F08-U01 | `NODE_ENV=production` on a **localhost** origin → `dev` | **PASS** |
| F08-U02 | Any `NODE_ENV` on a real host → `prod` | **PASS** |
| F08-U03 | `NODE_ENV=test` → `test` | **PASS** |
| F08-U04 | Unparseable origin → `prod` (conservative: a key that says `dev` on production is a reason somebody ignores a leak) | **PASS** |
| F08-U05 | Format, entropy and hash: `lmz_test_` + 43 base64url chars, `keyHash` is its SHA-256, prefix is a fixed 16-character slice | **PASS** |
| F08-U06 | 200 generated keys are all distinct | **PASS** |

U01 is the regression for AI_LOG 42 - the first version labelled development
keys `lmz_prod_`.

---

## 4. Browser verification

Signed in as the seeded platform admin, against `docker compose up`.

| ID | Scenario | Result | Evidence |
|---|---|---|---|
| F08-F01 | Admin login | Lands on the companies workspace | `f08-companies-1440.png` |
| F08-F02 | Companies page | Both seeded companies, with their active-key counts | `f08-companies-1440.png` |
| F08-F03 | Loading | Skeleton rows at the real shape | `page.tsx` fallback |
| F08-F04 | Empty state | Distinct messages for "no companies" and "no match" | `company-workspace.tsx` |
| F08-F05 | Failure | Recoverable error with a retry | `company-workspace.tsx` |
| F08-F06 | Search | Debounced, URL-backed, cursor reset | Shared with F06-T24 |
| F08-F07 | Pagination | Keyset with a cursor trail; "First page" when there is no previous | Shared with F06 |
| F08-F08 | Create form | Name, currency, limit, with defaults explained | `f08-create-company.png` |
| F08-F09 | Invalid input | Inline `role="alert"`, Create disabled | `company-workspace.tsx` |
| F08-F10 | Creation succeeds | Company appears in the list immediately | `f08-key-reveal-redacted.png` |
| F08-F11 | Duplicate submit | Button disabled while pending; `retry: false` | `company-workspace.tsx` |
| F08-F12 | Company details | Correct company, policy, accounts | `f08-company-detail-1440.png` |
| F08-F13 | Key listing | **Prefix only**; no plaintext, no hash | `f08-company-detail-1440.png` |
| F08-F14 | Key creation | Secret shown in the transient dialog | `f08-key-reveal-redacted.png` |
| F08-F15 | Copy | Clipboard with an explicit failure message if refused | `secret-reveal.tsx` |
| F08-F16 | Dismiss | **Verified**: no key field, no full key on screen, `localStorage` and `sessionStorage` both **empty**, URL clean | In-page assertion |
| F08-F17 | Return to the page | Only the prefix; the full value is unrecoverable | `f08-key-states-1440.png` |
| F08-F18 | Rotation confirmation | Names the key and explains the 24-hour grace | `f08-rotate-confirm.png` |
| F08-F19 | Rotation succeeds | New key **Active**, old key **Grace period** with its stop time, "2 working keys" | `f08-key-states-1440.png` |
| F08-F20 | Revocation confirmation | Says **immediately**, no grace, danger styling | `api-key-panel.tsx` |
| F08-F21 | Revocation succeeds | Covered by F08-B35/B36 at the API; the panel refreshes from the same query | `api-key-panel.tsx` |
| F08-F22 | Failed mutation | The API's message, which names the lifecycle state; no secret in it | `api-key-panel.tsx` |
| F08-F23 | Pending | All three mutations share one `busy`, so no two can run at once | `api-key-panel.tsx` |
| F08-F24 | Manager visits `/admin` | **403 page**, and the API refuses list **and** create with `insufficient_role` | `f08-manager-denied.png` |
| F08-F25 | Admin on manager routes | Unchanged - every expense/review route is `@Roles('MANAGER')` | F06-T10, F07-B12 |
| F08-F26 | Logout with a secret open | The dialog unmounts with the tree; state is gone | By construction |
| F08-F27 | Session switch | Provider keyed by `user.id` | F06-T37 |
| F08-F28 | Mobile companies | Usable at 390 | Observed |
| F08-F29 | Mobile create form | Fields stack, full-width actions | Observed |
| F08-F30 | Mobile key actions | Stacked, full-width, nothing clipped | `f08-company-detail-390.png` |
| F08-F31 | Keyboard dialogs | Radix traps focus, Escape closes, focus returns - verified in F06-T46 | F06-T46 |
| F08-F32 | Long names and ids | Truncation and `break-all` on the id | `company-workspace.tsx` |
| F08-F33 | **Secret handling** | See F08-F16. No storage, no URL, no cache | In-page assertion |

### A note on the screenshots

`f08-key-reveal-redacted.png` shows a **masked** key. The mask is painted over
the field before the capture, so the image never contains a credential.

A first attempt set the input's DOM value instead, React restored it from
state, and **the real key was written into the file**. That file was deleted
before any commit, never entered git history, and the key was revoked
immediately - it belonged to a throwaway company on a local database that was
then deleted. Recorded in full as AI_LOG 43.

---

## 5. What is NOT covered

| Gap | Why |
|---|---|
| Waiting out a real 24-hour grace window | F08-B30 moves `expiresAt` into the past instead. The authentication query compares it to `now()`, so the condition exercised is the same one the clock would reach |
| An automated frontend interaction test | No DOM runner (R-23). Behaviour is browser-verified and recorded as such |
| A lost issuance response | Not idempotent by nature (R-33). The documented recovery is to revoke and reissue |
| Company deletion or suspension | No such capability exists |
| Load or performance testing | Not performed anywhere in this repository |
