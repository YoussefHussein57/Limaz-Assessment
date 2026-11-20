# Expense submission - the seven views

Diagrams for F03. Each one answers a question that is hard to answer in prose.

---

## 1. The submission lifecycle

```mermaid
flowchart TD
    A["POST /v1/expenses"] --> B[CsrfGuard]
    B -->|no api key, no client header| B1["403 csrf_header_required"]
    B -->|api key present: exempt| C[AuthenticationGuard]
    C -->|unknown / revoked / expired| C1["401 unauthenticated"]
    C --> D[AuthorizationGuard]
    D -->|a user session| D1["403 caller_type_not_allowed"]
    D --> E["Phase 1: shape (zod .strict)"]
    E -->|bad type, decimal, overflow,<br/>unknown field, impossible date| E1["400 invalid_request"]
    E --> F["normalise + SHA-256"]
    F --> G["BEGIN · READ COMMITTED"]
    G --> H["pg_advisory_xact_lock"]
    H --> I["SELECT by companyId + externalId"]
    I -->|found, hash equal| I1["ROLLBACK<br/>200 duplicate:true"]
    I -->|found, hash differs| I2["ROLLBACK<br/>409 conflict + details"]
    I -->|not found| J["Phase 2: currency A3, window A4"]
    J -->|fails| J1["ROLLBACK<br/>422"]
    J --> K[load policy]
    K --> L[["PolicyEvaluator<br/>F04"]]
    L --> M[INSERT expense]
    M --> N[INSERT rule_hits]
    N --> O{decision = REVIEW?}
    O -->|yes, A8| P[INSERT review]
    O -->|no| Q
    P --> Q["COMMIT → 201"]
    M -->|23505 on our index| R["transaction ABORTED<br/>full ROLLBACK"]
    R --> S["re-read on a fresh connection"]
    S --> I1
    S --> I2
```

**Guards before parsing.** An unauthenticated caller never reaches the DTO, so
validation messages cannot be used to probe the schema.

**Hash before the transaction.** Canonicalisation is pure and needs no
database, so it happens before a connection is held.

---

## 2. Normalisation and hashing

```mermaid
flowchart LR
    subgraph IN["raw body"]
        R1["externalId: 'exp-1001'"]
        R2["employeeId: 'emp-7'"]
        R3["amount: 12500"]
        R4["currency: 'sar'"]
        R5["merchant: ' City  Taxi '"]
        R6["category: ' transport '"]
        R7["spentAt: '…T12:15+03:00'"]
    end

    R1 -.->|NOT hashed:<br/>it is the key| X[" "]
    R2 -->|untouched| N2["'emp-7'"]
    R3 --> N3["12500"]
    R4 -->|trim + UPPER| N4["'SAR'"]
    R5 -->|NFC + trim + collapse<br/>case preserved| N5["'City Taxi'"]
    R6 -->|NFC + trim + UPPER| N6["'TRANSPORT'"]
    R7 -->|UTC, ms precision| N7["'…T09:15:00.000Z'"]

    N2 & N3 & N4 & N5 & N6 & N7 --> ARR["JSON.stringify([ … ])<br/>fixed order, no delimiter"]
    ARR --> SHA["SHA-256 → payloadHash"]
    N2 & N3 & N4 & N5 & N6 & N7 --> ROW[(the stored row)]

    style X fill:none,stroke:none
```

**The same normalised values feed both the hash and the row.** If they
diverged, a retry of a stored expense could hash differently from the expense
it is a retry of.

`employeeId` is untouched because normalising an identifier merges identities.
`merchant` and `category` are content, so normalising them removes differences
that carry no business meaning.

---

## 3. Sequential retry

```mermaid
sequenceDiagram
    autonumber
    participant C as company backend
    participant S as service
    participant PG as postgres
    C->>S: POST exp-1001 {amount 12500}
    S->>PG: BEGIN, advisory lock
    S->>PG: SELECT by (company, exp-1001) → none
    S->>PG: evaluate, INSERT, COMMIT
    S-->>C: 201 {id, decision, reasons, duplicate:false}
    Note over C: the response is lost
    C->>S: POST exp-1001 {amount 12500} (retry)
    S->>PG: BEGIN, advisory lock
    S->>PG: SELECT → FOUND, hash matches
    S->>PG: ROLLBACK
    S-->>C: 200 {same id, same decision, duplicate:true}
    Note over S,PG: no evaluation, no rule hit,<br/>no review, nothing counted
```

The server cannot tell a lost response from an ordinary retry, and does not
try. There is no "was the response delivered?" state, and there should not be.

---

## 4. Concurrent duplicates

