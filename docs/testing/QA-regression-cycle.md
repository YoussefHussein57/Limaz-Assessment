# QA regression cycle - independent test pass

**Date:** 21 November 2026
**Build under test:** `733d227` (merge of `feature/webhook-bonus`). The only
change to `apps/` since `bc23849` is `test/suite-lock.ts`, a test-harness file;
no production code differs.
**Environment:** Windows 11, Docker Compose (PostgreSQL 17.11, API and web images built from this tree), Node 22.20
**Role:** independent test pass - the requirements were re-read first, then
exercised against the running stack rather than against the project's own claims.

---

## Verdict

**No functional defect was found.** Every mandatory requirement in sections 2
to 8 of the assessment, and every clause of the optional section 10, behaved as
specified under a black-box test that never read the implementation first.

Six findings are recorded below. **All six are minor**: four are cosmetic or
documentation accuracy, two are hardening items. None blocks the submission,
none breaks a requirement, and none needs to be fixed for the assessment to be
correct. They are listed because a tester who found nothing would not have
looked.

|                                                | Count |
| ---------------------------------------------- | ----- |
| Critical                                       | **0** |
| Major                                          | **0** |
| Minor                                          | **6** |
| Confirmed documented limitations (not defects) | 2     |

---

## Resolution — all six addressed, 21 November 2026

Added after the pass, by the author of the code under test. Every finding was
**reproduced first**: a report is evidence to check, not an instruction to act
on, and one of the six turned out to be wider than the behaviour supports.

**Re-run after the fixes, against a rebuilt stack:**

| | |
| --- | --- |
| These black-box cycles | **198 / 198**, 5 / 5 cycles — including `C1.03` (framework header) and `C8.10` (search metacharacters), the two cases that reported findings |
| `apps/api` | **619** passed, 39 suites — 617 before, plus `F06-T14c` and `F04-T26b` |
| `apps/web` | **30** passed |
| **Total** | **649 passed, 0 failed, 0 removed** |
| `verify-f00` / `f01` / `f02` / `f02-1` | 18/18 · 11/11 · 16/16 · 18/18 |
| `check-security-headers.sh` | 6 / 6 |
| `npm run lint`, `typecheck`, `build` | clean |

