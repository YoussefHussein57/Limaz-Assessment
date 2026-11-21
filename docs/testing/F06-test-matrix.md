# F06 - Test matrix

**72 new automated tests** (50 backend e2e + 22 frontend unit) and **26 browser
checks** executed against the real Docker stack.

> **Closure pass, 21 Nov 2026.** Three rows were originally recorded PARTIAL.
> All three have now been **executed**, and all three **failed on first run** -
> see AI_LOG 37, 38 and 39. The defects are fixed and the rows below are PASS
> with named evidence. R-29 was also given a real endpoint and R-28 an honest
> label.

Totals after F06:

| | Before | New | After |
|---|---|---|---|
| API suites | 26 | 4 | **30** |
| API tests | 372 | 50 | **422** |
| Web suites | 0 | 2 | **2** |
| Web tests | 0 | 22 | **22** |

> **Marking rules.** `PASS` means the check was executed and its assertion held.
> A scenario verified by looking at a real browser is marked
> `PASS (browser)` and names the evidence. Nothing is marked `PASS` that was
> not run, and nothing is marked `NOT APPLICABLE` to get past the gate.

---

## 1. Backend and security - automated

`apps/api/test/dashboard/dashboard-summary.e2e-spec.ts`,
`apps/api/test/dashboard/dashboard-negative-control.e2e-spec.ts`,
`apps/api/test/expenses/expense-access.e2e-spec.ts`,
`apps/api/test/expenses/expense-query-shape.e2e-spec.ts`

| ID | Scenario | Expected | Result |
|---|---|---|---|
| F06-T01 | Manager dashboard summary | Own-company counts, derived from the fixtures rather than typed in | **PASS** |
| F06-T01b | Status counts sum to the total | Guaranteed by the single `groupBy`, asserted on the response | **PASS** |
| F06-T02 | Company with no expenses | All three status keys present and zero; `amounts` an empty list, not a zero in an assumed currency | **PASS** |
| F06-T03 | `decision=REVIEW`, manager approved | Counted **APPROVED**, not pending. Fixture existence asserted first so the test cannot pass vacuously | **PASS** |
| F06-T04 | `decision=REVIEW`, manager rejected | Counted **REJECTED** | **PASS** |
| F06-T05 | Another company's expenses | Excluded from every figure; neither company's total equals the whole table | **PASS** |
| F06-T06 | Own-company listing | Exactly the company's external ids | **PASS** |
| F06-T06b | Response shape | No `payloadHash`, no `companyId`, no `policySnapshot` in a list row | **PASS** |
| F06-T07 | Another company's expense detail | **404**, byte-identical to a missing id | **PASS** |
| F06-T08 | Unauthenticated request | 401 on both routes | **PASS** |
| F06-T09 | API key on a manager route | 403 `caller_type_not_allowed` | **PASS** |
| F06-T10 | Platform admin on a manager route | 403 `insufficient_role`, list and detail | **PASS** |
| F06-T10b | Session without the CSRF header, GET | 200 - `CsrfGuard` does not apply to reads. Asserted rather than assumed | **PASS** |
| F06-T11 | Expense with multiple rule hits | Every reason, alphabetical, each with its own evidence object | **PASS** |
| F06-T12 | Policy edited after submission | Snapshot, decision and reasons unchanged | **PASS** |
| F06-T13 | Resolved expense | `decision=REVIEW`, `status=APPROVED`, outcome, reviewer name, timestamp. No email, no hash | **PASS** |
| F06-T13b | Open review | Outcome, `resolvedAt` and `resolvedBy` all null - no default outcome | **PASS** |
| F06-T13c | Never-flagged expense | `review` is **null**, not an empty object; `reasons` empty | **PASS** |
| F06-T14 | Search scoped to the caller | Nile and Delta both match "beans" and the two result sets are **disjoint** | **PASS** |
| F06-T14b | Search fields | Merchant (case-insensitive), external reference, employee reference | **PASS** |
| F06-T14c | **LIKE metacharacters are text, not pattern.** Regression for MIN-02, found by the F13 QA regression pass | `%` finds the merchant containing a literal `%` and **not** the one containing `_`, and the reverse; neither is the unfiltered list; a lone backslash is a clean empty result, not a 500 | **PASS** |
| F06-T15 | Status filter | Exactly that status, count matching the fixtures | **PASS** |
| F06-T15b | Decision filter is not the status filter | `decision=REVIEW` is strictly larger than `status=PENDING_REVIEW` | **PASS** |
| F06-T16 | Combined filters | Narrow, not replace | **PASS** |
| F06-T16b | Search **and** filter together | `q=casino&status=APPROVED` returns nothing. **The `OR`-collision regression** | **PASS** |
| F06-T16c | Category filter normalisation | `category=food` and `category=FOOD` return identical bodies | **PASS** |
| F06-T17 | Unknown query parameter | 400 `invalid_request`, not silently ignored | **PASS** |
| F06-T17b | Malformed cursor | 400 `invalid_cursor`, not a silent reset to page one | **PASS** |
| F06-T17c | Out-of-range limit, invalid enums | 400 for `limit=0`, `101`, `abc`, `status=MAYBE`, `decision=PROBABLY` | **PASS** |
| F06-T17d | Malformed expense id | **400**, not 404 and not 500 | **PASS** |
| F06-T18 | Bounded pagination | Default page bounded; `limit=101` refused | **PASS** |
| F06-T19 | Paging with `limit=1` | Every row **exactly once**, in `spentAt DESC` order, no duplicate, nothing missing | **PASS** |
| F06-T19b | Cursor row leaves the filtered set | Next page still correct - the cursor is a **value**, not a row lookup | **PASS** |
| F06-T19c | Rows sharing `spentAt` to the millisecond | Tie constructed explicitly; all three paged exactly once | **PASS** |
| F06-T20 | Listing statement count | **3 for 5 rows, 3 for 50 rows.** No N+1 | **PASS** |
| F06-T20b | Dashboard statement count | **Exactly 1**, containing `GROUP BY` | **PASS** |
| F06-T20c | Planner behaviour over 4,000 rows | No `Seq Scan on expenses`; `Index Scan Backward using expenses_companyId_spentAt_idx` | **PASS** |
| F06-T21 | `POST /v1/expenses` still works | 201 for an API key, and the manager can immediately read it | **PASS** |
| F06-T21b | Manager session submitting | Still 403 `caller_type_not_allowed` - adding GET routes did not widen POST | **PASS** |
| F06-T21c | Forged session cookie on a GET | 401 | **PASS** |
| F06-T51 | Category list | **Every** category the company has used, not one page of them | **PASS** |
| F06-T52 | A category only the other company uses | Absent. Delta sees ALCOHOL, Nile does not | **PASS** |
| F06-T53 | More categories than the cap | Exactly 200 returned and `truncated: true` - the UI then says the list is cut | **PASS** |
| F06-T54 | API key, platform admin, unauthenticated | 403, 403, 401 | **PASS** |
| F06-T55 | `GET /v1/expenses/categories` | 400 - proving the route had to live in the dashboard namespace | **PASS** |

