# F07 - Test matrix

**23 new backend tests** and **8 new frontend unit tests**, plus browser
verification against the real Docker stack - including a genuine two-session
concurrency test.

| | Before F07 | New | After |
|---|---|---|---|
| API suites | 30 | 1 | **31** |
| API tests | 422 | 23 | **445** |
| Web suites | 2 | 0 | **2** |
| Web tests | 22 | 8 | **30** |

> `PASS` means executed and the assertion held. `PASS (browser)` means verified
> by looking at the running application, with the evidence named. Nothing here
> is marked PASS without being run.

---

## 1. Backend - `apps/api/test/policy/policy.e2e-spec.ts`

| ID | Scenario | Expected | Result |
|---|---|---|---|
| F07-B01 | Manager reads own policy | The company's four fields plus its currency | **PASS** |
| F07-B02 | Manager updates permitted fields | Persisted, and read back | **PASS** |
| F07-B02b | A field left out of the PATCH | **Unchanged**, not cleared | **PASS** |
| F07-B02c | Empty body | 400 - a 200 would claim a save that did not happen | **PASS** |
| F07-B03 | Invalid monetary limit | 400 for negative, fractional, string, over the `int4` ceiling. **Zero accepted** | **PASS** |
| F07-B04 | Invalid frequency configuration | 400 for 0, negative, fractional, window 0, window 1441 | **PASS** |
| F07-B05 | Invalid blocked category | 400 for a bare string, a number, empty, 65 chars, 101 entries. **Empty list accepted** | **PASS** |
| F07-B06 | Duplicate categories | Collapse **after** normalising: 4 in, 2 out | **PASS** |
| F07-B07 | Casing and whitespace | `"  casino   games "` stored as `CASINO GAMES` - the same form `normaliseCategory` gives an expense | **PASS** |
| F07-B07b | …and the rule actually fires | A real expense in `Casino Games` is **REJECTED** with `BLOCKED_CATEGORY` | **PASS** |
| F07-B08 | Body carrying `companyId` | 400, and the other company untouched | **PASS** |
| F07-B09 | Two companies read different policies | Every numeric field differs - so B09b is not a coincidence | **PASS** |
| F07-B09b | Company A updates | Company B unchanged | **PASS** |
| F07-B10 | Unauthenticated | 401 on GET and PATCH | **PASS** |
| F07-B11 | Company API key | 403 `caller_type_not_allowed` on both | **PASS** |
| F07-B12 | Platform admin | 403 `insufficient_role` on both | **PASS** |
| F07-B13 | Missing CSRF header / foreign Origin | 403 both ways | **PASS** |
| F07-B14 | Policy change, then a **new** expense | Judged by the updated policy; the rule hit records the new limit | **PASS** |
| F07-B15 | Policy change, then an identical **retry** | Original decision returned, `duplicate: true`, same id | **PASS** |
| F07-B16 | An already-evaluated expense | Snapshot, decision, status and rule hits unchanged | **PASS** |
| F07-B17 | A resolved review | State, outcome, reviewer and timestamp unchanged | **PASS** |
| F07-B18 | A rejected update | Policy **byte-identical**, including `updatedAt` - no partial write | **PASS** |
| F07-B19 | Response shape | No `id`, no `companyId` | **PASS** |
| F07-B20 | F03-F06 guarantees | 422 pre-existing tests still pass | **PASS** |

### Review endpoints

Not retested here. `GET /v1/reviews`, `GET /v1/reviews/:id` and
`POST /v1/reviews/:id/resolve` are F05's, covered by its 66 tests including
F05-NC1, and F07 changed none of them. Re-asserting them would be duplication,
not coverage.

---

## 2. Frontend unit - `apps/web/lib/format.spec.ts`

Run under `TZ=America/New_York`, so a timezone-dependent bug cannot hide behind
the machine's own locale.

| ID | Scenario | Result |
|---|---|---|
| F07-F23 | `"1250.00"` → 125000, `"500"` → 50000, `"0.01"` → 1 | **PASS** |
| F07-F23b | **Float arithmetic measured, not assumed**: `8.2*100 = 819.9999999999999`, `Math.round(1.005*100) = 100` (should be 101). The string path gets all three right | **PASS** |
| F07-F23c | Excess precision **refused**, not rounded | **PASS** |
| F07-F23d | Zero-decimal currency: `"1000"` JPY → 1000; `"10.00"` JPY refused | **PASS** |
| F07-F23e | Empty, whitespace, negative, letters, grouping commas, `1.2.3`, `1e5` | **PASS** - all refused |
| F07-F23f | Leading zeros | `"0500.00"` → 50000 | **PASS** |
| F07-F23g | Past the safe-integer range | Refused | **PASS** |
| F07-F23h | Round trip through the editable string, including the `int4` ceiling | **PASS** |
| F07-F23i | The editable form carries no grouping separators | **PASS** |

---

## 3. Frontend behaviour - real browser

`docker compose up`, signed in as the seeded managers.

