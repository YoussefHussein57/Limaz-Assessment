# F06 - Manager dashboard and expense management

What a manager can see. Three read endpoints and three pages, built on the
authentication, tenancy, policy and review machinery F02 to F05 already ship.

**Scope boundary:** F06 reads. It changes nothing. Approving or rejecting a
review from the dashboard is F07, and the UI says so where a reader would
otherwise look for the button.

---

## 1. What was built

### Backend - three read endpoints

| Route | Caller | Returns |
|---|---|---|
| `GET /v1/expenses` | Manager session | One keyset page of the company's expenses |
| `GET /v1/expenses/:expenseId` | Manager session | One expense: reasons, policy snapshot, review |
| `GET /v1/dashboard/summary` | Manager session | Aggregate counts and per-currency totals |

### Frontend - three pages

| Route | Rendering | Why |
|---|---|---|
| `/dashboard` | Server Component | No parameter the reader can change |
| `/dashboard/expenses` | Server shell + Client list | Filters and pagination change under the user's fingers |
| `/dashboard/expenses/[expenseId]` | Server Component | The URL is the whole state |

---

## 2. One route namespace, two kinds of caller

`POST /v1/expenses` and `GET /v1/expenses` share a path and accept **disjoint**
callers. Nothing new was written to make that work - `AuthorizationGuard`
already resolves its metadata handler-first:

```ts
const targets = [context.getHandler(), context.getClass()];
const requiredRoles = this.reflector.getAllAndOverride(REQUIRED_ROLES, targets);
const effectiveCallerTypes = requiredRoles?.length ? ['user'] : allowedCallerTypes;
```

So the decorators sit on the **methods**, not on the class - unlike
`ReviewsController`, where every route has the same answer:

| Route | Decorator | A session gets | An API key gets | The admin gets |
|---|---|---|---|---|
| `POST /v1/expenses` | `@AllowCallerTypes('api-key')` | 403 `caller_type_not_allowed` | 201/200 | 403 |
| `GET /v1/expenses` | `@Roles('MANAGER')` | 200 | 403 `caller_type_not_allowed` | 403 `insufficient_role` |
| `GET /v1/expenses/:id` | `@Roles('MANAGER')` | 200/404 | 403 | 403 |
| `GET /v1/dashboard/summary` | `@Roles('MANAGER')` | 200 | 403 | 403 |

The API-key refusal on the GET routes is **not a second rule**. `@Roles`
implies a human caller, because a key has no role - one decorator closes both
doors. Verified in F06-T09 and F06-T10.

**Why the asymmetry is right:** an expense is submitted *by* an integration, and
a person submitting one through the dashboard would bypass the system their
company actually runs (F03). Reading is the opposite case.

**On the platform admin:** denied, deliberately. A company's spending is that
company's business and no approved contract grants an administrator that
authority. F08 gives administrators explicit, company-named access rather than
letting them inherit it silently.

---

## 3. The aggregate: one statement, one snapshot

```ts
prisma.expense.groupBy({
  by: ['status', 'decision', 'currency'],
  where: { companyId },
  _count: { _all: true },
  _sum: { amountMinor: true },
})
```

### Why not four `count()` calls

Four calls are four statements, therefore four MVCC snapshots. An expense
submitted between the second and the third is counted by one and not the other,
and the dashboard shows status counts that do not sum to the total. **Nothing
errors.** The numbers are simply wrong, intermittently, in a way nobody can
reproduce.

One `groupBy` is one snapshot. The figures add up **by construction**, and
F06-T01b asserts exactly that on the response rather than on the fixtures.

Measured: **1 SQL statement** (F06-T20b).

### Why `decision` is in the grouping

The status counts answer *where do things stand*. They cannot answer *how much
did a human have to judge* - an APPROVED expense may have been auto-approved, or
flagged and then approved by a manager. Adding `decision` to the same grouping
answers both from the same snapshot at no extra statement.

### Current status, never the original decision

| Expense | decision | status | Counted as |
|---|---|---|---|
| exp-1005 | `REVIEW` | `APPROVED` | **Approved** |
| exp-1004 | `REVIEW` | `PENDING_REVIEW` | **Pending review** |
| exp-2002 | `REVIEW` | `REJECTED` | **Rejected** |

