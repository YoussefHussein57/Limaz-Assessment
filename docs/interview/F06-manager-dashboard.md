# F06 - Interview defence

Five questions a LIMAZ interviewer could reasonably ask after reading the F06
code. Each attacks a decision actually made here.

---

## Q1 - Server Components versus Client Components

> Your overview is a Server Component and your expense listing is a Client
> Component. Why not make them both one or the other, and what did you actually
> gain from the split?

**The dividing line is whether the request changes under the user's fingers.**

Nothing on the overview has a parameter the reader can change - no search, no
filter, no pagination. So there is nothing for a client cache to be a cache
*of*. Rendering on the server puts the figures in the first HTML: no spinner on
a number, no round trip after hydration, no JavaScript shipped to fetch them,
and **no copy of a company's spending in a browser cache at all**.

The listing is the opposite. Four controls, a cursor, and a search box, all of
which change the request while the reader is looking at it.

**Why not make everything a Client Component.** It is the convenient answer and
it costs real things: a round trip and a spinner on every page that did not need
one, a bundle to download before anything appears, and - the one that actually
matters - a browser-side cache of one tenant's data on pages that had no reason
to keep any.

**Why not make everything a Server Component.** It would work. Filters would be
`searchParams`, pagination would be links, and the browser's back button would
do the paging. What it loses is specific: every keystroke becomes a server
round trip that re-renders the subtree, there is no per-request cancellation at
the network layer, and going *back* to a previous filter refetches instead of
showing the result instantly.

**What the split actually bought.** The HttpOnly session cookie is unreadable to
browser JavaScript but perfectly readable in a Server Component, so `serverFetch`
forwards it and identity is resolved before any HTML is sent. The listing goes
through the same-origin `/api/*` proxy, where the browser attaches the cookie
itself. Two fetch paths, one credential, no token anywhere in client code.

**What I would raise unprompted:** the listing page is *still* a Server
Component - it renders the heading, the company name and a `Suspense` boundary,
and only `ExpenseList` is client. The boundary is drawn around the interactive
part rather than around the route.

**Backs it up:** `app/(app)/dashboard/page.tsx`, `expenses/page.tsx`,
`components/expenses/expense-list.tsx`, `lib/api.ts`, `lib/api-client.ts`.

---

## Q2 - TanStack Query, server state and session-scoped caching

> You added a caching library for one page. Justify it - and then tell me how
> you stop one company's cached expenses being shown to the next person who
> signs in on that machine.

**Three things it does that I would otherwise have written by hand, badly.**

1. **A response cannot overwrite a newer one.** The filters are part of the
   query key, so the answer to `q=cas` is written into the `q=cas` entry and
   nowhere else. This is not a race being *handled* - the two results have no
   shared slot to collide in. The hand-written version is a request-sequence
   counter, and it is wrong the first time somebody forgets to increment it.
2. `placeholderData: keepPreviousData` keeps the previous page on screen while
   the next loads, so paging does not blank the table and reflow the page twice.
3. The `AbortSignal` is threaded into `fetch`, so a superseded request is
   genuinely cancelled rather than running to completion for a result nobody
   will read.

**Now the cache boundary, which is the real question.**

```tsx
<QueryProvider key={user.id}>
```

A different user **unmounts** the provider, and a brand-new `QueryClient` is
constructed. There is no cache to read from - rather than an old cache somebody
remembered to clear.

That distinction is the whole answer. `queryClient.clear()` on logout is the
obvious approach and it works **only as long as every exit path calls it**. The
exit paths include session expiry mid-read, a back-navigation after logout, and
whatever F07 adds. A `key` is structural: there is no path that avoids it,
because React does the unmounting.

The second half is `useState(() => new QueryClient())` - the factory runs once
per mount. A module-level client would be shared by every session in that tab,
which is the classic way one tenant's data survives a logout.

**And the honest scope:** the leak surface is the **listing only**. The overview
and the detail cache nothing in the browser, because they are server-rendered.
Verified by signing out of Nile, signing in as Delta, and going straight to the
listing - Delta's four rows, not Nile's eight.

**`staleTime` is 30 seconds** so navigating to an expense and back is instant;
zero would make "go back" a visible reload, and Infinity would never notice a
new submission. **`refetchOnWindowFocus` is off** because this is a table read
while switching windows, and refetching on return can reorder rows under a
cursor mid-read. **`retry` returns false for any 4xx** - a 401 will not become a
200 by asking again, and three more attempts only delay the redirect.

