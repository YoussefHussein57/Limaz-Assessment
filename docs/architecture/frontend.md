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
    (app)/layout.tsx        the server auth gate
    (app)/dashboard/        manager workspace
    (app)/admin/layout.tsx  the role gate
    api/[...path]/          same-origin proxy to the API
  components/
    ui/                     button, field, badge, alert, card, spinner, skeleton
    layout/                 app-shell, sidebar-nav, mobile-nav, user-menu, page-header
    auth/                   login-form
  lib/
    auth.ts                 SERVER only - reads the cookie, calls the API
    auth-shared.ts          types and pure helpers - safe on both sides
    nav.ts                  role to navigation
    cn.ts
  providers/auth-provider.tsx
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

The dashboard and admin pages show the **real** identity and company the
server resolved, and say plainly what is not built.

There are no statistics, no charts and no sample figures. Every number would
be invented, and an invented number is something to be asked about in a review
that nobody can defend. Navigation marks unbuilt destinations with the feature
that delivers them rather than hiding them or linking to a 404.

## Adding a page

1. Put it under `app/(app)/`. The gate already covers it.
2. Open with `<PageHeader>` - it renders the only `h1`.
3. Take the tenant from the server, never from a query parameter.
4. Use design tokens. No raw hex.
5. If it has a table, wrap it in `overflow-x-auto`.
6. Add the destination to `lib/nav.ts` and remove its `comingIn`.
7. Check it at 360px before calling it done.
