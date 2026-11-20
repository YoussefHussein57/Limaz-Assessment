# Frontend architecture

The conventions here are the ones F06, F07 and F08 build on. Read this before
adding a page.

## Shape

```
apps/web/
  app/
    layout.tsx              font, design tokens
    page.tsx                sends you where you belong
    (auth)/login/           OUTSIDE the protected group - see "No redirect loop"
    icon.svg                the app icon Next serves as the favicon
    (app)/layout.tsx        the server auth gate + the query provider
    (app)/dashboard/        manager workspace
      page.tsx              overview            SERVER
      loading.tsx           error.tsx
      expenses/
        page.tsx            listing shell       SERVER
        [expenseId]/        page, loading, error, not-found   SERVER
    (app)/admin/layout.tsx  the role gate
    api/[...path]/          same-origin proxy to the API
  components/
    ui/                     button, field, badge, alert, card, spinner, skeleton,
                            select, search-input, empty-state
    layout/                 app-shell, sidebar-nav, mobile-nav, user-menu, page-header
    auth/                   login-form
    dashboard/              stat-card
    expenses/               expense-list (CLIENT), expense-rows, expense-filters-bar,
                            reason-card, status-badges
  hooks/
    use-expense-filters.ts  URL <-> filter state
  lib/
    auth.ts                 SERVER only - reads the cookie, calls the API
    auth-shared.ts          types and pure helpers - safe on both sides
    api.ts                  SERVER fetch, forwards the session cookie
    api-client.ts           BROWSER fetch, through /api/*
    api-error.ts            ApiError - safe on both sides
    expense-types.ts        the API's shapes, as this app reads them
    expense-reasons.ts      rule code -> readable evidence   (+ .spec.ts)
    format.ts               money and dates                  (+ .spec.ts)
    queries.ts              query keys and fetchers
    nav.ts                  role to navigation
    cn.ts
  providers/
    auth-provider.tsx       the user the server already resolved
    query-provider.tsx      server state, keyed by user id
  fonts/                    InterVariable.woff2, its OFL licence, and a README
```

## Authentication

### Identity is resolved on the server, before any HTML is sent

`app/(app)/layout.tsx` is a Server Component. It reads the `HttpOnly` session
cookie with `cookies()`, forwards it to `GET /v1/auth/me`, and redirects on
401.

The cookie is unreadable to browser JavaScript - that is the point of
`HttpOnly` - but perfectly readable here. The consequences are worth naming:

- no flash of an unauthenticated shell
- no loading spinner on the user's own name
- no client-side waterfall of "render, then ask who you are, then re-render"

### What was rejected, and why

| Option | Why not |
|---|---|
| Client Context with a `useEffect` fetch | Renders the shell before it knows who you are, so there is always a flash, and the request is a waterfall behind the page load |
| TanStack Query for identity | Same problem, plus a dependency with nothing to cache. It arrives in **F06**, where expenses and reviews bring real caching, mutations and invalidation |
| Next middleware | Runs at the edge and can see only that a cookie EXISTS, not that it is valid. A presence check is a false sense of security, and the real check has to live in the layout anyway |

### The Context carries; it does not fetch

`AuthProvider` receives the user the server already resolved and hands it to
client components that need it - the sidebar, the user menu. It issues no
request. That is precisely why Context is right here and a server-state
library is not: there is one value, known before render, with nothing to
synchronise.

### No redirect loop

`/login` lives in the `(auth)` route group, **outside** `(app)`. If it were
inside, an expired session would redirect to `/login`, which would run the auth
check, fail it, and redirect to `/login` again.

The separation is structural rather than a conditional somebody has to
remember. Test F02.1-T09.

### Logout

The button posts to `/api/v1/auth/logout` through the proxy, with the
`x-limaz-client` header the API requires on every state-changing browser
request. Then:

```ts
router.replace('/login?reason=signedout');
router.refresh();
```

`router.refresh()` is not cosmetic. Next keeps a client-side Router Cache, and
without clearing it the next navigation can replay a shell rendered for the
previous identity. Test F02.1-T18.

### None of this is security

The API answers 401, 403 and 404 on its own merits whatever the browser
believes - F02 proves every one of those without a browser involved. Route
protection here exists so a person is not left looking at an empty frame, and
hidden navigation exists so nobody is shown doors that will not open.

**Adding a page does not protect it. Protecting it happens in the API.**

## The server/client line

`lib/auth.ts` imports `next/headers`, which exists only on the server.
Importing a single value from it into a client component pulls that into the
browser bundle and fails the build - which is exactly what happened when the
login form imported `homePathFor` from there.

So the module is split along a real line:

| File | Holds | Usable from |
|---|---|---|
| `lib/auth-shared.ts` | types, `homePathFor` | both |
| `lib/auth.ts` | `cookies()`, `getCurrentUser`, `requireUser` | server only |

**A client component imports from `auth-shared`. Always.**

## Design tokens

