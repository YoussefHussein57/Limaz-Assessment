# ADR-005: How money amounts are represented

- **Status:** Accepted, 2026-11-19
- **Assessment question:** 5
- **Implemented in:** F01
- **Related assumption:** A3 (one currency per company)

## Context

Expenses carry amounts, and those amounts are compared against a company's
auto-approve limit. Any representation error here is a financial error.

## Decision

Amounts are stored as **integers in the currency's minor unit**, in a column
named `amountMinor`, alongside an ISO-4217 `currency` code.

`12500` with currency `SAR` means 125.00 SAR.

- Database type: `INTEGER`
- Comparison: `amountMinor > policy.autoApproveLimitMinor`, integer to integer
- Formatting to a human-readable string happens only at the UI boundary

## Rationale

### Why not floating point

`0.1 + 0.2` is not `0.3` in IEEE 754. Binary floating point cannot represent
most decimal fractions exactly, so sums drift and comparisons near a limit
become unreliable. In an expense system that means approving something that
should have been reviewed, and the error is invisible until someone reconciles
the books.

### Why integers rather than `DECIMAL`

`DECIMAL` is also exact and would be a defensible choice. Integers were chosen
because:

- Every arithmetic operation stays in native integer space, in both PostgreSQL
  and JavaScript. There is no decimal library at the application boundary and no
  risk of a `Decimal` being coerced to a `number` somewhere in the stack.
- Prisma maps `Decimal` to a library object that serialises awkwardly to JSON
  and is easy to mishandle. An integer is an integer everywhere.
- The API contract becomes unambiguous: the wire format is an integer, so there
  is no "is `12.5` twelve-fifty or twelve-point-five?" question.

### Why not `BigInt`

`INTEGER` caps a single expense at 2,147,483,647 minor units, roughly 21.4
million SAR. That is far beyond any plausible single expense, and the ceiling is
documented. `BigInt` would be safer in principle but Prisma serialises it to
JSON awkwardly and it would need a custom serialiser for no practical gain at
this scale.

**If this were a real product handling aggregate totals rather than individual
expenses, `BIGINT` would be the correct choice.** Per-expense, it is not.

## Currency handling, assumption A3

Each company has a single `currency`. An expense submitted in a different
currency is rejected with `422`, naming the mismatch.

There is no FX conversion. Converting would require a rate source, a rate
timestamp, and a policy on which rate applies to a back-dated expense - three
decisions with no basis in the requirements. Rejecting is honest and
reversible; a wrong conversion is neither.

## Consequences

- Clients must send minor units. This is stated in the API description and
  validated: `amount` must be a non-negative integer.
- A currency with a different exponent (for example JPY, which has none) works
  without change, because the exponent lives in the currency code, not in the
  storage.
- Any future aggregation (totals per company, per month) must sum in minor units
  and only format at the end.

## Failure modes

| Failure | Effect | Mitigation |
|---|---|---|
| A client sends `125.00` meaning 125 SAR | Amount read as 125 minor units, under every limit | DTO rejects non-integers with `400`; the API description states minor units explicitly |
| An expense exceeds the `INTEGER` ceiling | Database error | Validation caps `amount` below the ceiling and returns `400` |
| A formatter divides by 100 for a zero-exponent currency | Display error | Formatting is centralised in one helper, driven by the currency code |

## Test strategy

- Unit: a non-integer amount is rejected; a negative amount is rejected; the
  limit comparison is exact at the boundary (`limit`, `limit + 1`).
- Integration: an expense in a currency other than the company's returns `422`.
- Integration: the stored value round-trips unchanged through the API.
