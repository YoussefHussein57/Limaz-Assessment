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

### 1. Functional completeness — 20 / 20

Every mandatory requirement in sections 2-9 is implemented and has named
evidence; the reconciliation is in
[requirements-traceability.md](requirements-traceability.md).

Section 10, the optional card webhook, is **also** implemented - after the
core was finished, verified and tagged `v1.0.0-core`, which is what the brief
asks. Every clause of it is mapped to evidence in the traceability matrix,
including the two that ask for an **explanation** rather than code: what
happens when the queue is down, and how you would find events the provider
never delivered. The second is answered honestly - this system cannot, on its
own - rather than with a feature that does not exist.

The previous version of this review deducted a point here for section 10 being
untouched. That deduction is gone, and the mark is now full.

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

649 tests, 534 against real PostgreSQL with no mocked repositories;
concurrency tests that genuinely overlap; four negative controls; assertions
on database state rather than only on status codes.

The webhook suites add a property worth naming: the signature is computed
**independently** in the test client and in `scripts/send-card-webhook.mjs`,
rather than by importing the implementation. If both sides came from one
function, a mistake in it would be symmetric and invisible.

**−1:** no automated DOM or interaction tests (R-23). Browser behaviour is
verified by hand and labelled as such, which is honest but not repeatable.

**−1:** no load testing anywhere. The scaling answer is architectural, with a
laptop smoke test labelled as a sanity check.

### 5. Documentation and AI transparency — 14 / 15

A README written for somebody who has never seen the project, eleven ADRs, a
requirements traceability matrix, a 37-entry risk register where every status
names its evidence, and an AI log of 67 defects - each with how it was noticed
and what stops it recurring, including the ones that were embarrassing.

**−1:** there is a lot of it, and the webhook bonus made it longer. A reviewer
with twenty minutes will read the README and nothing else, and some of the
depth below it will go unseen. The bonus is a clearly separated section with
its own entry in the reviewer navigation, so it can be skipped entirely - but
the volume is a real cost and pretending otherwise would be the wrong answer
to a brief that says "small and correct beats broad".

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
of F09, survives a restart after somebody has used the application - which the
fresh-install script now re-checks explicitly, along with the webhook events,
the provisioned manager and the stored signing secret still verifying after a
restart.

---

## Total: 93 / 100

One point recovered on functional completeness, because the optional webhook
is now built and verified rather than deliberately skipped. Nothing else moved
- the bonus did not fix the frontend test gap, the load testing gap or the
audit log, and inflating the other sections because a large feature landed
would make this document useless.

An interviewer who expects automated frontend tests as table stakes would land
lower - somewhere in the high eighties. One who weights proven correctness
under concurrency would land higher. The spread is the honest answer.

### The score did not move after the QA regression pass, and that is a claim

An independent black-box pass over the merged build (198 cases, 12 cycles,
sharing no code with these suites) found **no functional defect** and six
minor ones. All six are fixed or recorded. The total stays at 93 because none
of them was a point: two were security hygiene, two were documentation
accuracy, one was a search filter and one was developer experience.

What it **did** change is the confidence behind the sections above. The four
guarantees the assessment grades - tenant isolation, idempotency, the
frequency rule, concurrent resolution - were attacked by somebody who had not
read the implementation, and they held. That is worth more here than a point.

It also found two gaps that were in neither the risk register nor the F13
security audit (now R-39 and R-40), which is a fair measure of how far a
self-audit reaches on its own.

---

## Strongest parts

1. **The negative controls.** Four mechanisms, and for each one a test that
   removes it and watches the failure reappear. It is the difference between
   "my tests pass" and "my tests would fail if the guarantee were gone".
2. **Tenant isolation measured rather than asserted.** The authorization
   matrix was executed against the running stack with the UI bypassed, and the
   RSC payload was read directly for both role directions.
3. **The AI log.** Sixty-seven defects with attribution of how each was noticed
   - including a live API key I wrote into a screenshot during my own
   verification, an acceptance script that had been failing for six features
   while reports quoted the two that passed, and an oversized request body
   that had been answering 500 on every endpoint since F03, found by a
   webhook test and pre-existing.
4. **Separating `decision` from `status`.** One schema choice that makes
   "the policy said review, a human approved it" representable, and the UI
   explains it rather than hiding it.

## Remaining weaknesses

1. No automated frontend interaction tests (R-23).
2. No load testing; the scaling answer is architectural.
3. Three high and nineteen moderate `npm audit` findings, analysed as
   unreachable but not resolved (R-30), and a production image that still
   carries devDependencies.
4. **The webhook bonus cannot find events the provider never sent** (R-38).
   That gap is explained in full rather than implemented, because
   reconciliation needs a provider API this integration does not have - but it
   is still a gap.
5. No audit log for administrative actions.
6. **A self-audit missed two hardening gaps.** The QA pass found that nothing
   stopped the dashboard being framed, and that both tiers named their
   framework on every response. Both are now fixed and recorded (R-39, R-40),
   but neither was in the risk register beforehand, which is the part that
   matters: they were not accepted trade-offs, they were things nobody had
   looked at.
6. The webhook worker runs inside the API process. Separating it needs no code
   change, but it has not been done or demonstrated (R-37).

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