Every colour lives in `app/globals.css` under `@theme`. Nothing in a component
writes a raw hex value; if a colour is needed that is not there, it belongs
there first.

### Contrast is measured, not assumed

`node scripts/check-contrast.mjs` prints the ratio of every pair and exits
non-zero on a failure. It is committed so the numbers stay verifiable rather
than becoming a claim nobody can re-check.

Four tokens were changed because of what it printed. Three sat within 0.1 of
the AA threshold - 4.51, 4.55, 4.57 - which passes until a different tool
rounds differently.

| Token | Was | Is | Measured |
|---|---|---|---|
| secondary text | `#64748B` | `#5A6A80` | 4.55 → **5.27** |
| success text | `#15803D` | `#166534` | 4.57 → **6.49** |
| warning text | `#B45309` | `#92400E` | 4.51 → **6.37** |
| danger text | `#B91C1C` | `#991B1B` | 5.30 → **6.80** |

### Two border tokens

| Token | Value | Measured | For |
|---|---|---|---|
| `--color-border` | `#E2E8F0` | 1.18:1 on background | cards, dividers, table rules |
| `--color-border-input` | `#64748B` | **4.55:1** on background | the boundary of a form control |

WCAG 1.4.11 requires 3:1 for the visual boundary of a user interface
component - the edge that tells you where an input begins. It does not apply
to a decorative rule. `#E2E8F0` measures **1.18:1**, which is fine for a card
and nowhere near enough for an input.

**A control gets `border-input`. A decoration gets `border`.**

## Components

Hand-written with Tailwind, except two.

| Component | Built on | Why |
|---|---|---|
| Button, Field, Badge, Alert, Card, Spinner, Skeleton | nothing | No behaviour worth a dependency |
| MobileNav | `@radix-ui/react-dialog` | Focus trap, Escape, focus return, scroll lock, inert background. Each is easy to get subtly wrong, and wrong makes the drawer unusable for the people the requirement exists to serve |
| UserMenu | `@radix-ui/react-dropdown-menu` | Arrow-key roving focus, Escape, focus return, `role="menu"` |

**The rule: Radix only where the accessible behaviour is non-trivial.** Not for
anything a `div` and two classes can do.

`lucide-react` supplies icons. There is no `clsx` and no `tailwind-merge`:
`lib/cn.ts` is six lines, and every call site is ours, so there are no
conflicting utility classes arriving from outside to resolve.

## Responsive

| Width | Layout |
|---|---|
| < 1024 (`lg`) | Drawer navigation, compact header, full-width fields |
| ≥ 1024 | Fixed 260px sidebar, content beside it |

`lg` rather than `md`: at 768px a 260px sidebar leaves about 500px of content,
which is too narrow for the expense table F06 will put there.

Content is capped at `max-w-6xl`. Without it, lines stretch across a 1920px
display and become hard to scan.

### Tables, for F06 and F07

**Controlled horizontal scroll inside an `overflow-x-auto` container. Not
hidden columns.**

In an expense table the amount, the date and the decision are all essential,
and the assessment says so directly: do not hide essential information merely
to fit a smaller screen.

## Accessibility conventions

| Convention | Where |
|---|---|
| One visible focus style, `:focus-visible` | `globals.css` |
| Skip link to `#main` | `AppShell` |
| Labels bound by `useId`, not nesting | `Field` |
| `aria-invalid` + `aria-describedby` + `role="alert"` on errors | `Field` |
| `aria-current="page"` on the active link | `SidebarNav` |
| 44px touch targets | `Button`, drawer trigger, menu items |
| `aria-busy` while a control is working | `Button` |
| Status never by colour alone | `Badge` renders text; `Alert` carries an icon |
| `prefers-reduced-motion` honoured | `globals.css` |

**Transitions are 150ms and carry meaning** - a state change, a drawer moving.
Nothing animates for decoration.

## Honest placeholders

Every page shows the **real** identity and company the server resolved, and
says plainly what is not built.

**Updated by F06.** The dashboard now carries real statistics - every one of
them read from the database in a single aggregate query. What it still does not
carry is anything that would have to be **invented**: no trend, no percentage
change, no sparkline, no activity feed. The system records no history of its
own counts, so each of those would be a number nobody could defend in a review.

Navigation marks unbuilt destinations with the feature that delivers them
rather than hiding them or linking to a 404 - and where a reader would look for
a control that F07 brings, the page says so instead of showing a button that
does nothing.

> The "Adding a page" checklist that used to sit here is superseded by the one
> at the end of this document, which adds the Server/Client decision and the
> query-key rule.

---

# Data fetching, from F06

## The dividing line

**Client fetching where the request changes under the user's fingers; server
fetching where it does not.**

| Page | Rendering | Why |
|---|---|---|
| `/dashboard` | **Server** | No parameter the reader can change |
| `/dashboard/expenses/[id]` | **Server** | The URL is the entire state |
| `/dashboard/expenses` | Server shell + **Client** list | Four filters, a search box and a cursor |