Counting exp-1005 as pending would show work that is already done. F06-T03 and
F06-T04 assert both directions.

### Currencies are never summed together

`amounts` is a **list**, one entry per currency present. Assumption A3 says a
company has exactly one currency, so in practice it holds one entry - but the
aggregate does not *depend* on that holding. A single scalar would quietly add
riyals to dollars and the dashboard would be wrong without failing.

### Documented semantics

- **All time.** There is no date filter and the page says so.
- **Current status**, not the original decision.
- **One consistent observation.** One statement, one snapshot.
- **Per currency.** Never summed across.
- `generatedAt` is when the **response was built** - strictly after the snapshot
  it reports. It is named for what it is, not for what it is near.

### Rejected alternatives

| Alternative | Why not |
|---|---|
| Counting in the browser from a fetched page | Counts the **page**, not the company. Wrong by construction past page one |
| Four `count()` calls | Four snapshots; the parts need not add up |
| Materialised or cached statistics | Adds an invalidation problem to a query that reads a handful of grouped rows, for a performance problem nobody has measured |

---

## 4. Keyset pagination - the mirror image of F05

Both listings reject offset pagination, **for opposite reasons**:

| | F05 reviews | F06 expenses |
|---|---|---|
| The set | **Shrinks** - each resolution removes a row | **Grows at the head** - submissions keep arriving |
| Rows shift | Up | Down |
| Offset's failure | **Drops** rows the reader never sees | **Repeats** rows the reader already saw |

Opposite movements, same broken tool. The cursor code now lives in
`src/common/keyset.ts`, shared by both - two implementations of one cursor
format is two chances to encode with one and decode with the other.

### Ordering: `(spentAt DESC, id DESC)`

A manager scans this list to answer *what did we spend*, which is a question
about `spentAt`.

**The trade-off, stated:** a backdated submission appears partway down the list
rather than at the top. This is **not an arrival feed**. `receivedAt` is on
every row and the detail view shows both, so the gap is always visible.

There is exactly **one** ordering. A second would need its own index and a
cursor that encodes which column it was built from - otherwise a cursor taken
under one sort and replayed under another pages through nonsense.

### Why the cursor is a pair

1. `spentAt` is `Timestamptz(3)` - **one millisecond** of resolution - and it is
   client-supplied, so a batch import stamping many expenses with one instant is
   ordinary rather than exotic.
2. `id` is a UUIDv7, which is **approximately** time-ordered - and approximately
   is not a contract. Its embedded timestamp is arrival time; `spentAt` is not.

F06-T19c constructs the tie explicitly and pages through it.

### It survives the cursor row disappearing

The cursor is compared as a **value**, never looked up as a row. F06-T19b moves
the cursor row out of the filtered set behind the reader's back and the next
page is still correct. Prisma's own `cursor` option does a row lookup and would
have returned nothing.

### Measured query shape

| Query | Statements |
|---|---|
| Listing, 5 rows | **3** |
| Listing, 50 rows | **3** |
| Dashboard summary | **1** |

Ten times the rows, the same number of statements. No claim is made that
`include` compiles to one joined query - Prisma may issue one statement per
relation *level*. The property the requirement asks for is that the count is
bounded by the **shape**, not by the number of rows, and that is what is
measured (F06-T20).

### Measured plan

`EXPLAIN (ANALYZE, BUFFERS)` over **4,000 rows**:

```
Limit  (cost=0.40..4.34 rows=26) (actual time=0.031..0.034 rows=26 loops=1)
  Buffers: shared hit=4
  ->  Incremental Sort
        Sort Key: "spentAt" DESC, id DESC
        Presorted Key: "spentAt"
        ->  Index Scan Backward using "expenses_companyId_spentAt_idx" on expenses
              Index Cond: ("companyId" = $1::uuid)
Execution Time: 0.056 ms
```

The index from F01 is chosen, and the ordering is served by a backward scan with
an incremental sort for the `id` tiebreak - four buffer hits for a page of 26.
**This is a measurement at this table size, not a guarantee**: the planner is
free to choose differently, and on a small table it rightly prefers a sequential
scan.

---

## 5. Filters

