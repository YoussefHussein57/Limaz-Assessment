# Interview defence

Five realistic questions per completed feature, with the answer I should be able
to give, and the place in this repository that backs it up.

The questions are written to attack **our actual choices**, not textbook theory.

| Feature | Questions | Reviewed |
|---|---|---|
| [F00 - Foundation](F00-foundation.md) | 5 | Not yet |

## Learning gaps

Recorded as they come up, so I can revise them rather than being blocked by
them.

| Date | Topic | Gap | Status |
|---|---|---|---|
| 2026-11-19 | PostgreSQL index internals | A `UNIQUE` constraint is a **B-tree**, so lookup is `O(log n)`, not `O(1)`. PostgreSQL has no hash-backed unique index by default | Noted, corrected in ADR-006 |
| 2026-11-19 | Snapshot isolation | `READ COMMITTED` takes a snapshot **per statement**; `REPEATABLE READ` takes one at the transaction's **first statement**. That difference is what makes lock-then-count correct under one and silently wrong under the other | Noted, explained in ADR-007 |
| 2026-11-19 | Docker context semantics | A `.dockerignore` pattern without `**/` matches only at the context root | Noted, fixed and guarded by F00-T12 |
