# ADR-010: NestJS 11 and TypeScript 5.9, not the newest releases

- **Status:** Accepted, 2026-11-19 - **implemented in F00**
- **Assessment question:** none (toolchain)
- **Decided by:** the project owner, after the evidence below was gathered

## Context

At the time of writing, the newest published versions were NestJS **12.5.1** and
TypeScript **7.0.2**. Both were rejected, each for a specific, verified reason.

## Evidence

### TypeScript 7 breaks lint and tests

| Tool | Supported TypeScript range | Source |
|---|---|---|
| `typescript-eslint@8.73.0` | `>=4.8.4 <6.1.0` | its `peerDependencies` |
| `ts-jest@29.4.15` | `>=4.3 <7` | its `peerDependencies` |
| `@nestjs/cli@11.0.24` | pins `5.9.3` | its `dependencies` |

TypeScript 7 is outside both ranges. Adopting it would mean no type-aware
linting and no TypeScript test transform - on a project whose core deliverable
is a test suite proving four correctness guarantees.

TypeScript **6.0.3** was tried first and also rejected: it emits hard errors for
`moduleResolution: node10` and `baseUrl`, and - more importantly - would have
left the build running `@nestjs/cli`'s bundled 5.9.3 while lint and typecheck ran
6.0.3. **One TypeScript version across build, typecheck, lint and tests** is
worth more than being one major ahead.

### NestJS 12 is ESM-only and breaks Jest on Node 22

`@nestjs/core@12.5.1` and `@nestjs/testing@12.5.1` both declare
`"type": "module"` with no CommonJS export. `@nestjs/core@11.2.11` declares no
`type` field, so it is CommonJS.

Measured on Node 22.20.0:

| | Result |
|---|---|
| **The application itself** | **Works.** The compiled CommonJS build ran, served `GET /health` with `200`, and reported a real database round trip of 2.57 ms. Node 22.12+ supports `require(esm)`. |
| **Jest** | **Fails.** `Must use import to load ES Module: node_modules/@nestjs/testing/index.js`. Jest's own error text states the requirement: Node **24.9+** for native `require(esm)`. |

9 of 9 tests that touched only our own source passed. The 2 suites that import
`@nestjs/testing` could not load.

## Options presented and the decision

| Option | Trade-off | Outcome |
|---|---|---|
| **NestJS 11.2.11 (CommonJS)** | One major behind; Jest, ts-jest and supertest are the documented, friction-free setup | **Chosen by the project owner** |
| Node 24 LTS + NestJS 12 + Jest | Keeps the newest framework and also clears the `@nestjs/schematics` engine warning, but requires a manual Node installer that replaces Node 22 machine-wide, and forces `node >= 24.9` on the reviewer | Rejected |
| NestJS 12 + Vitest + `unplugin-swc` | No Node change, but swaps the test runner and adds an SWC plugin, because esbuild does not support `emitDecoratorMetadata`, which Nest's DI requires | Rejected |

## Decision

| Package | Version | Reason |
|---|---|---|
| `@nestjs/*` | `11.2.11` | CommonJS; works with Jest on Node 22 |
| `@nestjs/cli` | `11.0.24` | `engines: node >= 20.11`, no engine warning on Node 22.20 |
| `typescript` | `5.9.3` | The version the Nest CLI pins; inside every peer range |
| `prisma` / `@prisma/client` | `7.10.1` | Current stable (ADR-009) |
| `next` / `react` | `16.4.6` / `19.3.1` | Current |
| `jest` / `ts-jest` | `30.5.2` / `29.4.15` | Current |
| `eslint` / `typescript-eslint` | `10.15.0` / `8.73.0` | Current |
| `tailwindcss` | `4.3.5` | Current |

Only the NestJS line is held back. Everything else is current.

## Rationale

The assessment grades a test suite that proves tenant isolation, idempotency,
concurrent resolution and decision precedence. The test runner is therefore
load-bearing infrastructure, not a detail. Choosing a framework major that is
two weeks newer, at the cost of making the test runner the most fragile part of
the stack, is the wrong trade.

Holding one dependency back for a stated, measured reason is an engineering
decision. Taking the newest of everything by default is not.

## Consequences

- The project runs on Node `>= 22.12` with no engine warnings, so a reviewer on
  Node 22 or Node 24 can run everything.
- If NestJS 12 becomes necessary later, the migration path is Node 24.9+ plus
  Jest, or a move to Vitest. Neither is blocked by anything built here.
- `module: nodenext` is used rather than the deprecated `node10`, so the code is
  already positioned for a future ESM move.

## Verification performed in F00

```
Test Suites: 3 passed, 3 total
Tests:       13 passed, 13 total
```

`npm run verify` (lint, typecheck, build for both workspaces) exits `0`.
