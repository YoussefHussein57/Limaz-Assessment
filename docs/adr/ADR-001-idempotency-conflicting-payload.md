# ADR-001: The same `externalId` arrives again with a different body

- **Status:** Accepted, 2026-11-19
- **Assessment question:** 1
- **Implemented in:** F03
- **Depends on:** ADR-005 (money representation determines what the hash covers)

## Context

`externalId` is unique per company. Clients retry, so the same expense can
arrive more than once. A retry is a replay of the same fact and must not create
a second expense or count twice toward the frequency rule.

A second request carrying the same `externalId` and a **different body** is not
a retry. It is one of three things: a client bug, a reused identifier, or an
attempt to overwrite a decision already issued. The service cannot tell which,
and all three deserve the same answer: refuse, and say so clearly.

## Requirements

- A genuine retry returns the original decision and creates nothing new.
- A conflicting resubmission must not silently overwrite an existing expense.
- Neither case may produce a 5xx.

## Alternatives considered

| Option | Behaviour | Verdict |
|---|---|---|
| **A. `409 Conflict`** | Refuse; return the stored decision for reference | **Chosen** |
| B. Return the original silently with `200` | Treat every repeat as a retry | Rejected: hides a real client defect. The caller believes its newer amount was accepted when it was in fact discarded. |
| C. Update the expense and re-evaluate | Last write wins | Rejected: destroys idempotency. A decision already reported to the caller would change after the fact, and any review opened against it becomes meaningless. |

## Decision

Store a `payloadHash` on every expense: SHA-256 over the canonicalised business
fields (`employeeId`, `amountMinor`, `currency`, `merchant`, `category`,
`spentAt`). Canonicalisation means sorted keys and normalised timestamps, so two
semantically identical bodies always produce the same hash.

On a duplicate `(companyId, externalId)`:

| Stored hash vs incoming | Response |
|---|---|
| Equal | `200 OK` with the **original** decision and reasons |
| Different | `409 Conflict` naming `externalId` as the conflicting field, including the original decision for reference |

## Rationale

The hash turns "is this the same expense?" into a decidable question rather than
a judgement call. It also keeps the retry path cheap: one indexed lookup and one
string comparison, not a field-by-field diff.

`409` is the status that matches the situation. The request is well-formed, so
it is not a `400`; it conflicts with the current state of the resource.

## Consequences

- Requires a `payloadHash` column on `EXPENSE`.
- The canonicalisation function becomes part of the public contract. Changing
  which fields it covers changes which resubmissions count as conflicts, so it
  gets its own unit tests.
- Clients that legitimately need to correct an expense must submit a new
  `externalId`. This is documented in the API description.

## Failure modes

| Failure | Effect | Mitigation |
|---|---|---|
| Hash covers too few fields | A changed field is treated as a retry and silently ignored | Unit test asserting the hash changes when any covered field changes |
| Hash covers too many fields | Harmless metadata differences produce spurious `409`s | Only the business fields listed above are hashed |
| Timestamp formatting differences | Two identical expenses hash differently | Timestamps are normalised to UTC ISO-8601 before hashing |

## Test strategy

- Unit: canonicalisation is stable across key order and equivalent timestamp
  formats; the hash changes for every covered field.
- Integration: the same body twice returns `200` and leaves exactly one row.
- Integration: a different body returns `409` and the stored row is unchanged.
- Concurrency: see ADR-007.

---

## Implementation notes, added after F03

The decision above stood. Four things it did not anticipate had to be settled
during implementation, and each changes how the record should be read.

### The canonical serialisation is a fixed-order ARRAY

```ts
JSON.stringify([employeeId, amountMinor, currency, merchant, category, spentAtIso])
```

The ADR said "sorted keys". An array is better: key ordering stops being a
property of the serialiser and becomes part of the structure, so there is no
sorting step that a future change could get wrong.

A hand-rolled delimiter was rejected for a concrete reason, not on taste.
Joining with `|` collides - merchant `a|b` with category `C` produces the same
string as merchant `a` with category `b|C`. JSON escapes quotes inside each
value, so no value can impersonate a field boundary.

A general-purpose canonicalisation library (RFC 8785, JCS) was considered and
rejected: it solves nested key ordering, number-format edge cases and Unicode
collation for arbitrary JSON. Six fields of known types do not have those
problems, and the dependency would need defending in review.

### Identifiers are compared exactly; only content is normalised

"Canonicalisation means sorted keys and normalised timestamps" was too broad.
Normalising an **identifier** merges identities: if ` exp-1` were trimmed to
`exp-1`, a caller would receive the decision belonging to a different record,
silently.

So `externalId` and `employeeId` are never trimmed, case-folded or
NFC-normalised. A value carrying surrounding whitespace is **rejected with
400** rather than quietly repaired. `merchant`, `category` and `currency` are
content and are normalised, including NFC - without it, two visually identical
merchant names in different Unicode encodings would be a spurious 409 no
caller could diagnose.

### The normalised values are what gets stored

Not only what gets hashed. Storing the raw input while hashing the normalised
form would make a retry of a stored row conflict with itself: the column
truncates `spentAt` to milliseconds while the hash would have covered the
microseconds that were dropped.

### The idempotency lookup runs BEFORE time-dependent validation

An expense accepted ninety-one days ago is still a legitimate thing to retry.
Shape validation is time-independent by construction, so the retry parses; the
lookup then returns the original decision without the A4 window ever being
consulted. The other order rejects a legitimate retry with a 422 for a rule
the original submission satisfied, and the caller can never stop retrying.

Test **F03-T25**, with **F03-T25b** proving the A4 rule still applies in full
to anything new, and **F03-T25c** proving a conflicting resubmission of a
stale expense is still a 409 rather than a 422.

### The 409 body

The ADR asked for the original decision "for reference". That required one
optional, explicitly sanitised `details` field on the error body - restricted
by type, not by field name, so a thrower cannot attach an entity carrying a
hash by accident, and suppressed entirely on 5xx.

The stored `payloadHash` is **never** published. Publishing it would let a
caller brute-force the payload of an expense they cannot otherwise read, one
guess at a time (**F03-T14c**).

### What enforces the uniqueness is an INDEX, not a table constraint

`@@unique([companyId, externalId])` emits `CREATE UNIQUE INDEX`, so
`expenses_companyId_externalId_key` lives in `pg_indexes` and is absent from
`pg_constraint`. The guarantee and the `23505` it raises are identical; the
DDL to remove it, and the catalogue to verify it in, are not.

This surfaced when the negative-control test said `DROP CONSTRAINT` and failed
with `42704 does not exist`.
