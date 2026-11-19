# Architecture Decision Records

One record per decision that is expensive to reverse. Each states what we chose,
what we rejected, and what would have to change for the decision to be wrong.

| ADR | Decision | Assessment question | Status |
|-----|----------|---------------------|--------|
| [ADR-001](ADR-001-idempotency-conflicting-payload.md) | Same `externalId`, different body | Q1 | Accepted |
| [ADR-002](ADR-002-frequency-window.md) | Frequency window semantics | Q2 | Accepted |
| [ADR-003](ADR-003-cross-tenant-response.md) | Cross-tenant record access | Q3 | Accepted |
| [ADR-004](ADR-004-review-resolution.md) | Review resolution and final status | Q4 | Accepted |
| [ADR-005](ADR-005-money-representation.md) | Money representation | Q5 | Accepted |
| [ADR-006](ADR-006-api-key-storage-rotation.md) | API key storage and rotation | Q6 | Accepted |
| [ADR-007](ADR-007-frequency-concurrency.md) | Frequency counting under concurrency | Q7 | Accepted |
| [ADR-008](ADR-008-browser-session.md) | Browser session storage | Q8 | Accepted |
| [ADR-009](ADR-009-prisma-7-driver-adapter.md) | Prisma 7 driver adapter | - | Accepted, implemented in F00 |
| [ADR-010](ADR-010-nestjs-11-toolchain.md) | NestJS 11 and TypeScript 5.9 toolchain | - | Accepted, implemented in F00 |

ADR-001 to ADR-008 answer the eight questions in section 8 of the assessment.
They are **decided** but **not yet implemented**: they land in F01 to F05.

ADR-009 and ADR-010 record toolchain decisions that were forced by evidence
gathered while building F00, and are already in effect.