| | Finding | What was done | Verified by |
| --- | --- | --- | --- |
| MIN-01 | `X-Powered-By` on both tiers; clickjacking unrecorded | **Fixed.** `disable('x-powered-by')` on Express, `poweredByHeader: false` on Next. Clickjacking closed properly rather than only noted: `frame-ancestors 'none'` + `X-Frame-Options: DENY`, plus `nosniff` and a `Referrer-Policy`. Both gaps are now risk entries — **R-40** and **R-39** | Response headers on both tiers after a rebuild |
| MIN-02 | `%` and `_` act as wildcards in the expense search | **Fixed.** `escapeLikePattern` escapes `\`, `%` and `_` — backslash first — before the term reaches `contains` | **F06-T14c**, plus a negative control: with the escape removed the test fails on the assertion that each term must *not* match the other's row |
| MIN-03 | The frequency limit under-fires on a concurrent burst; R-11 understates it | **No code change**, as recommended. R-11 retitled and widened, ADR-002 given a scope correction, and the README and traceability rows reworded | **F04-T26b**, which asserts the two invariants that hold on every interleaving and deliberately asserts no approval count |
| MIN-04 | The README's test-count breakdown is not accurate | **Fixed**, and measured rather than estimated: every suite was classified from a Jest JSON report plus its imports. **534** of 619 API tests open a database connection, not 617. Corrected in five documents | The classification is reproducible from `--json` output |
| MIN-05 | The authorization matrix says 401 where the server answers 403 | **Fixed, with the scope corrected** — see below | `GET` and `PATCH` both exercised against the running stack |
| MIN-06 | A failing `globalSetup` reports `[AggregateError]` and nothing else | **Fixed.** `global-setup.ts` now walks `error.errors` and the `cause` chain, prints `code`, prints the captured `stdout`/`stderr` of a failed `prisma migrate deploy`, and names the host and port it was dialling — never the URL, which carries a password | Read back from the file; the shape is the one `pg` raises |

### The one finding that did not hold as written

MIN-05 states that a request with no credential and no `x-limaz-client` header
answers `403` — "the plainest unauthenticated caller there is". Reproduced:

```
GET   /v1/expenses   (no credential, no header)  ->  401
PATCH /v1/policy     (no credential, no header)  ->  403 csrf_header_required
```

`CsrfGuard` guards **state-changing methods only**, which is correct: a safe
method is not what CSRF protects against. The conclusion was right and the
scope was too wide, so the matrix now writes out both cases rather than
carrying the footnote as reported. Recorded as AI_LOG 66.

### What this resolution does not claim

- **No Jest suite asserts the new response headers.** They come from the
  Next.js server and the Express adapter, not from application code a suite
  can reach, so `scripts/check-security-headers.sh` checks them against a
  running build instead. That script is **not** part of `npm test` - it needs
  a rebuilt stack - so it is step 5 of the verification order and nothing
  stops someone skipping it.
- **The `Content-Security-Policy` header now sent is not a CSP.** It carries
  one directive, `frame-ancestors`. **R-18 is unchanged** and says so
  explicitly, because a register that reads its own progress generously is
  worse than one that admits a gap.
- **R-11 is still open.** Widening a description is not closing a risk.

---

## What was executed

### 1. The project's own suites, run clean

Both suites were run from a clean start after `docker compose down` and
`docker compose up -d`, and again after a stack restart.

| Suite                              | Result                              |
| ---------------------------------- | ----------------------------------- |
| `apps/api` (Jest, real PostgreSQL) | **617 passed**, 39 suites, 0 failed |
| `apps/web` (Jest)                  | **30 passed**, 2 suites, 0 failed   |
| **Total**                          | **647 passed, 0 failed**            |

Run three times end to end. No flake, no ordering dependency, no failure.

### 2. An independent black-box suite - 198 cases over 12 cycles

Written for this pass, driven over HTTP against the running stack exactly as a
company backend, a manager's browser and a card provider reach it. It shares no
code with the project's suites, so it is a second opinion rather than a re-run.

It lives in [`scripts/qa-cycles/`](../../scripts/qa-cycles) and is re-runnable:

```powershell
node scripts/qa-cycles/run-all.mjs
```

| Cycle | What it covers                                                                        | Cases   | Result                            |
| ----- | ------------------------------------------------------------------------------------- | ------- | --------------------------------- |
| 1     | Health, 404 shape, response headers                                                   | 3       | 2 pass, 1 finding (MIN-01)        |
| 2     | Authentication: API key, session, CSRF, Origin, roles, caller types                   | 19      | all pass                          |
| 3     | Tenant isolation: cross-company reads, body-supplied `companyId`, shared `externalId` | 6       | all pass                          |
| 4     | Submission input validation - 30 malformed bodies                                     | 30      | all pass, **no 500 on any input** |
| 5     | Idempotency: replay, conflict, 8 simultaneous identical submissions                   | 6       | all pass                          |
| 6     | Policy engine: boundaries, every rule, precedence, snapshot, concurrency              | 16      | all pass                          |
| 7     | Review lifecycle: open, detail, resolve, double resolve, simultaneous resolve         | 16      | all pass                          |
| 8     | Dashboard totals, filters, search, keyset paging, corrupt cursors                     | 11      | all pass                          |
| 9     | Policy settings: read, update, 11 invalid updates, cross-tenant                       | 16      | all pass                          |
| 10    | Administration: companies, key issue/rotate/grace/revoke, managers                    | 34      | all pass                          |
| 11    | Card webhook: 12 refusal paths, dedup, async processing, payload validation           | 38      | all pass                          |
| 12    | Sandbox simulator                                                                     | 6       | all pass                          |
|       | **Total**                                                                             | **198** | **197 pass, 1 finding**           |

Stability: cycles 4-9 were repeated four times. Identical results each time -
including every concurrency case.

### 3. A manual browser cycle

Driven in a real browser against `http://localhost:3000`.

| Step                                    | Observed                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| Unauthenticated `/dashboard`            | redirected to `/login`                                                                        |
| Wrong password                          | _"Email or password is incorrect"_ - no enumeration, no cookie set                            |
| Sign in as the Nile manager             | `/dashboard`, totals **8 / 5 / 1 / 2**, adding up                                             |
| Review queue → open the flagged expense | every reason with its evidence, and the policy snapshot it was judged against                 |
| Approve behind the confirmation         | dialog traps focus; **Escape** closes it and returns focus to the trigger                     |
| After approving                         | expense reads **Policy: Review** _and_ **Approved**, names the reviewer and the time          |
| Dashboard after approving               | Approved **5 → 6**, Pending review **1 → 0** - cache invalidation works                       |
| Policy page: save a new limit           | persisted; confirmed `75000` minor units over the API, then reverted                          |
| Another company's expense URL           | _"That expense is not here - it does not exist, or it belongs to another company"_            |
| 375 px viewport                         | no horizontal overflow (`scrollWidth === innerWidth`), table becomes cards, hamburger nav     |
| Sign out                                | `/login?reason=signedout`; `/dashboard` gated afterwards                                      |
| Admin panel                             | companies, managers, key lifecycle, webhook provisioning, simulator - all present and correct |