Marking the whole application a Client Component to have one caching story
means paying for a round trip, a spinner and a bundle on pages that need none
of it. The brief rules it out in those words, and it would be the wrong call
anyway.

## Two fetch paths, one credential

```
Server Component  ──  lib/api.ts        ──>  http://api:3001  (cookie forwarded)
Client Component  ──  lib/api-client.ts ──>  /api/*  ──>  proxy  ──>  API
```

A Server Component is already on the server, so routing it through Next's own
route handler would be a pointless extra hop - and would need an absolute URL
back to ourselves, which is the self-referential mistake F00-T05 caught in
`rewrites()`.

A Client Component must use the **relative** path. That is what keeps the
session cookie first-party, keeps `SameSite=Lax` working as CSRF protection,
and means no CORS configuration exists anywhere (ADR-008, A10). An absolute URL
in `api-client.ts` would undo all three.

Neither path holds a token. The server forwards a cookie it read; the browser
has one attached for it.

## Query keys

```ts
expenseKeys.all      = ['expenses']
expenseKeys.lists()  = ['expenses', 'list']
expenseKeys.list(f,c)= ['expenses', 'list', filters, cursor]
expenseKeys.detail(i)= ['expenses', 'detail', id]
```

The filters are the **last** element, so `lists()` matches every filter set by
prefix. That is what makes F07's invalidation one call instead of a loop over
every combination a reader might have open.

The filters being *in* the key is also what makes a stale response impossible:
the answer to `q=cas` is written into the `q=cas` entry and nowhere else, so it
has no slot to land in once the filter has moved on. Not a race handled - a
race that does not exist.

## Cache boundary

```tsx
<QueryProvider key={user.id}>   // app/(app)/layout.tsx
```

A different user **unmounts** the provider and a new `QueryClient` is built.
There is no cache to read from, rather than an old cache somebody remembered to
clear - and `queryClient.clear()` on logout works only as long as every exit
path calls it, including session expiry and a back-navigation after logout.

`useState(() => new QueryClient())` is the other half: a module-level client
would be shared by every session in the tab.

## Defaults, and why

| Setting | Value | Reason |
|---|---|---|
| `staleTime` | 30s | Navigate to an expense and back renders instantly. Zero makes "back" a reload; Infinity never notices a new submission |
| `gcTime` | 5 min | Kept while the reader is likely to return |
| `refetchOnWindowFocus` | **false** | Refetching on return can reorder rows under a cursor mid-read |
| `retry` | **No 4xx**, 2 otherwise | A 401 will not become a 200 by asking again |
| `placeholderData` | `keepPreviousData` | Paging does not blank the table |

## Filter state lives in the URL

One source of truth. A filtered view becomes a shareable link, the back button
works, and reload keeps your place - none of which needs code.

What is **prevented** is a second copy of the same state. A `useState` beside a
query parameter is two values that must be kept equal, and every bug in that
class looks the same: the input says one thing and the results say another.

**The one exception** is the search box, which holds its own *text* for the
length of its 300ms debounce. "What is in the box right now" is a different
fact from "what the list is filtered by"; driving the input's value from the
URL makes every keystroke a navigation and loses the caret mid-word.

**Changing a filter drops the cursor.** A cursor means "continue after this row
*under these filters*"; carrying it asks the server to continue a list that no
longer exists.

## Money and dates

Both formatters are **pure** and both are fixed to `en-US` and `Asia/Riyadh` -
for a technical reason, not a stylistic one. Server-rendered pages hydrate in
the browser, and a viewer-dependent format produces one string on the server
and another in the browser: a hydration mismatch on every row, for every viewer
outside the zone.

Minor units are converted by **inserting the decimal point into the digit
string**, never by dividing. The exponent comes from `Intl`, not from a
hard-coded 100 - JPY has no minor unit, and `/100` would be wrong by a factor
of a hundred while still looking plausible.

## Reading a Json column

`detail` and `policySnapshot` are JSON. Their shape is a convention between two
deployments, not a compile-time guarantee. Every reader validates what it needs
and falls back; an unknown rule code renders with its raw code and its scalar
evidence rather than crashing the page. A rule added to the backend should
degrade a page to *less explanation*, not to a blank screen.

## Adding a page, updated

1. Put it under `app/(app)/`. The gate already covers it.
2. **Decide Server or Client by the rule above**, and write down which.
3. Open with `<PageHeader>` - it renders the only `h1`.
4. Take the tenant from the server, never from a query parameter.
5. Use design tokens. No raw hex.
6. A table below `md` becomes cards, from **one** component - not a second one,
   and not a horizontal scroll that hides a column.
7. Add `loading.tsx` and `error.tsx` beside it. `error.tsx` shows a fixed
   sentence and the digest, never `error.message`.
8. If it fetches on the client, put every parameter in the query key.
9. Add the destination to `lib/nav.ts` and remove its `comingIn`.
10. Check it at 360px, in a browser, before calling it done.
