# Policy evaluation - the five views

Diagrams for F04. Each answers a question that is hard to answer in prose.

---

## 1. The complete submission lifecycle

```mermaid
flowchart TD
    A["POST /v1/expenses"] --> B[CsrfGuard → Authentication → Authorization]
    B --> C["Phase 1: shape (zod .strict)"]
    C -->|fails| C1["400"]
    C --> D["normalise + SHA-256"]
    D --> E["BEGIN · READ COMMITTED"]
    E --> F["pg_advisory_xact_lock(company, employee)"]
    F --> G["idempotency lookup"]
    G -->|same hash| G1["ROLLBACK → 200 duplicate"]
    G -->|different hash| G2["ROLLBACK → 409"]
    G -->|not found| H["Phase 2: currency A3 · window A4"]
    H -->|fails| H1["ROLLBACK → 422"]
    H --> I["load policy"]
    I --> J["COUNT(*) in [spentAt - window, spentAt]"]
    J --> K["evaluateRules(amount, category, count+1, policy)"]
    K --> L["decide() by RANK"]
    L --> M["INSERT expense · decision + status"]
    M --> N["INSERT rule_hits · one per triggered rule"]
    N --> O{decision = REVIEW?}
    O -->|yes| P["INSERT review · OPEN"]
    O -->|no| Q
    P --> Q["COMMIT → 201"]
    M -->|23505 on our index| R["ROLLBACK → re-read → 200 or 409"]
```

**The lock is the first statement**, so the COUNT that follows snapshots after
it is held. **The evaluation is inside the transaction**, so the decision and
the row it describes commit together - and the `expenses_decision_status_check`
constraint would reject a row whose status did not match its decision anyway.

---

## 2. Evaluation and precedence

```mermaid
flowchart TD
    IN["amountMinor · category · countIncludingCurrent · policy"] --> R1
    IN --> R2
    IN --> R3
    R1["amountLimitRule<br/>amount > limit?"] -->|hit: REVIEW| H
    R1 -->|no| H
    R2["blockedCategoryRule<br/>category in list?"] -->|hit: REJECT| H
    R2 -->|no| H
    R3["frequencyRule<br/>count > maxCount?"] -->|hit: REVIEW| H
    R3 -->|no| H
    H["hits[] — every rule ran, nothing short-circuited"] --> D{"hits empty?"}
    D -->|yes| A["APPROVE · 0 reasons · APPROVED · no review"]
    D -->|no| M["max by RANK<br/>APPROVE 1 · REVIEW 2 · REJECT 3"]
    M -->|highest = REVIEW| V["REVIEW · ALL reasons · PENDING_REVIEW · ONE open review"]
    M -->|highest = REJECT| J["REJECT · ALL reasons · REJECTED · NO review"]
```

**Nothing short-circuits.** When the blocked-category rule fires the outcome is
already settled, and the other two still run - because the decision carries
one piece of information and the evaluation carries three. A manager reading
the expense later needs all three.

**Precedence is a rank table, not the order the lines appear in.** Reordering
the three calls provably cannot change the answer, which is what F04-T15
asserts over all six permutations.

**Two REVIEW rules still open one review.** The review belongs to the expense,
not to the rule.

---

## 3. Five concurrent submissions, one employee

```mermaid
sequenceDiagram
    autonumber
    participant R as 5 requests
    participant PG as postgres
    Note over R,PG: same company · same employee · same spentAt<br/>5 different externalIds · maxCount 3
    R->>PG: all five BEGIN and request the SAME advisory lock
    Note right of PG: one holder, four waiting
    PG-->>R: #1 granted
    R->>PG: count 0 → 1 → APPROVE → COMMIT
    PG-->>R: #2 granted
    R->>PG: count 1 → 2 → APPROVE → COMMIT
    PG-->>R: #3 granted
    R->>PG: count 2 → 3 → APPROVE (3 is not > 3) → COMMIT
    PG-->>R: #4 granted
    R->>PG: count 3 → 4 → REVIEW + review row → COMMIT
    PG-->>R: #5 granted
    R->>PG: count 4 → 5 → REVIEW + review row → COMMIT
    Note over R,PG: 5 expenses · 3 APPROVE · 2 REVIEW · 2 OPEN reviews · 2 FREQUENCY hits
```

The numbering is illustrative: **which request acquires the lock first is not
determined**, so F04-T26 asserts the multiset of outcomes and never an
identity.

The recorded `countIncludingCurrent` values are **4 and 5**, which is only
reachable if the transactions saw one another in order. Remove the lock and
all five count zero - that is F04-NC1, and it is why this diagram is evidence
rather than illustration.

---

## 4. Rollback

```mermaid
flowchart TD
    A["BEGIN · lock granted"] --> B[idempotency lookup]
    B --> C["currency / window checks"]
    C -->|422| X[ROLLBACK]
    C --> D[load policy]
    D -->|missing| X
    D --> E["COUNT + evaluate"]
    E -->|throws| X
    E --> F[INSERT expense]
    F -->|23505 on OUR index| Y[ROLLBACK] --> Z["re-read on a FRESH connection → 200 or 409"]
    F -->|23505 on another index| X
    F --> G[INSERT rule_hits]
    G -->|fails| X
    G --> H{REVIEW?}
    H -->|yes| I[INSERT review] --> K[COMMIT]
    H -->|no| K
    I -->|fails| X
    X --> W["500 · nothing persisted · externalId free again"]

    subgraph REL["the advisory lock releases on EVERY path"]
        K
        X
        Y
    end
```

Three properties:

1. **The lock releases on commit and on rollback alike**, because it is
   transaction-scoped. A session-scoped lock would survive a failed
   transaction and poison a pooled connection permanently (F04-T32).
2. **Nothing partial survives.** The expense, its rule hits and its review are
   one transaction, so a failure at any step leaves no trace - including the
   identifier, which is free to submit again (F04-T37).
3. **The 23505 branches split on which index fired.** Treating any unique
   violation as an idempotency conflict would tell a caller their expense
   already existed when it was never written.

---

## 5. A retry after the policy changed

```mermaid
sequenceDiagram
    autonumber
    participant C as company backend
    participant S as service
    participant PG as postgres
    C->>S: POST exp-1 · 60,000 · limit is 50,000
    S->>PG: count, evaluate → REVIEW [AMOUNT_LIMIT]
    S->>PG: INSERT expense + rule hit + review<br/>policySnapshot = {limit 50,000, max 3, 60 min, [GAMBLING]}
    S-->>C: 201 REVIEW
    Note over PG: a manager raises the limit to 500,000
    C->>S: POST exp-1 · 60,000 (retry)
    S->>PG: idempotency lookup → FOUND, hash matches
    S->>PG: ROLLBACK
    S-->>C: 200 REVIEW · the ORIGINAL reasons · duplicate true
    Note over S,PG: no evaluation · no new snapshot · nothing counted
    C->>S: POST exp-2 · 60,000 (new)
    S->>PG: count, evaluate against the CURRENT policy → APPROVE
    S-->>C: 201 APPROVE · snapshot {limit 500,000, ...}
```

A retry is a **replay of a fact**, not a new evaluation. Re-evaluating would
change a decision already reported to the caller, and the review opened against
it would stop matching the expense it describes.

A new expense is a **new fact**, judged by whatever policy is current. The
snapshot recorded on each expense *is* the version - which is why no policy
versioning system is needed.

Tests F04-T40, T41, T42.