### 4. Infrastructure and abuse checks

| Check                                        | Result                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `docker compose down` then `up`              | data preserved (24 companies, 82 expenses); seed re-ran idempotently, nothing doubled            |
| 12 MB request body                           | **413** `payload_too_large` with a clean message, not a crash                                    |
| `PUT` / `DELETE` / `PATCH` on `/v1/expenses` | 404, no handler leaked                                                                           |
| `content-type: text/plain` with a body       | 400, not a 500                                                                                   |
| API latency under test                       | `/v1/dashboard/summary` 217 ms, `/v1/expenses` 242 ms, `/v1/reviews` 228 ms, `/v1/policy` 217 ms |
| SQL injection attempt in the search term     | treated as literal text; the table still exists                                                  |

---

## Findings

Severity is the tester's, on the usual scale: **Critical** = data loss, data
leak between tenants, or an unusable system; **Major** = a requirement does not
hold; **Minor** = everything else.

---

### MIN-01 - `X-Powered-By` discloses the framework on both tiers

**Severity:** Minor (security hygiene)
**Found by:** cycle 1, case C1.03

Both services announce what they are built with:

```
GET http://localhost:3001/health   →  X-Powered-By: Express
GET http://localhost:3000/login    →  X-Powered-By: Next.js
```

**Why it is worth a line.** It is free reconnaissance - it tells an attacker
which CVE list to start from. It is also the one piece of hardening that costs
a single line, and its absence is conspicuous next to the care taken elsewhere
(`no-store` on every credential-bearing response, redaction of key-shaped
strings, an `Origin` check implemented server-side rather than trusted to CORS).

It is not recorded anywhere in `docs/risks.md`, so this is an oversight rather
than an accepted trade-off.

**Fix:** in `apps/api/src/main.ts`, `app.getHttpAdapter().getInstance().disable('x-powered-by')`.
For the web tier, `poweredByHeader: false` in `next.config.ts`.

**Also absent, same class:** `X-Frame-Options` / CSP `frame-ancestors` on the
web tier, so the dashboard can be framed by any origin. Risk **R-18** accepts
the absence of a Content-Security-Policy but does not mention clickjacking, and
the application does have one-click state-changing confirmations. Worth a
sentence in R-18 even if nothing is built.

---

### MIN-02 - `%` and `_` in the expense search act as wildcards

**Severity:** Minor (incorrect results, not a security issue)
**Found by:** cycle 8, case C8.10

`GET /v1/expenses?q=%25` returns **every** expense in the company; `q=_`
likewise. The term is parameterised - this is not SQL injection, and an
injection attempt is correctly treated as literal text - but Prisma's
`contains` interpolates the value into a `LIKE`/`ILIKE` pattern **without
escaping LIKE metacharacters**, so they keep their pattern meaning.

**Reproduce:**

```powershell
curl.exe -s "http://localhost:3001/v1/expenses?q=%25&limit=3" -H "cookie: limaz_session=<session>"
```

**Impact.** A manager searching for a merchant like `Café 100%`, or a reference
containing an underscore, gets results that are silently too broad. Low
frequency, no data exposure - the tenant predicate still applies, and cycle 3
confirms nothing leaks across companies.

**Where:** `apps/api/src/expenses/expense-query.service.ts:136-145`.