| Filter | In scope | Why |
|---|---|---|
| `q` (merchant / externalId / employeeId) | Yes | "Where is exp-1042" |
| `status` | Yes | "What is still waiting on me" |
| `decision` | Yes | **The only filter that exposes the decision/status distinction** |
| `category` | Yes | Cheap, real, and the blocked-category rule makes it meaningful |
| Date range | **No** | Optional in the brief. It would widen the cursor contract - a range bound interacts with the `spentAt` ordering - to answer a question no requirement asks |

### On search and the F03 identifier rule

F03's governing rule is **identifiers are compared exactly; content is
normalised**, and it exists so two distinct client identities cannot be merged
on **write**. Search writes nothing and a prefix match merges nothing, so
`contains` with `mode: 'insensitive'` is correct here. The category filter *is*
normalised to uppercase, because categories are stored that way (F03) and
`category=food` would otherwise match nothing and look like an empty company.

### The `AND` that is not decoration

The search term and the cursor both produce an `OR`, and an object cannot carry
two `OR` keys - the second silently replaces the first and widens the result set
past the cursor. They are combined under `AND`. F06-T16b is the regression:
`?q=casino&status=APPROVED` must return **nothing**, and would return the
rejected rows if the two collided.

### Unknown parameters are refused

`.strict()`, so `?companyId=<other>` is a **400**, not a silently ignored
parameter. A client that sends it and gets 200 back has every reason to believe
it was honoured. It was not, and never will be (F06-T17).

---

## 6. Tenant isolation

`companyId` comes from `tenantScope(principal)` and goes **into the `where` of
the query itself**, never into a check after fetching a global row. A post-fetch
check has already read another tenant's data into the process.

- A foreign expense answers **404, not 403** (ADR-003). 403 confirms the row
  exists, which turns the URL into a way to count a competitor's expenses by
  walking ids. F06-T07 asserts the two bodies are **byte-identical**.
- The nested `review` needs no tenant predicate of its own, and that is a
  guarantee rather than an oversight: `Review(expenseId, companyId)` is a
  composite foreign key onto `Expense(id, companyId)` (ADR-011), so a review
  whose company differs from its expense's is **physically unstorable**.
- Nothing internal is published. Every response is built field by field from
  rows, never spread from them - `payloadHash` would let a caller probe whether
  a guessed payload matches an expense (F03-T14c), and `resolvedBy` is narrowed
  to a display name rather than a `User`.

### The negative control

F06-NC1 removes the tenant predicate from the aggregate and asks the same
question. The result: **the whole table, and no error anywhere**. The query
succeeds, the dashboard renders, the numbers are another company's.

It first asserts that the two seeded companies have **different** expense counts,
because if they did not, every assertion in the file would pass under a missing
predicate while proving nothing.

---

## 7. Money and time

### Minor units, with no arithmetic

The obvious implementation is `format(amountMinor / 10 ** exponent)`. For this
project's range that is exact - but exact *by a margin*, not by construction.

So the decimal point is **inserted into the digit string** and the string is
handed to `Intl.NumberFormat`, which accepts one since ES2023 and parses it at
arbitrary precision. No division, no rounding, no floating point anywhere on the
path from the database integer to the screen.

The exponent is **not hard-coded to 100**. `Intl` is asked:

```ts
new Intl.NumberFormat('en-US', { style: 'currency', currency })
  .resolvedOptions().maximumFractionDigits
```

SAR and USD are 2; JPY is 0, and `1000` JPY minor units is ¥1,000 - not ¥10.00.
Dividing by 100 would be wrong by a factor of a hundred and the number would
still look plausible.

### A fixed locale and a fixed timezone

Both are fixed for the same **technical** reason, not a stylistic one: the
overview and the detail are Server Components, so the HTML is built on the
server and hydrated in the browser. A viewer-dependent format produces one
string on the server and another in the browser, and React reports a hydration
mismatch - on every row, for every viewer outside the zone.

| | Value | Shown to the reader |
|---|---|---|
| Locale | `en-US` | - |
| Timezone | `Asia/Riyadh` | "Times are shown in Riyadh time" |