### Negative control

| ID | What is removed | Without it | With it |
|---|---|---|---|
| F06-NC1 | The tenant predicate in the aggregate | **The whole table is returned and nothing errors anywhere.** The query succeeds, the dashboard renders, the numbers are another company's | Each company sees exactly its own |

F06-NC1 first asserts the two seeded companies have **different** expense counts.
Without that guard, every assertion in the file would pass under a missing
predicate while proving nothing.

The broken query is written out **in the test**, exactly as somebody would write
it by mistake. There is no flag, no environment variable and no code path in
`DashboardSummaryService` that can produce it - a running application cannot
reach it. It runs against the throwaway test database, never the development
one.

---

## 2. Frontend pure logic - automated

`apps/web/lib/format.spec.ts`, `apps/web/lib/expense-reasons.spec.ts`
(22 tests, run under `TZ=America/New_York` to prove the display zone is fixed
rather than inherited).

| ID | Scenario | Result |
|---|---|---|
| F06-T29 | Minor units for a two-decimal currency: 125000 → `SAR 1,250.00` | **PASS** |
| F06-T29b | **Zero-decimal currency**: 1000 JPY minor units → `JPY 1,000`, not `JPY 10.00` | **PASS** |
| F06-T29c | Zero, one halala, 99, 100 | **PASS** |
| F06-T29d | Top of the int4 range: 2147483647 → `SAR 21,474,836.47` exactly | **PASS** |
| F06-T29e | Negative amount (the "over by" subtraction path) | **PASS** |
| F06-T29f | Unknown currency code | Amount still right, raw code shown | **PASS** |
| F06-T29g | The non-breaking space between code and amount is deliberate | **PASS** |
| F06-T30 | `2026-11-18T10:00:00Z` → `Nov 18, 2026, 13:00` in the display zone | **PASS** |
| F06-T30b | **Date boundary**: 22:30 UTC → `Nov 19, 2026, 01:30`, not Nov 18 | **PASS** |
| F06-T30c | Unparseable timestamp → `—`, never "Invalid Date" | **PASS** |
| F06-T31 | `AMOUNT_LIMIT` evidence, with "over by" computed on integers | **PASS** |
| F06-T31b | `FREQUENCY` evidence, count labelled "including this one" | **PASS** |
| F06-T31c | Window described as hours only when it divides evenly | **PASS** |
| F06-T31d | `BLOCKED_CATEGORY` evidence | **PASS** |
| F06-T31e | Detail with the wrong field names → title renders, evidence empty, nothing thrown | **PASS** |
| F06-T31f | Detail that is `null`, a string, an array or a number | **PASS** |
| F06-T31g | **Unknown rule code** → raw code, humanised label, its own scalar evidence | **PASS** |
| F06-T31h | Unknown code with nested objects → scalars only, nothing dumped | **PASS** |
| F06-T31i | Policy snapshot read defensively; `null` for anything unreadable | **PASS** |