| ID | Scenario | Result | Evidence |
|---|---|---|---|
| F07-F01 | Manager opens reviews | The company's own open review | `f07-reviews-1440.png` |
| F07-F02 | No open reviews | "Nothing waiting for a decision", with a way to see all | Observed after the conflict test |
| F07-F03 | Review details | Expense, employee, amount, dates, policy snapshot, review metadata | `f07-review-detail-1440.png` |
| F07-F04 | Triggered reasons | `FREQUENCY` with count **including this one**, maximum and window | `f07-review-detail-1440.png` |
| F07-F05 | Approve | "Approved by Nour Hassan", badges become Approved / Approved by a manager | `f07-approved-1440.png` |
| F07-F06 | Reject | Verified through the second manager's session; badges became Rejected / Rejected by a manager | `f07-conflict-1440.png` |
| F07-F07 | Resolved review | Read-only - the action buttons are gone | `f07-approved-1440.png` |
| F07-F08 | Duplicate clicks | Both buttons disabled while either request is in flight | `resolve-actions.tsx`, `busy` |
| F07-F09 | Pending | Spinner and `aria-busy` on the pressed button, both disabled | `Button` `pending` |
| F07-F10 | **Concurrent conflict** | **PASS (browser)** - see below | `f07-conflict-1440.png` |
| F07-F11 | After resolution | The review left the OPEN queue; the empty state appeared | Snapshot: "0 reviews shown" |
| F07-F12 | After resolution | Dashboard moved to Rejected **3**, "1 rejected by a manager" | `f07-dashboard-after-resolve.png` |
| F07-F13 | Ambiguous network failure | **PASS (browser, F09)** - both failure modes injected with real request interception and checked against PostgreSQL. See [F09](F09-test-matrix.md#2-f07-f13---network-failure-recovery). One defect found and fixed (AI_LOG 46) | F09-N01 to N12 |
| F07-F14 | Unauthorized session | 401 redirects to `/login?reason=expired` | Shared with F06-T36 |
| F07-F15 | Review not found | "That review is not here" via the 404/400 branch | `review-detail-view.tsx` |
| F07-F16 | Policy initial load | Real configuration: 500.00, 3 / 60, GAMBLING | `f07-policy-1440.png` |
| F07-F17 | Edit a field | "You have unsaved changes", Discard appears, Save enables | Observed |
| F07-F18 | Invalid values | Inline `role="alert"` message, Save disabled | `Field` + `parseMajorUnits` |
| F07-F19 | Save succeeds | One `PATCH` then one `GET`; "Last changed" updates; Save disables | Network log |
| F07-F20 | Save fails | `Alert` with the API's message, nothing changed | `policy-form.tsx` |
| F07-F21 | Unsaved changes | Warned, with a Discard action that restores the loaded values | Observed |
| F07-F22 | Category add and remove | Normalised on add, duplicates ignored, chip removal | Observed |
| F07-F23 | Money conversion | `750.50` typed → **75050** stored, verified in PostgreSQL | psql + `f07-policy-saved.png` |
| F07-F24 | Read-only fields | None - all four are editable by contract (see the feature doc) | **NOT APPLICABLE**, justified |
| F07-F25 | Session switch | Unchanged from F06-T37: the provider is keyed by `user.id` | F06-T37 |
| F07-F26 | Loading states | Skeletons at the real shape on all three pages | `f07-policy-390.png` and observed |
| F07-F27 | Mobile review queue | Usable at 390 | `f07-reviews-390.png` |
| F07-F28 | Mobile review details | Actions full-width, nothing clipped | Observed at 390 |
| F07-F29 | Mobile policy form | Fields stack, no overflow | `f07-policy-390.png` |
| F07-F30 | Keyboard | Dialog traps focus, Escape closes, focus returns - the same Radix behaviour verified in F06-T46 | F06-T46 |

### F07-F10 in detail - how the conflict was actually produced

Not simulated. Two **independent authenticated sessions**:

1. A second manager was created for Nile **for this verification only**, with a
   generated password. The production seed was not touched.
2. Browser: manager A opens the review. It reads OPEN.
3. `curl`, manager B's own session: `POST .../resolve {"decision":"REJECT"}`
   → **200**, `state: RESOLVED`, `outcome: REJECTED`, expense `REJECTED`.
4. Browser: manager A presses **Approve** and confirms.
5. **409.** The page shows *"Rejected by Verify Manager B. They resolved it
   before your decision reached the server, so yours was not applied."*

What was checked afterwards:

| | |
|---|---|
| Was A's decision shown as successful? | **No** - at no point did the page say Approved |
| Does it show the real outcome? | **Yes** - Rejected, by name, with the timestamp |
| Are further actions prevented? | **Yes** - the buttons are gone |
| Did the queue refresh? | **Yes** - "0 reviews shown" |
| Did the dashboard refresh? | **Yes** - Rejected 3, "1 rejected by a manager" |
| Any retry loop? | **No** - `retry: false` |
| Console | One expected `409` entry. No uncaught errors |

All verification data was removed afterwards: the policy restored, the demo
expense deleted, the seeded review returned to OPEN, and the test-only manager
and its sessions deleted. The database was confirmed back at **12 expenses,
3 reviews, 1 open, 3 users**.

---

## 4. What is NOT covered

| Gap | Why |
|---|---|
| ~~F07-F13, an injected network failure mid-mutation~~ | **Closed in F09.** Both modes injected in a real browser and verified against the database; the gap it was hiding is AI_LOG 46 |
| Automated frontend **interaction** tests | No DOM runner was added (R-23). Behaviour is browser-verified and recorded as such |
| Concurrent policy edits | Last-write-wins is documented (R-31), not tested - there is no conflict behaviour to assert |
| Load or performance testing | Not performed anywhere in this repository |
| Accessibility conformance | Principles targeted, specific criteria checked. No conformance claim |