**Nothing about correctness depends on the timezone.** The API returns absolute
ISO-8601 instants, the frequency window is measured in absolute time on
`spentAt` (ADR-002), and the policy engine never sees a display string. Changing
`DISPLAY_TIME_ZONE` changes what is printed and nothing else.

---

## 8. Policy reasons

Every figure comes from the **recorded rule hit**, never from the company's
current policy. Reading the live policy would show the wrong limit beside every
expense submitted before the last policy edit - and nothing about the page would
look wrong. F06-T12 changes the policy and asserts the detail view does not move.

| Code | Shown |
|---|---|
| `AMOUNT_LIMIT` | Expense amount, auto-approval limit, **over by** (integer arithmetic on minor units, then formatted) |
| `FREQUENCY` | Count **including this one**, maximum allowed, window |
| `BLOCKED_CATEGORY` | Submitted category, categories blocked at the time |

### Unknown codes degrade, they do not crash

`detail` is a `Json` column; its shape is a convention between two deployments,
not a compile-time guarantee. Each reader validates what it needs and falls back
rather than asserting - the alternative is `undefined` rendered where a currency
amount should be.

An unrecognised code renders with its raw code and whatever scalar fields its
detail carries, labelled from their key names. Not a `JSON.stringify` dump: a
manager reading "Max count: 3" learns something; a wall of braces does not. A
rule added to the backend tomorrow degrades this page to *less explanation*, not
to a blank screen (F06-T31).

The same applies to the policy snapshot: `readPolicySnapshot()` validates every
field and the page says "not in a shape this version can display" rather than
printing `undefined`.

---

## 9. Server or Client Component - the dividing line

**Client fetching where the request changes interactively; server fetching where
it does not.**

| Page | Choice | Consequence |
|---|---|---|
| Overview | Server | Figures in the first HTML. No spinner, no round trip after hydration, no JavaScript to fetch them, **no copy of a company's spending in a browser cache** |
| Expense detail | Server | Same. The URL is the entire state |
| Expense listing | **Client** | The only surface with parameters the reader changes |

Marking the whole application a Client Component to have one caching story would
mean paying for a round trip, a spinner and a bundle on pages that need none of
it.

### What TanStack Query is actually for

Three things, all of which would otherwise be hand-written:

1. **A response cannot overwrite a newer one.** The filters are part of the query
   key, so the answer to `q=cas` is written into the `q=cas` entry and nowhere
   else. This is not a race being *handled* - the two results have no shared slot
   to collide in (F06-T38).
2. `placeholderData: keepPreviousData` keeps the previous page on screen while
   the next loads, so paging does not blank the table and reflow the page.
3. The `AbortSignal` is threaded into `fetch`, so a superseded request is
   genuinely cancelled rather than left running.

### Session-scoped cache, structurally

```tsx
<QueryProvider key={user.id}>
```

A different user **unmounts** the provider and a new `QueryClient` is
constructed, so there is no cache to read from - rather than an old cache
somebody remembered to clear. The alternative, `queryClient.clear()` on logout,
works only as long as every exit path remembers to call it, and the paths include
session expiry and a back-navigation after logout.

`useState(() => new QueryClient())` is the second half: the factory runs once per
mount, where a module-level client would be shared by every session in the tab.

The leak surface is the **listing only**, because the other two pages cache
nothing in the browser at all.

### Cache settings, and why

| Setting | Value | Reason |
|---|---|---|
| `staleTime` | 30s | Navigating to an expense and back renders instantly. Zero would make "go back" a visible reload; Infinity would never notice a new submission |
| `gcTime` | 5 min | Kept while the reader is likely to come back |
| `refetchOnWindowFocus` | **false** | The listing is a table read while switching windows; refetching on return can reorder rows under a cursor mid-read |
| `retry` | No 4xx, 2 otherwise | A 401 will not become a 200 by asking again - three more attempts only delay the redirect |

### The invalidation contract for F07

Not implemented, but the keys are prefixed so it is one call per family:

```
resolve(reviewId) ⟶ invalidateQueries({ queryKey: expenseKeys.lists() })
                    invalidateQueries({ queryKey: expenseKeys.detail(id) })
                    invalidateQueries({ queryKey: ['reviews'] })
                    router.refresh()      // the Server Components
```