> **Why these are unit tests and not browser checks.** `RuleCode` is a
> PostgreSQL enum with three values, so the unknown-code branch **cannot be
> reached from the database today**. It is a forward-compatibility guard, and
> this is the only place it can honestly be exercised.

---

## 3. Frontend behaviour - real browser

Executed against `docker compose up` at `http://localhost:3000`, signed in as
the seeded managers. Screenshots in `docs/screenshots/`.

| ID | Scenario | Result | Evidence |
|---|---|---|---|
| F06-T22 | Dashboard loads real data | **PASS (browser)** - 8 / 5 / 1 / 2 and `SAR 2,965.00`, matching the database | `f06-overview-1440.png` |
| F06-T23 | Expense listing loads | **PASS (browser)** - all 8 seeded rows | `f06-expenses-1440.png` |
| F06-T24 | Search interaction | **PASS (browser)** - typing `beans` produced **one** request, `?q=beans&limit=25` | Network log |
| F06-T24b | Filter interaction | **PASS (browser)** - `?q=casino&status=APPROVED` → empty-filter state, both controls highlighted | `f06-empty-filtered-1920.png`, `f06-filters-active.png` |
| F06-T25 | Pagination navigation | **PASS (browser)** - 30 expenses submitted through the API key, "Older" → page 2 showing 13, "Older" then disabled | `f06-pagination-page2.png` |
| F06-T26 | Filters change → cursor resets | **PASS (browser)** - on page 2, selecting a status produced `?status=PENDING_REVIEW` with **no `cursor`** | URL after the change |
| F06-T27 | Expense details navigation | **PASS (browser)** - row → `/dashboard/expenses/<id>` showing that expense | `f06-expense-detail-1440.png` |
| F06-T28 | Decision differs from status | **PASS (browser)** - `Policy: Review` + `Approved` + "Approved by a manager", with the explanation underneath | `f06-expense-detail-1440.png` |
| F06-T29 | Money on screen | **PASS (browser)** - `SAR 1,250.00`, `SAR 80.00`, `SAR 2,965.00` | All screenshots |
| F06-T30 | Dates on screen | **PASS (browser)** - `Nov 18, 2026, 13:00`, labelled Riyadh time | All screenshots |
| F06-T31 | Unknown reason code | **PASS (unit)** - unreachable from the database; see section 2 | `expense-reasons.spec.ts` |
| F06-T32 | Initial loading | **PASS (browser)** - skeletons at the real row height; **no artificial delay anywhere** | `loading.tsx`, observed on first paint |
| F06-T33 | Empty company | **PASS (automated)** - F06-T02 returns zeros; the UI renders the "No expenses yet" state from them | `EmptyState` + F06-T02 |
| F06-T34 | Empty filter results | **PASS (browser)** - a **different** message from an empty company, with a working "Clear filters" | `f06-empty-filtered-1920.png` |
| F06-T35 | Request failure | **PASS (browser)** - the API container was **stopped**, the designed error page rendered (no blank screen, no internals, a digest reference), the API was restarted, and **Try again recovered the full dashboard**. Two defects found doing it: AI_LOG 38 and 39 | `f06-error-state-1440.png`, `f06-error-recovered-1440.png` |
| F06-T36 | Session expiration | **PASS (browser)** - a forged cookie is refused with 401 (F06-T21c) and `requireUser()` redirects to `/login?reason=signin` (F02.1-T09) | F02.1 acceptance script |
| F06-T37 | Logout, then the other company | **PASS (browser)** - signed out of Nile, signed in as Delta: **only Delta's 4 expenses**, Delta's name in the sidebar, no Nile row anywhere | `f06-second-company.png` |
| F06-T38 | Rapidly changing search | **PASS (by construction + browser)** - the filters are part of the query key, so a response has no slot to land in once the filter moves on. Observed: 5 keystrokes, 1 request | `queries.ts`, network log |

