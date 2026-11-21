# Self-review against the assessment

A deliberate attempt to read this repository the way an interviewer would, on
a first pass, with the brief open beside it.

> **This is my own score, not LIMAZ's**, and a rubric I wrote myself. Its only
> real use is that the deductions are specific - each one names something a
> reviewer could point at.

---

## The rubric

Weighted toward what the brief says it cares about: *"Small and correct beats
broad"*, and *"we'll ask why each part is there and what breaks if it
changes"*.

| | Area | Weight |
|---|---|---|
| 1 | Functional requirement completeness | 20 |
| 2 | Security and multi-tenant correctness | 20 |
| 3 | Idempotency, concurrency and data integrity | 15 |
| 4 | Test quality - does the evidence prove the claim? | 15 |
| 5 | Documentation and AI transparency | 15 |
| 6 | Code quality, UI, responsive and accessibility | 10 |
| 7 | Reproducibility | 5 |

---

## Scoring

### 1. Functional completeness — 19 / 20

Every mandatory requirement in sections 2-9 is implemented and has named
evidence; the reconciliation is in
[requirements-traceability.md](requirements-traceability.md).

**−1:** section 10, the card webhook, is untouched. It is marked
`OPTIONAL BONUS` and the brief says to attempt it "only once the core works",
so this is a deliberate reading of the instruction rather than a gap - but a
reviewer who wanted to see the HMAC and exactly-once design has nothing to
look at.

### 2. Security and multi-tenancy — 18 / 20

The tenant comes from the credential and nowhere else; a body carrying
`companyId` is a `400` rather than being quietly stripped. Cross-tenant reads
answer `404`, with the predicate inside the query rather than in a branch
after it, and a negative control that shows the whole table returning when it
is removed. Four CSRF layers, credentials hashed at rest, lifecycle conditions
inside the authentication `WHERE`. The whole authorization matrix was measured
against the running stack with the UI bypassed.

**−1:** no rate limiting on login and no Content-Security-Policy (R-19, R-18).
Both are recorded rather than implied, but both are things a real deployment
needs.

**−1:** no audit logging of administrative actions. Who revoked a key, and
when, is recoverable from `revokedAt` but not from a log.

### 3. Idempotency, concurrency and data integrity — 14 / 15

Three different problems solved with three different database mechanisms, each
with a negative control that fails when the mechanism is removed. Composite
foreign key, five CHECK constraints, and a policy snapshot per expense so
history cannot be rewritten by an edit.

**−1:** two known semantic gaps - a back-dated expense can evade the frequency
rule (R-11), and concurrent policy edits are last-write-wins (R-31). Both are
argued rather than hidden, and neither is required by the brief, but they are
real behaviour a reviewer can find.

### 4. Test quality — 13 / 15

517 tests, 487 against real PostgreSQL with no mocked repositories; concurrency
tests that genuinely overlap; four negative controls; assertions on database
state rather than only on status codes.

**−1:** no automated DOM or interaction tests (R-23). Browser behaviour is
verified by hand and labelled as such, which is honest but not repeatable.

**−1:** no load testing anywhere. The scaling answer is architectural, with a
laptop smoke test labelled as a sanity check.

### 5. Documentation and AI transparency — 14 / 15

A README written for somebody who has never seen the project, eleven ADRs, a
requirements traceability matrix, a 34-entry risk register where every status
names its evidence, and an AI log of 50 defects - each with how it was noticed
and what stops it recurring, including the ones that were embarrassing.

**−1:** there is a lot of it. A reviewer with twenty minutes will read the
README and nothing else, and some of the depth below it will go unseen. The
README now links the five documents worth opening, but the volume is a real
cost.

### 6. Code quality, UI, responsive, accessibility — 9 / 10

No debug statements, no TODOs, no string-built SQL, no unused dependencies;
every raw query parameterised through a tagged template. Zero horizontal
overflow across 48 page/width measurements. Keyboard journeys, dialog focus
trap and restoration, no unnamed controls.

**−1:** no screen-reader session with real assistive technology, and no WCAG
conformance claim. Two inline links fall below the 24px target size - exempt
as inline text, but recorded rather than hidden.

### 7. Reproducibility — 5 / 5

`cp .env.example .env && docker compose up`, verified from a clean clone in an
isolated compose project, with the credentials and the API keys exercised on
that stack rather than on the development one. The seed is idempotent and, as
of F09, survives a restart after somebody has used the application.

---

## Total: 92 / 100

An interviewer who weights the optional webhook heavily, or who expects
automated frontend tests as table stakes, would land lower - somewhere in the
mid-eighties. One who weights proven correctness under concurrency would land
higher. The spread is the honest answer.

---

## Strongest parts

1. **The negative controls.** Four mechanisms, and for each one a test that
   removes it and watches the failure reappear. It is the difference between
   "my tests pass" and "my tests would fail if the guarantee were gone".
2. **Tenant isolation measured rather than asserted.** The authorization
   matrix was executed against the running stack with the UI bypassed, and the
   RSC payload was read directly for both role directions.
3. **The AI log.** Fifty defects with attribution of how each was noticed -
   including a live API key I wrote into a screenshot during my own
   verification, and an acceptance script that had been failing for six
   features while reports quoted the two that passed.
4. **Separating `decision` from `status`.** One schema choice that makes
   "the policy said review, a human approved it" representable, and the UI
   explains it rather than hiding it.

## Remaining weaknesses

1. No automated frontend interaction tests (R-23).
2. No load testing; the scaling answer is architectural.
3. Three high and nineteen moderate `npm audit` findings, analysed as
   unreachable but not resolved (R-30), and a production image that still
   carries devDependencies.
4. The optional webhook is not built.
5. No audit log for administrative actions.

## Likely interview follow-ups

- *"Show me where the tenant check would be forgotten."* — risk R-20, and the
  honest answer is that nothing structural prevents it; `tenantScope()` is a
  convention with a negative control, not a type-level guarantee.
- *"Your advisory lock is per employee. What happens with one very busy
  employee?"* — complete serialisation, and the workload's shape matters more
  than its rate.
- *"Why is the frequency rule's gap acceptable but double-resolution is
  not?"* — one is a rule's edge, the other is a lost update on money that a
  company audits.
- *"What would you do first with another week?"* — close R-23 with a browser
  suite, because every browser claim in this repository currently depends on
  a human having looked.

## Submission blockers

**None.** The repository runs from a clean clone, every documented credential
works, all gates pass, and the remote is in sync. The only outstanding items
are the project owner's: deciding whether to make the repository private, and
sending the email.