**The F07 contract is already in the keys.** They are prefixed, so
`invalidateQueries({ queryKey: expenseKeys.lists() })` matches every filter set
at once. That is why the filters are the *last* key element rather than baked
into the first.

**Backs it up:** `providers/query-provider.tsx`, `lib/queries.ts`,
`app/(app)/layout.tsx`, F06-T37, F06-T38.

---

## Q3 - Server-side pagination and filtering

> You used keyset pagination here and in F05. Is that not just a habit? And what
> breaks if I change a filter while holding a cursor?

**Same tool, opposite reasons - which is the part worth getting right.**

| | F05 reviews | F06 expenses |
|---|---|---|
| The set | **Shrinks** - every resolution removes a row | **Grows at the head** - submissions keep arriving |
| Rows shift | Up | Down |
| Offset's failure | **Drops** rows the reader never sees | **Repeats** rows the reader already saw |

So offset is not merely less elegant in either case; it is wrong in both, in
opposite directions. A cursor says "everything strictly after this value", which
neither movement affects.

**The cursor is a pair, `(spentAt, id)`,** for two reasons that are easy to state
and easy to get wrong:

1. `spentAt` is `Timestamptz(3)` - **one millisecond** of resolution - and it is
   *client-supplied*, so a batch import stamping many expenses with one instant
   is ordinary rather than exotic.
2. `id` is a UUIDv7, which is **approximately** time-ordered - and approximately
   is not a contract. Its embedded timestamp is arrival time; `spentAt` is not,
   so ordering by id alone would not match what the API promises.

F06-T19c constructs the tie explicitly and pages through it, rather than hoping
one turns up.

**It also survives the cursor row disappearing**, because the cursor is compared
as a **value**, never looked up as a row. Prisma's own `cursor` option does a row
lookup and would return nothing. F06-T19b moves the cursor row out of the
filtered set behind the reader's back and asserts the next page is still right.

**Now the question you asked.** Changing a filter **drops the cursor**, always.
A cursor means "continue after this row *under these filters and this
ordering*". Carrying it across a filter change asks the server to continue a
list that no longer exists, and the reader lands in the middle of a result set
whose beginning they never saw - with nothing on screen to tell them. Verified
in the browser: on page 2, selecting a status produced
`?status=PENDING_REVIEW` with no `cursor` at all.

**Two things I would mention before being asked.**

The search term and the cursor both produce an `OR` in the Prisma `where`, and
an object cannot carry two `OR` keys - the second silently replaces the first
and widens the result set *past* the cursor. They are combined under `AND`, and
F06-T16b is the regression: `?q=casino&status=APPROVED` must return nothing, and
would return the rejected rows if they collided.

And the limitation: the API returns a **forward** cursor only, so "Newer" pops a
stack held in the component. A link *pasted* with a cursor in it starts with an
empty stack, and "Newer" from there returns to the first page rather than the
one before it. Recorded as R-28 rather than left for somebody to find.

**Backs it up:** `src/common/keyset.ts`, `expense-query.service.ts`,
`hooks/use-expense-filters.ts`, F06-T19, T19b, T19c, T26, T16b.

---

## Q4 - Responsive UI and reusable component architecture

> At 360 pixels your table becomes cards. How do you know the two show the same
> thing, and why not just let the table scroll sideways?

**Because it is one component, not two.**

`ExpenseRows` renders a `<table>` at `md` and up and a card list below, and both
branches read the **same** `items` and call the **same** formatters. Nothing is
computed in one branch and not the other. A change to how an amount is displayed
changes both, and there is no second place for a currency bug to hide.

Two separate components is the version that drifts: somebody fixes the mobile
amount, the desktop one keeps the old call, and nobody notices because nobody
looks at both widths in the same sitting.

**Why not horizontal scroll.** At 360px a nine-column table puts *Status* - the
column a manager actually came for - behind a scrollbar they may never discover.
"No essential information silently hidden" is a requirement, and a scroll the
user does not know about hides it. The brief says it in those words.

**What I did instead:** a smaller screen gets a **different layout, not less
information**. Both badges, the reference, the employee, the category and the
date are all on the mobile card. What changes is the arrangement - merchant and
amount on one line, metadata on the next, badges at the bottom - not the
content. The only things the *table* drops are Category and Spent, and only
below `lg`, where they are still on the card version underneath.