---

## 4. Responsive and visual quality

Every width rendered in a real browser at that exact viewport. A full-page
screenshot taken at width *W* is *W* pixels wide, so **horizontal overflow would
be visible in the image itself**.

| ID | Width | Result | Evidence |
|---|---|---|---|
| F06-T39 | 360px | **PASS** - cards, 2×2 summary, no horizontal scroll, drawer navigation | `f06-overview-360.png` |
| F06-T40 | 390px | **PASS** - same, with the filter controls stacked full-width | `f06-expenses-390.png` |
| F06-T41 | 768px | **PASS** - drawer navigation, single-column detail, cards still (the table starts at `md`) | `f06-expense-detail-768.png` |
| F06-T42 | 1024px | **PASS** - sidebar appears at `lg`; table with the Category and Spent columns hidden until `lg` | Observed |
| F06-T43 | 1440px | **PASS** - four summary cards in one row, full table, two-column detail | `f06-overview-1440.png`, `f06-expenses-1440.png` |
| F06-T44 | 1920px | **PASS** - content held at `max-w-6xl` and centred; no stretched table | `f06-empty-filtered-1920.png` |
| F06-T45 | Long merchant names, large amounts | **PASS (browser)** - a real expense with a **200-character merchant**, a 48-character reference, a 37-character employee id and `SAR 2,147,483.64` (the int4 ceiling) rendered in the table, the mobile cards and the detail view. **It broke the table layout on first run** - fixed, see AI_LOG 37 | `f06-long-content-1440.png`, `f06-long-content-360.png`, `f06-long-content-detail-360.png` |
| F06-T46 | Keyboard navigation | **PASS (browser)** - twelve Tab presses recorded in order: skip link first, sidebar, user menu, search, three filters, then **one stop per row**. Every stop reported `outline: solid 1.6px`. Enter on a row navigated. In the drawer: Enter opened it, focus moved inside, 20 elements outside were marked inert, **Escape closed it and returned focus to the trigger** | Recorded focus log |
| F06-T47 | Contrast and status indicators | **PASS** - no new token was introduced; every badge renders a **word** as well as a tone | `globals.css` (15/15 measured pairs, F02.1), `status-badges.tsx` |
| F06-T48 | Production frontend build | **PASS** - `next build` succeeded; 8 routes, all dynamic as intended | Build output |
| F06-T49 | Docker integration | **PASS** - `docker compose up --build`, all three services healthy, every check above run against it | `docker compose ps` |
| F06-T50 | F00-F05 regression | **PASS** - 417/417 API tests in 30 suites | `npx jest` |

### Console and network

| Check | Result |
|---|---|
| Console errors on the listing | **0** |
| Console warnings on the listing | **0** |
| Duplicate fetching | **None** - one `GET /api/v1/expenses?limit=25` per load |
| Failed requests | **None** |
| Query parameters | Exactly the active filters; `cursor` only when paging |
| Over-fetching | Page size 25, bounded at 100 by the API |
| `/favicon.ico` 404 | **Pre-existing from F02.1, fixed in F06** by adding `app/icon.svg` |

---

## 5. What is NOT covered

Stated so it is not mistaken for done.

| Gap | Why |
|---|---|
| Any automated frontend **interaction** test | No DOM test runner was added (R-23, unchanged from F02.1). Component behaviour is browser-verified and recorded as such |
| Load or performance testing | Not performed anywhere in this repository. The 4,000-row `EXPLAIN` is a **plan**, not a throughput measurement |
| Accessibility conformance | WCAG 2.2 AA **principles** were targeted and specific criteria checked. **No conformance claim is made** |