`lists()` without the filters matches every list query by prefix, which is why
the filters are the **last** key element rather than baked into the first.

---

## 10. Filter state lives in the URL

One source of truth, and three things fall out of it with no code: a filtered
view is a shareable link, the back button works, and reload keeps your place.

One thing is **prevented**: a second copy of the same state. Keeping both a
`useState` and a query parameter means two values that must be kept equal, and
every bug in that class looks the same - the input shows one thing and the
results show another.

**The one deliberate exception** is the search box, which holds its own *text*
while the user types and pushes to the URL after 300ms. That is a different fact
("what is in the box right now") from the one the URL owns ("what the list is
filtered by"). Driving the input's value from the URL would make every keystroke
a navigation and lose the caret mid-word.

Verified: typing `beans` produced **one** API request, not five.

**Changing a filter drops the cursor.** A cursor means "continue after this row
under *these* filters"; carrying it across a filter change asks the server to
continue a list that no longer exists, and the reader lands mid-set with no way
to tell (F06-T26).

### The honest pagination limitation

The API returns a **forward** cursor only - a keyset is a position in one
direction. The cursors already visited are kept in a stack in the component, and
"Newer" pops it.

So: a link **pasted** with a `cursor` in it starts with an empty stack, and
"Newer" from that page returns to the **first** page rather than the one before
it. Encoding the whole trail in the URL would make shared links unwieldy to pay
for a case that only arises when somebody shares a deep page. Recorded as
**R-28**.

---

## 11. Transitions

Three keyframes, all for something that **opens or closes**: the mobile drawer
(slide, 200ms), its overlay (fade, 150ms), and a page of results replacing
another (fade, 150ms).

Nothing animates to decorate. There is no entrance animation on page load, no
staggered list and no number counting up - those make an interface feel slower
the second time you use it. Below ~100ms a transition reads as a flicker; above
~250ms the interface feels like it is waiting for itself.

Every one is cancelled by the existing `prefers-reduced-motion` block.

The drawer's exit animation is only possible because Radix keeps the node
mounted and sets `data-state="closed"` - React would otherwise unmount it before
anything could play.

---

## 12. Responsive: one component, two presentations

`ExpenseRows` renders a table at `md`+ and a card list below. Both read the
**same** items and call the **same** formatters, so they cannot drift: a change
to how an amount is displayed changes both, and there is no second place for a
currency bug to hide.

**The alternative considered and rejected** was keeping the table at every width
with horizontal scroll. At 360px a nine-column table puts *Status* - the column a
manager is looking for - behind a scrollbar they may never discover. "No
essential information silently hidden" is a requirement, and that hides it.

A smaller screen gets a **different layout, not less information**: both badges,
the reference, the employee, the category and the date are on the mobile card.

The breakpoint is `md` (768px), where a table stops being *readable* rather than
where it stops fitting.

---

## 13. What was NOT built

| Not built | Why |
|---|---|
| Review resolution UI | F07. The pages say so where a reader would look for the button |
| Policy settings | F07 |
| Platform admin screens | F08 |
| Manual expense submission form | Out of scope - and a person submitting would bypass the integration (F03) |
| Charts, trends, percentage changes, activity feed | **Every one would have to be invented.** The system records no history of its own counts |
| Date-range filter | Optional in the brief; widens the cursor contract for a question nothing asks |
| Export | Not required |
| Dark mode | Explicitly excluded |
| A data-table framework | Two presentations of eight columns did not need one |
| A distinct-categories endpoint | The filter offers what the current page contains - a second request on every load to populate a convenience was not worth it. **Documented as a limitation**, R-29 |

---

## 14. Known limitations

| # | Limitation |
|---|---|
| R-28 | "Newer" from a deep-linked cursor returns to the first page, not the previous one |
| R-29 | The category filter offers categories seen on the current page, not the company's full distinct set |
| - | The listing is **not** an arrival feed; a backdated expense appears in `spentAt` order |
| - | `generatedAt` is response-build time, not the snapshot's timestamp |
| - | No load testing anywhere in this repository |
| - | Frontend behaviour (T22-T38) is browser-verified and recorded as such, not covered by an automated frontend test runner (R-23, unchanged from F02.1) |
