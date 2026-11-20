# Interview defence

Five realistic questions per completed feature, with the answer I should be able
to give, and the place in this repository that backs it up.

The questions are written to attack **our actual choices**, not textbook theory.

| Feature | Questions | Reviewed |
|---|---|---|
| [F00 - Foundation](F00-foundation.md) | 5 | Not yet |
| [F01 - Database and seed](F01-database-and-seed.md) | 5 | Not yet |
| [F02 - Authentication](F02-authentication.md) | 5 | Not yet |
| [F02.1 - UI foundation](F02.1-ui-foundation.md) | 5 | Not yet |

## Learning gaps

Recorded as they come up, so I can revise them rather than being blocked by
them.

| Date | Topic | Gap | Status |
|---|---|---|---|
| 2026-11-19 | PostgreSQL index internals | A `UNIQUE` constraint is a **B-tree**, so lookup is `O(log n)`, not `O(1)`. PostgreSQL has no hash-backed unique index by default | Noted, corrected in ADR-006 |
| 2026-11-19 | Snapshot isolation | `READ COMMITTED` takes a snapshot **per statement**; `REPEATABLE READ` takes one at the transaction's **first statement**. That difference is what makes lock-then-count correct under one and silently wrong under the other | Noted, explained in ADR-007 |
| 2026-11-19 | Docker context semantics | A `.dockerignore` pattern without `**/` matches only at the context root | Noted, fixed and guarded by F00-T12 |
| 2026-11-20 | Composite foreign keys | PostgreSQL needs a `UNIQUE` on exactly the referenced columns before they can be a foreign-key target - even when one of them is already the primary key | Noted, used in ADR-011 |
| 2026-11-20 | Prisma error translation | Prisma collapses every non-unique, non-FK database error into `P2039`. The real SQLSTATE and constraint name survive under `meta.driverAdapterError.cause` | Noted, used by the test helper |
| 2026-11-20 | React 19 types | `FormEvent` is deprecated with the note that it "doesn't actually exist". Deriving the type from `ComponentProps<'form'>['onSubmit']` cannot go stale when React changes it again | Noted, used in `login-form.tsx` |
| 2026-11-20 | `'use client'` semantics | The directive marks a **boundary**, not "this file uses hooks". A boundary cannot receive a function prop, so marking one inside an already-client tree creates a constraint with no benefit | Noted, AI_LOG 15 |
| 2026-11-20 | WCAG 1.4.11 | Non-text contrast requires 3:1 for the **visual boundary of a user interface component** - an input's edge - and does not apply to a decorative rule. One border colour cannot serve both | Noted, two border tokens |
| 2026-11-20 | `offsetParent` | It is `null` for any `position: fixed` element, so it cannot be used to test visibility of a fixed sidebar. `getComputedStyle(el).display` can | Noted, AI_LOG 17 |
| 2026-11-20 | RFC 3986 sub-delimiters | `,` and `;` are legal unencoded inside a URL password, so they cannot be treated as the end of the userinfo part | Noted, AI_LOG 14 |
