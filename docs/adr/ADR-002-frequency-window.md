# ADR-002: Frequency window semantics

- **Status:** Accepted, 2026-11-19
- **Assessment question:** 2
- **Implemented in:** F04
- **Related risk:** R-11 (accepted, not eliminated)

## Context

The rule fires when the same employee has **more than 3 expenses within 60
minutes**. Two things are left undefined by that sentence: which clock the
window uses, and whether the expense being evaluated counts toward its own
window.

## Decision

1. The window is measured on **`spentAt`**, not on the time the request arrived.
2. The window is **backward-looking**: `[spentAt - 60 minutes, spentAt]`.
3. **The current expense counts.** The rule fires when
   `count(existing in window) + 1 > frequencyMaxCount`.
4. Decisions are **never re-evaluated**. An expense that arrives out of order
   affects every subsequent evaluation, but changes no decision already made.

## Rationale

### Why `spentAt` rather than receipt time

The rule measures employee behaviour, not network timing. If a client queue
stalls for two hours and then flushes ten expenses, receipt time would place all
ten in a single window and fire the rule on behaviour that never happened.
`spentAt` is the clock an auditor would use.

The cost is that `spentAt` is client-supplied and therefore manipulable. It is
validated: no more than 5 minutes into the future (clock skew), and no more than
90 days into the past. Every expense also stores `receivedAt`, so the gap
between the two is always visible to a reviewer.

### Why the current expense counts

Without it, "more than 3 within 60 minutes" would fire on the fifth expense
rather than the fourth: three existing plus the new one is four, and four is
more than three.

## Out-of-order behaviour

With `frequencyMaxCount = 3`, starting from these expenses:

| Expense | `spentAt` | Its window | Count at evaluation | Decision |
|---|---|---|---|---|
| E1 | 10:10 | `[09:10, 10:10]` | 1 | APPROVE |
| E2 | 10:20 | `[09:20, 10:20]` | 2 | APPROVE |
| E3 | 10:30 | `[09:30, 10:30]` | 3 | APPROVE (3 is not greater than 3) |

A late submission **E4** then arrives with `spentAt = 10:05`:

- E4's own window is `[09:05, 10:05]`. E1, E2 and E3 all occurred **after**
  10:05, so none of them falls inside it. The count is 1. **APPROVE.**
- E3's window `[09:30, 10:30]` now *does* contain E4, because
  `09:30 <= 10:05 <= 10:30`. That window therefore holds four expenses. E3's
  decision is **not** revisited.

A subsequent **E5** with `spentAt = 10:35` has window `[09:35, 10:35]`. That
window contains E4 (`09:35 <= 10:05 <= 10:35`), E1, E2, E3 and E5 itself, which
is five expenses. **REVIEW.**

Late data is therefore not discarded. It is simply never applied retroactively.

## Alternatives considered

| Option | Verdict |
|---|---|
| Re-evaluate affected expenses on insert | Rejected: every insert could rewrite N decisions and open reviews retroactively. Decisions stop being stable, which breaks auditability and contradicts assumption A7 (policy edits do not re-evaluate history). |
| Symmetric window `[t-60, t+60]` | Rejected: semantically wrong. It would count two expenses 118 minutes apart as being "within 60 minutes". |
| Sliding sub-window search over `[t-60, t+60]` | Rejected for now: correct, but requires scanning a two-hour band and reasoning about every 60-minute sub-window containing `t`. Disproportionate for the gain; recorded here as the upgrade path. |

## Known limitation, risk R-11

A back-dated expense can receive APPROVE even though it is logically the fourth
expense in its own window, because forward-only evaluation never looks ahead.
The `spentAt` bounds reduce the blast radius; they do not close the hole.

This is a deliberate, documented trade-off. The risk register records it as
**accepted**, not **mitigated**.

## Test strategy

- Unit: boundary cases at exactly 60 minutes, at 60 minutes plus one second,
  and the third versus the fourth expense.
- Integration: the out-of-order sequence above, asserting E4 is APPROVE and E5
  is REVIEW.
- Concurrency: see ADR-007.
