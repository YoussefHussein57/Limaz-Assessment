# Review lifecycle - the seven views

Diagrams for F05.

---

## 1. The state machine

```mermaid
stateDiagram-v2
    [*] --> OPEN: expense decision = REVIEW (A8)
    OPEN --> RESOLVED: manager approves
    OPEN --> RESOLVED: manager rejects
    RESOLVED --> RESOLVED: refused — 409, or 200 with no write
    note right of OPEN
        outcome, resolvedByUserId
        and resolvedAt are ALL null
    end note
    note right of RESOLVED
        all three are set, together
        — the CHECK constraint makes
        any half-state unstorable
    end note
```

There is no transition out of `RESOLVED`. Review reopening is out of scope,
and the CHECK constraint would have to be rethought to allow it.

---

## 2. Authentication and tenant-scoped access

```mermaid
flowchart TD
    A["GET /v1/reviews/:id"] --> B[CsrfGuard]
    B -->|POST without x-limaz-client| B1["403 csrf_header_required"]
    B --> C[AuthenticationGuard]
    C -->|no or bad session| C1["401 unauthenticated"]
    C --> D["AuthorizationGuard · @Roles('MANAGER')"]
    D -->|API key| D1["403 caller_type_not_allowed"]
    D -->|platform admin| D2["403 insufficient_role"]
    D --> E["tenantScope(principal) → companyId"]
    E --> F["findFirst WHERE id AND companyId"]
    F -->|no row| G["404 — 'not yours' and 'not there'<br/>are the SAME code path"]
    F --> H["200"]
```

The tenant predicate is **in the query**, not a check after fetching a global
row. A post-fetch check has already read another tenant's data into the
process, and is one refactor away from returning it.

404 rather than 403 for a foreign row: 403 confirms the row exists, which
would let a caller walk ids and learn how many reviews a competitor has
(ADR-003).

---

## 3. A successful resolution

```mermaid
sequenceDiagram
    autonumber
    participant M as manager
    participant S as service
    participant PG as postgres
    M->>S: POST /v1/reviews/{id}/resolve {decision APPROVE}
    S->>PG: BEGIN
    S->>PG: UPDATE reviews SET … WHERE id AND companyId AND state='OPEN'<br/>RETURNING expenseId
    PG-->>S: 1 row, expenseId
    S->>PG: UPDATE expenses SET status='APPROVED'<br/>WHERE id AND companyId AND status='PENDING_REVIEW'
    PG-->>S: 1 row
    S->>PG: COMMIT
    S->>PG: SELECT the review (after commit)
    S-->>M: 200 · state RESOLVED · outcome APPROVED · resolvedBy · resolvedAt
```

The reviewer comes from the session and the timestamp from
`clock_timestamp()` inside the UPDATE. Neither can be supplied by the caller -
the DTO refuses any such field.

The final read happens **after** COMMIT, so the response describes committed
state and never a view that could still roll back.

---

## 4. Two managers competing

```mermaid
sequenceDiagram
    autonumber
    participant A as Alice (APPROVE)
    participant B as Bob (REJECT)
    participant PG as postgres
    A->>PG: BEGIN · UPDATE … WHERE state='OPEN'
    PG-->>A: 1 row — Alice now holds the ROW LOCK
    B->>PG: BEGIN · UPDATE … WHERE state='OPEN'
    Note right of PG: Bob BLOCKS here.<br/>pg_blocking_pids() names Alice.
    A->>PG: UPDATE expenses · COMMIT
    Note right of PG: EvalPlanQual: Bob's WHERE is<br/>RE-EVALUATED against the updated row
    PG-->>B: state is RESOLVED → predicate fails → 0 rows
    B->>PG: ROLLBACK
    B->>PG: tenant-scoped lookup: resolved, by Alice, APPROVED
    B-->>B: 409 review_already_resolved
```

**The re-evaluation is the whole mechanism.** An in-memory check before an
unconditional UPDATE skips it entirely, and Bob's write lands on top of
Alice's - silently.

Which manager wins is **not determined**, so the tests assert the multiset of
outcomes and never an identity.

---

## 5. Rollback after a partial mutation

```mermaid
flowchart TD
    A[BEGIN] --> B["UPDATE reviews … WHERE state='OPEN'"]
    B -->|0 rows| C[ROLLBACK] --> D["tenant-scoped lookup<br/>→ 404 / 409 / 200 / 500"]
    B -->|1 row| E["UPDATE expenses … WHERE status='PENDING_REVIEW'"]
    E -->|count ≠ 1| F["throw → ROLLBACK"] --> G["500 · the review is still OPEN"]
    E -->|count = 1| H[COMMIT] --> I["200"]

    subgraph INV["while uncommitted, NOTHING is observable"]
        B
        E
    end
```

This is the answer to "what if the review update succeeds and the expense
update fails?" - **nothing is observable**. Neither write is visible to any
other transaction until COMMIT, so there is no moment at which the review is
resolved while its expense is still pending. That state exists only if the
two writes are split across separate transactions or separate HTTP calls.

F05-T39 forces it: the expense is moved out of `PENDING_REVIEW` behind the
service's back, the expense update matches zero rows, and the review is
asserted to be **still OPEN** afterwards.

---

## 6. The policy decision versus the final status

```mermaid
flowchart LR
    subgraph IMM["immutable — what the policy concluded"]
        D["Expense.decision = REVIEW"]
        R["rule_hits — every reason"]
        P["policySnapshot"]
    end
    subgraph MUT["changes at most once — the outcome"]
        S1["status = PENDING_REVIEW"] --> S2["APPROVED"]
        S1 --> S3["REJECTED"]
    end
    D -.->|opens, A8| REV["review OPEN"]
    REV -->|manager APPROVE| S2
    REV -->|manager REJECT| S3
    D ==>|NEVER rewritten| D
```

Merging the two fields would lose the answer to "what did the policy
originally say?", which is a basic audit question. A manager approving an
expense does not mean the policy was wrong to flag it.

---

## 7. Resubmission after a human resolution

```mermaid
sequenceDiagram
    autonumber
    participant C as company backend
    participant S as service
    participant PG as postgres
    Note over PG: expense exists · decision REVIEW · status APPROVED<br/>review RESOLVED by a manager
    C->>S: POST /v1/expenses (same externalId, same payload)
    S->>PG: BEGIN · advisory lock · idempotency lookup
    PG-->>S: FOUND, payload hash matches
    S->>PG: ROLLBACK
    S-->>C: 200 · decision REVIEW · status APPROVED · duplicate true
    Note over S,PG: no evaluation · no second review<br/>no reopened review · nothing counted again
```

The F03 response already carried both fields, which is why no correction was
needed: `decision` is the immutable policy conclusion, `status` the current
outcome.

The resolved expense still **counts** toward the frequency window - otherwise
approving an expense would quietly give the employee their window back
(F05-T30b).