```mermaid
sequenceDiagram
    autonumber
    participant A as request A
    participant B as request B
    participant PG as postgres
    Note over A,B: identical bodies, SAME employeeId
    A->>PG: BEGIN, advisory_xact_lock(c, e)
    B->>PG: BEGIN, advisory_xact_lock(c, e)
    PG-->>A: granted
    Note right of PG: B BLOCKS here
    A->>PG: SELECT → none
    A->>PG: INSERT, COMMIT
    Note right of PG: lock released
    PG-->>B: granted
    B->>PG: SELECT → FOUND (A committed)
    B->>PG: ROLLBACK
    Note over A,B: one 201, one 200, one row
```

**The lock decides here, not the unique index.** B never attempts an INSERT,
so the index is never consulted. Which request wins is not determined, so
F03-T17 and F03-T18 assert the multiset of outcomes, never identities.

---

## 5. Conflicting payloads, and where the index actually fires

```mermaid
sequenceDiagram
    autonumber
    participant A as request A (emp-alpha)
    participant B as request B (emp-beta)
    participant PG as postgres
    Note over A,B: same externalId, DIFFERENT employeeId<br/>→ different lock keys, nothing serialises
    A->>PG: BEGIN, lock(c, alpha) granted
    B->>PG: BEGIN, lock(c, beta) granted
    A->>PG: SELECT → none
    B->>PG: SELECT → none
    Note over A,B: both see nothing: neither has committed
    A->>PG: INSERT → ok
    B->>PG: INSERT → 23505
    A->>PG: COMMIT
    Note right of B: transaction now ABORTED.<br/>any SELECT here → 25P02
    B->>PG: ROLLBACK
    B->>PG: re-read on a FRESH connection → A's row
    Note over B: hash differs (employeeId) → 409
```

This is the only shape in which the unique index decides, which is why
**F03-T21** exists and why the negative control uses it. A suite testing only
diagram 4 passes with the index dropped.

---

## 6. Rollback and recovery

```mermaid
flowchart TD
    A[BEGIN, lock acquired] --> B[idempotency read]
    B --> C[evaluate]
    C -->|throws| R1[ROLLBACK]
    C --> D[INSERT expense]
    D -->|23505 on OUR index| R2[ROLLBACK] --> E[re-read] --> F["200 or 409"]
    D -->|23505 on another index| R3[ROLLBACK] --> G["500 internal_error"]
    D --> H[INSERT rule_hits]
    H --> I{REVIEW?}
    I -->|yes| J[INSERT review] --> K[COMMIT]
    I -->|no| K
    R1 --> G

    subgraph REL["released at COMMIT or ROLLBACK, both"]
        K
        R1
        R2
        R3
    end
```

Three properties this shows:

1. **The advisory lock releases on either path**, because it is
   transaction-scoped. A session-scoped lock would survive a rollback and
   poison a pooled connection permanently (F03-T22b).
2. **A failure before the commit leaves nothing**, including the identifier -
   it is free to be submitted again (F03-T22).
3. **The 23505 branches split on WHICH index fired.** Treating any unique
   violation as an idempotency conflict would tell a caller their expense
   already existed when it was never written, and they would stop retrying
   (F03-T24).

---

## 7. The F03 / F04 boundary

```mermaid
flowchart TB
    subgraph F03["F03 - orchestration, built"]
        direction TB
        A1[DTO + two-phase validation]
        A2[canonicalisation + SHA-256]
        A3[transaction + advisory lock]
        A4[idempotency + conflict handling]
        A5[persistence: expense, rule hits, review]
    end

    PORT[["PolicyEvaluator<br/><br/>evaluate(expense, policy, companyId, tx)<br/>→ { decision, ruleHits[] }"]]

    subgraph F04["F04 - the decision, not built"]
        direction TB
        B1["COUNT(*) in the window<br/>protected by the lock above"]
        B2[AMOUNT_LIMIT · FREQUENCY · BLOCKED_CATEGORY]
        B3[precedence → one decision]
    end

    A3 --> PORT
    PORT -.->|"ExpensesModule.withEvaluator({...})"| B1
    B1 --> B2 --> B3
    B3 -.->|decision + reasons| A5

    subgraph PROD["deployed application today"]
        X["no expense endpoint at all"]
    end
```

`ExpensesModule` exposes **only** `withEvaluator()`, so wiring it requires
naming an evaluator. In F03 the sole caller is the test factory.

**Why not a stub returning APPROVE:** an endpoint that approves without
evaluating the frequency rule is not incomplete, it is wrong - and wrong in
the direction that approves spending the policy says to review. The
`expenses_decision_status_check` constraint would also refuse to store a
placeholder, so the shortcut was never available.

**What F04 changes:** one line in `app.module.ts` and one interface
implementation. No migration, no backfill, and no row has ever carried a
decision that was not genuinely evaluated.