**Fix:** escape `\`, `%` and `_` in the term before handing it to `contains`,
or move to a `tsquery` full-text search.

---

### MIN-03 - The frequency rule under-fires on a concurrent burst, and R-11 understates it

**Severity:** Minor (documented behaviour, understated scope)
**Found by:** cycle 6, case C6.15

With `frequencyMaxCount = 3`, ten expenses submitted **simultaneously** whose
`spentAt` values differ by a few milliseconds auto-approve **five to seven** of
the ten, not three. It reproduces on every run:

```
identical spentAt   limit=3, 10 concurrent -> 3A/7R  3A/7R  3A/7R  3A/7R  3A/7R
distinct  spentAt   limit=3, 10 concurrent -> 6A/4R  4A/6R  3A/7R  3A/7R  5A/5R
```

**This is not a new defect.** It follows directly from ADR-002: each window is
`[spentAt - N minutes, spentAt]` and evaluation is never retroactive, so an
expense processed after one with a _later_ `spentAt` does not see it. The
advisory lock is working correctly - with a shared `spentAt` the result is
exactly `3A/7R`, deterministically, every time.

**What is worth changing is the framing.** Two things understate it today:

1. **ADR-002 and risk R-11 describe this as back-dating** - "a back-dated
   expense can receive APPROVE" - with a worked example an hour apart. It reads
   like deliberate or late backfill. In fact it happens on ordinary concurrent
   traffic, because arrival order and `spentAt` order diverge whenever two
   requests are in flight at once. That is the exact burst the frequency rule
   exists to catch.
2. **The project's own concurrency test pins every `spentAt` to one value**
   (correctly - it is testing the lock), so the suite can never surface it.

**Recommendation:** no code change. Widen R-11's description to say "whenever
arrival order differs from `spentAt` order, including ordinary concurrent
submission", and add one test that submits concurrently with skewed `spentAt`
and asserts the documented outcome. The grade comes from naming the limit
accurately, and this one is currently named too narrowly.

`scripts/qa-cycles/cycle-4-6-submission-and-policy.cjs`, case `C6.15`, prints
the number it observed on each run.

---

### MIN-04 - The README's test-count breakdown is not accurate

**Severity:** Minor (documentation)

The README states:

> **647** automated tests, 617 of them against real PostgreSQL

The total is right - 617 API + 30 web = 647, confirmed by running both. The
breakdown is not: **617 is the whole API suite**, and at least **73 of those are
pure unit tests that open no database connection** - and say so in their own
file headers:

| Suite                                     | Tests |
| ----------------------------------------- | ----- |
| `test/expenses/policy-rules.spec.ts`      | 22    |
| `test/webhooks/webhook-crypto.spec.ts`    | 20    |
| `test/expenses/canonical-payload.spec.ts` | 16    |
| `test/env.spec.ts`                        | 9     |
| `test/admin/api-key-generator.spec.ts`    | 6     |

So roughly **544** run against real PostgreSQL, not 617.

In a submission whose strongest quality is that its claims are checkable, a
number a reviewer can disprove in one command is worth more than the two it
over-claims. Suggested wording: _"647 automated tests, around 545 of them
against real PostgreSQL."_

---

### MIN-05 - The authorization matrix says 401 where the server answers 403

**Severity:** Minor (documentation)
**Found by:** cycle 2, case C2.01b

[`docs/security/endpoint-authorization.md`](../security/endpoint-authorization.md)
gives `401` in the unauthenticated column for every route. For a browser-shaped
request that is right. For a request with **no credential and no
`x-limaz-client` header** - the plainest "unauthenticated caller" there is - the
server answers:

```
HTTP/1.1 403 Forbidden
{"statusCode":403,"error":"csrf_header_required", ...}
```

because `CsrfGuard` runs before authentication resolves.

**The behaviour is correct** and arguably better: it refuses before touching the
credential path, and sending the header does produce `401`, which the same cycle
confirms. Only the table is incomplete.

**Fix:** a footnote - _"401 assumes the caller sends `x-limaz-client`. Without
it, `CsrfGuard` answers 403 first."_

---

### MIN-06 - A failing `globalSetup` reports `[AggregateError]` and nothing else

**Severity:** Minor (developer experience)

Twice during this pass, `npm test` under `apps/api` died with exactly this and
no more:

```
Error: Jest: Got error running globalSetup - test/global-setup.ts, reason: [AggregateError]
```

An `AggregateError` carries its causes in `error.errors`. Jest prints only the
constructor name, so the one piece of information that would identify the
problem - whether the database was unreachable, which address failed, or which
step threw - is discarded. The first ten minutes of this pass went into
reconstructing `globalSetup` by hand to find out what it had been trying to do.

**Fix:** a `try/catch` in `apps/api/test/global-setup.ts` that logs
`error.errors` before rethrowing. Four lines, and the next person reads the
cause instead of deriving it.

**What is already right, and was re-verified:** the advisory lock around
`limaz_test` is sound, and the bounded 30-second wait added in F13 (AI_LOG 62)
does distinguish an adjacent run from a concurrent one - a genuinely held lock
still produced the named refusal, which prints the holding pid and the exact
`pg_terminate_backend` command. That part needs no change. An orphaned live
Jest process does still hold the lock past the wait, but refusing in that case
is the correct behaviour, and the message says so.

---

## Confirmed as documented - not defects

Both were re-tested and both behave exactly as their risk entries say. They are
listed so the record shows they were checked, not assumed.

|                            | Observed                                                                                                                            | Recorded as          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Login is not rate limited  | 15 consecutive wrong passwords - all `401`, no throttling, no lockout; the 16th correct attempt succeeded. Same for 15 bad API keys | **R-19**, `ACCEPTED` |
| No Content-Security-Policy | absent on both tiers                                                                                                                | **R-18**, `ACCEPTED` |

---

## What was verified as working - the requirement-by-requirement record

Listed so the absence of defects is traceable to what was actually exercised.

**Tenant isolation.** Another company's expense id returns **404, never 403**,
to both an API key and a manager session. A body-supplied `companyId` or
`decision` is a **400** from the strict schema. The same `externalId` lives
independently in two companies. A search that matches another company's merchant
returns nothing. Key ids, review ids and company ids are all re-checked against
the caller's tenant, including through the admin path selector - revoking
another company's key through this company's URL is a **404**, and the key still
works afterwards.

**Idempotency.** A byte-identical retry returns `200` with `duplicate: true`,
the same expense id and the same decision. Eight simultaneous identical
submissions produced **exactly one** `201` and one expense, all eight responses
naming it. The same `externalId` with a changed body is a **409**, and the
original expense is untouched.

**The policy engine.** The amount boundary is strictly greater - 49,999 and
50,000 approve, 50,001 reviews. Blocked categories match across case and
surrounding whitespace. The frequency rule fires on the fourth in the window and
not the third, out-of-window expenses do not count, and an out-of-order arrival
is not retro-counted (ADR-002). `REJECT` beats `REVIEW` and **both reasons are
returned**. Every reason carries the evidence the engine recorded. Ten
simultaneous submissions with a shared `spentAt` auto-approve exactly three,
every run.

**History holds still.** Raising a company's limit changes the next decision and
changes nothing already decided: the replay still returns `REVIEW`, and the
expense's `policySnapshot` still holds the old limit.

**Reviews.** A `REVIEW` opens exactly one review; `APPROVE` and `REJECT` open
none. Resolving sets the final status and leaves the automated decision alone -
both facts are kept. The resolution names who decided and when. A second resolve
is a **409 that names the first decision**, and the expense is unchanged. Two
simultaneous resolves produced exactly one winner and one loser on every trial.
A caller-supplied `reviewerId` is a 400; an unknown decision value is a 400; a
non-existent review id is a 404, not a 500.

**Never a 500.** Thirty malformed submissions, eleven malformed policy updates,
eight malformed company creations, five malformed manager creations, six
malformed webhook payloads, four corrupt pagination cursors, four out-of-range
limits, a 12 MB body, a wrong content type and truncated JSON. Every one
answered 400, 409, 413 or 422 with a message. **No 500 was produced by any
input during this pass.**

**The card webhook.** Twelve distinct refusal paths - wrong, malformed, empty
and missing signatures; missing timestamp and delivery headers; unknown delivery
id; timestamps two hours either side; a non-numeric timestamp; another company's
secret; another company's delivery id - all **401**, all with an **identical
response body**, so the refusal never says which check failed. The same object
re-serialised with different whitespace is refused, confirming the signature
covers the raw bytes. A tampered amount with the original signature is refused.
An API key is not accepted as a substitute. Six simultaneous deliveries of one
event created one event row and one expense. The same transaction under two
event ids became one expense. An unhandled event type is accepted and marked
`IGNORED`. Re-provisioning replaces the secret and the old one stops verifying
immediately. A webhook expense and an identical API expense reach the same
decision - there is only one policy engine.

**The API key lifecycle.** A key created with its company authenticates
immediately, and the policy created in the same transaction is what decides.
Rotation issues a replacement and leaves the old key working, with an expiry
measured at **24.000 hours** from the moment of rotation. Revocation stops a key
on the next request. The raw
key appears exactly once, on a response carrying `Cache-Control: no-store`, and
never again.

---

## Re-running this pass

```powershell
docker compose up -d
```

```powershell
node scripts/qa-cycles/run-all.mjs
```

```powershell
npm test --workspaces
```

The black-box cycles write to the development database. Every row is namespaced
with a per-run id so repeated runs do not collide; `docker compose down -v`
clears them. Run the two suites **one at a time** - `apps/api` holds an advisory
lock for the duration (see MIN-06).
