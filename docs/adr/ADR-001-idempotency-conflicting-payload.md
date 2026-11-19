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