**The breakpoint is `md` (768px)** - where a table stops being readable, not
where it stops fitting. The shell's own breakpoint is `lg` (1024px), chosen in
F02.1 for this exact reason: at 768px a 260px sidebar leaves about 500px of
content, which is too narrow for this table. That comment was written before
this table existed.

**Accessibility details that are easy to miss.** A `<tr>` cannot contain an
`<a>` wrapping its cells, and one link per cell would announce nine identical
links. So there is **one** link per row, on the merchant, with a `::after`
overlay making the whole row clickable for a mouse - one accessible name, one
tab stop, the whole row as a target. The filter dropdowns are native
`<select>` elements, which on a phone open the platform's own picker rather than
a custom popover fighting the keyboard and the address bar.

**Verified at every required width in a real browser**, not in a media query. A
full-page screenshot taken at 360 is 360 pixels wide, so overflow would be
visible in the image itself.

**Backs it up:** `components/expenses/expense-rows.tsx`,
`components/ui/select.tsx`, `components/layout/app-shell.tsx`, F06-T39 to T44.

---

## Q5 - Tenant isolation, financial accuracy and historical presentation

> Walk me through everything that has to be true for a manager to see a correct
> number on this dashboard - and nothing of anyone else's.

**Three separate guarantees, and they fail in three different ways.**

### Tenant

`companyId` comes from `tenantScope(principal)` - the verified session - and
goes **into the `where` of the query itself**. Never a check after fetching a
global row: a post-fetch check has already read another tenant's data into the
process and is one early return away from leaking it.

A foreign expense answers **404, not 403**. A 403 confirms the row exists, which
turns the URL into a way to count a competitor's expenses by walking ids. The
test asserts the two bodies are **byte-identical**, not merely similar.

The nested review needs no tenant predicate of its own, and that is a guarantee
rather than an oversight: `Review(expenseId, companyId)` is a composite foreign
key onto `Expense(id, companyId)`, so a review whose company differs from its
expense's is **physically unstorable**.

**And it is measured.** F06-NC1 removes the tenant predicate from the aggregate:
the whole table comes back and **nothing errors anywhere**. The query succeeds,
the dashboard renders, the numbers are another company's. It also asserts first
that the two seeded companies have *different* counts - otherwise every
assertion in that file would pass under a missing predicate while proving
nothing.

### The number itself

One `groupBy`, therefore one statement, therefore **one MVCC snapshot**. Four
`count()` calls would be four snapshots, and an expense arriving between the
second and the third gives status counts that do not sum to the total. Nothing
errors there either - the numbers are just wrong, intermittently, in a way
nobody can reproduce. F06-T01b asserts the sum on the response.

Counting in the browser from a fetched page is wrong by construction the moment
there is a second page.

**The counts use the current `status`, never the original `decision`.** An
expense the policy flagged and a manager approved counts as **approved**.
Counting it as pending would show work that is already done.

And monetary totals are a **list keyed by currency**, never a scalar. One
company has one currency today (A3), but the aggregate does not *depend* on
that: a scalar would quietly add riyals to dollars and be wrong without failing.

### Money and history

The amount never touches floating point. The decimal point is **inserted into
the digit string** and handed to `Intl.NumberFormat`, which takes a string since
ES2023. And the exponent is **not hard-coded to 100** - `Intl` is asked, because
JPY has none and `1000` JPY minor units is ¥1,000, not ¥10.00. That error would
be a factor of a hundred and the number would still look plausible.

Every policy figure beside an expense comes from the **recorded rule hit**, not
from the company's current policy. Reading the live policy would show the wrong
limit next to every expense submitted before the last edit - and nothing about
the page would look wrong. F06-T12 edits the policy and asserts the detail view
does not move.

**The three facts are kept separate and shown together:** policy decision,
current status, human outcome. The page explains why they can differ, because a
reader seeing "Review" and "Approved" side by side with no explanation
reasonably concludes something is broken.

**The honest limitation:** `generatedAt` is when the *response* was built,
strictly after the snapshot it reports. It is named for what it is rather than
for what it is near, because the snapshot's own timestamp is internal to
PostgreSQL and is not exposed.

**Backs it up:** `dashboard-summary.service.ts`, `expense-query.service.ts`,
`lib/format.ts`, `lib/expense-reasons.ts`, ADR-003, ADR-005, ADR-011,
F06-T01b, T03, T05, T07, T12, F06-NC1.
