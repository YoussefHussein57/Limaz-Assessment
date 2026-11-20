# AI usage log

Everything in this repository is mine and I can explain why each part is there.
This file records how AI was used to get there, and - more usefully - where it
was wrong.

## Tools

| Tool | Used for |
|---|---|
| **Claude Code** (Claude Opus 5) | The main pairing tool. Architecture discussion, ADR drafting, implementation, test authoring, debugging |

## How I worked

I did not ask for the project to be generated. The working agreement was:

1. Explain the problem and the options **before** writing code.
2. One feature at a time, with an explicit scope boundary.
3. Nothing is marked done without executed evidence.
4. I approve each feature before the next one begins.

Concretely, that meant the first several hours produced no code at all: the
assessment was read, the requirements extracted into a traceability table, the
eight design questions answered as ADRs, and a risk register created. Code
started only after I approved that.

## Main prompts

Summarised rather than pasted verbatim.

| Phase | What I asked for |
|---|---|
| Kickoff | Read the assessment, extract every requirement, identify what it leaves ambiguous, and propose an architecture. Do not write code yet |
| Review | Challenge the proposal: analyse out-of-order expense submissions for the frequency rule; prove the review-resolution transaction boundary; correct the API key lookup complexity claim; separate the idempotency guarantee from the frequency guarantee; expand the session design to cover CSRF and same-origin deployment |
| Scope control | Justify each stack deviation by implementation effort, maintainability and assessment value. Why reduce shadcn/ui, why skip React Hook Form, why defer Playwright |
| F00 planning | Produce a final implementation plan with exact files, Docker design, ports, health-check behaviour, verification steps and explicit exclusions. Wait for approval |
| F00 implementation | Implement only F00. Run the tests. Show actual results. Do not commit |
| F01 design review | Verify F00 rather than assume it. Then: which tables and why, which relationships, which constraints protect which invariant, and **consider whether composite foreign keys are necessary**. Design only - no code until approved |
| F01 implementation | Implement the approved schema, migration, seed and tests. Real PostgreSQL. Show executed results |
| F02 design review | Verify F00 and F01 first. Then compare API keys against sessions, password hashing against token hashing, database sessions against JWT, guards against middleware, explicit tenant scoping against row-level security, role against resource authorization, and HttpOnly against localStorage. Diagrams. No code until approved |
| F02 implementation | Implement the approved design. Fix the seed security finding first. Real PostgreSQL. Do not commit |

I also set two standing rules: explain in Egyptian Arabic in the conversation
rather than pointing me at a markdown file, and never add AI co-author trailers
to commits.

## Where the AI was wrong, and how I caught it

### 1. It claimed a PostgreSQL unique index gives O(1) lookup

While drafting the API key ADR, the explanation said that storing a SHA-256
hash in a `UNIQUE` column gives an **O(1)** lookup, versus O(n) for bcrypt.

**How I noticed:** the O(n) half was obviously right - bcrypt salts per row, so
you cannot index it - but O(1) is a hash-table property. PostgreSQL backs a
`UNIQUE` constraint with a **B-tree**, so equality lookup is **O(log n)**.

**Fix:** corrected to O(log n), with the practical note that it is three or four
page accesses usually served from `shared_buffers`. The argument against bcrypt
did not depend on the wrong number - the real point is that bcrypt is not
indexable at all - but the number would have been repeated in an interview.

**Verified by:** reasoning about the data structure. Recorded in
[ADR-006](docs/adr/ADR-006-api-key-storage-rotation.md).

### 2. It wrote a `.dockerignore` that leaked `.env` into an image layer

The first `.dockerignore` listed `.env` and `.env.*`. Those patterns match only
at the **context root**. `apps/api/.env` was not matched, so `COPY apps/api
apps/api` copied a file containing the database password into an image layer.

**How I noticed:** not by reading the file. While debugging a different failure
I listed the contents of the build-stage image and saw `.env` sitting there.

**Fix:** added `**/.env` and `**/.env.*`. A test, **F00-T12**, now runs a shell
inside the built image and asserts no `.env` is present.

**Verified by:** F00-T12 passing, and failing before the fix.

### 3. A build that exited 0 and produced nothing

`nest-cli.json` had `deleteOutDir: true` and the build tsconfig had
`incremental: true`. `dist/` was deleted, then `tsc` read
`tsconfig.build.tsbuildinfo`, decided nothing had changed, and emitted nothing -
**while exiting 0**. Both the Docker image and my local build were empty.

**How I noticed:** the Docker build failed on `COPY /app/apps/api/dist: not
found`. Running `npm run build` locally also exited 0, and `dist/` still did not
exist.

**Fix:** `incremental: false` in `tsconfig.build.json`, plus `**/*.tsbuildinfo`
in `.dockerignore` so stale caches never enter the build context.

**The wider lesson, which changed how the suite is written:** the original test
asserted that `npm run build` exits 0. That test passed throughout. Tests
F00-T11 and F00-T11b now assert that `dist/main.js` and `.next` **exist**. An
exit code is not evidence of output.

### 4. A security fix revealed a bug the leak had been hiding

Immediately after fixing the `.env` leak, the Docker build started failing with
`PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL`.

The build had never worked on its own merits. The leaked `.env` had been
silently supplying `DATABASE_URL` to `prisma generate`. Removing the leak
exposed a real bug: Prisma 7's `env()` helper resolves eagerly at config load,
so an image build - which correctly carries no database credentials - could not
load the config at all.

**Fix:** `prisma.config.ts` attaches the datasource only when `DATABASE_URL` is
present. `prisma generate` needs no connection; the commands that do need one
run where the variable is always set.

**Why I am recording this one:** it is the most interesting failure of the
feature. The security hole was load-bearing. If I had only fixed the leak and
not rebuilt from a clean context, I would have shipped a broken image.

### 5. It proposed `rewrites()` for the same-origin proxy

The plan used a Next.js `rewrites()` rule to proxy `/api/*` to the API. Next
resolves `rewrites()` at **build** time and freezes the destination into
`.next/routes-manifest.json`. The image builds without `INTERNAL_API_URL`, so
the destination was baked as `http://localhost:3001` - which inside the web
container is the web container itself. Every proxied request returned `500`.

**How I noticed:** test F00-T05 failed. I then read
`.next/routes-manifest.json` inside the running container and saw the baked
destination.

**Fix:** a runtime route handler at `app/api/[...path]/route.ts`, which reads
the environment per request. It is also the better long-term answer, because it
is where cookie forwarding will live in F02 - including using
`getSetCookie()` rather than `headers.get('set-cookie')`, which collapses
multiple cookies into one malformed string.

**Verified by:** F00-T05 and F00-T05b passing.

### 6. It initially proposed the newest version of everything

The first dependency list took `latest` for every package. Checking the
published `peerDependencies` showed that combination does not work:

- `typescript-eslint@8.73.0` supports `typescript >=4.8.4 <6.1.0`
- `ts-jest@29.4.15` supports `typescript <7`
- TypeScript 7.0.2 is outside both
- `@nestjs/core@12` is ESM-only, and Jest needs Node 24.9+ to load ESM-only
  packages. On Node 22 the application ran fine but two test suites could not
  load at all
- `prisma@8.0.0-rc.34` is a release candidate

**How I noticed:** I asked it to verify versions against published metadata
before installing anything, rather than trusting `latest`. The NestJS problem
only surfaced when the test suite actually ran.

**Fix:** versions chosen from `peerDependencies` and `engines`. One TypeScript
version (5.9.3) across build, typecheck, lint and test. NestJS held at 11.
Recorded in [ADR-010](docs/adr/ADR-010-nestjs-11-toolchain.md), with the
rejected options and why.

### 7. It proposed denormalising the tenant onto `reviews` without saying what protects it

The first design added `Review.companyId` so the tenant guard and the
concurrency guard could share one `WHERE` clause - which is right, and is what
ADR-004 needs. What it did not address is the obvious consequence: a
denormalised column can drift.

**How I noticed:** I asked directly whether composite foreign keys were
necessary. The honest answer turned out to be yes, and it is not a detail -
the review-resolution guard *reads* `reviews.company_id`, so a drifted value
would make the guard itself approve a cross-tenant resolve.

**Fix:** `UNIQUE (id, companyId)` on `expenses` plus a composite foreign key
from `reviews(expenseId, companyId)`. PostgreSQL now rejects a review whose
tenant does not match its expense, on insert and on update.

**Verified by:** F01-T09 and F01-T09b, and - more importantly - a negative
control. I dropped the constraint and retried the same insert:

```
RESULT: cross-tenant review ACCEPTED  ->  review.companyId = 5851387a-...
        expense.companyId             = 7d2a27c1-...
```

It was accepted. That is what proves the test is testing the constraint rather
than passing for an unrelated reason. Recorded in ADR-011.

### 8. Tests that corrupted each other and still looked like a schema bug

The first full F01 run failed with `companies: expected 2, received 4`. The
obvious reading is that the seed is not idempotent.

**How I noticed:** the numbers were wrong in a specific way - everything was
inflated by roughly the amount the *constraints* suite creates. Jest runs test
files in parallel workers, and both suites were using the same database.

**Fix:** `maxWorkers: 1`, with the reason written into `jest.config.js` so
nobody re-enables parallelism for speed without reading it. It does not limit
concurrency *inside* a test, which is what F03 and F04 will need.

**Why I am recording it:** the failure pointed at the seed and the cause was
the test harness. Believing the first reading would have meant rewriting
working code.

### 9. Prisma hides the database error the tests needed

The constraint tests could not read a SQLSTATE from rejections. Prisma
translates driver errors into its own codes - `P2002` unique, `P2003` foreign
key, and `P2039` for everything else **including CHECK violations**, which is
too coarse to distinguish a CHECK violation from an unrelated database error.

**How I noticed:** my assertion helper failed with "no PostgreSQL error code
could be read from it". Rather than guessing at the shape, I wrote a throwaway
script that triggered one of each violation and printed the whole error
object.

**Fix:** read `meta.driverAdapterError.cause.originalCode`, which the driver
adapter preserves. The same object carries the **constraint name**, so every
constraint test now asserts *which* constraint rejected the write - a much
stronger statement than "something did".

### 10. A Dockerfile that would have failed on first start

`prisma.config.ts` was not copied into the runtime image. In Prisma 7 that
file is where the CLI reads the connection string, so `prisma migrate deploy`
in the container entrypoint would have failed on every `docker compose up`.

**How I noticed:** reading the Dockerfile against the new entrypoint behaviour
before rebuilding, rather than after. Confirmed afterwards by F01-T18b.

### 11. A security fix it proposed was right, but for the wrong reason

An automated review flagged the seed for "hardcoded credentials". Taken at face
value that is wrong - the assessment asks for seeded development credentials
and they are documented in the README.

**How I noticed the real problem:** I read what the seed actually does on its
`update` path rather than only on `create`. It rewrites each user's password
back to the published one and sets every API key back to `ACTIVE`. Combined
with an entrypoint that seeded on **every** container start, that makes the
seed a privilege-restoration mechanism: revoke a leaked key, restart, and it
is live again.

**Fix:** two independent gates - `SEED_DEV_DATA=true` in the entrypoint, and a
`NODE_ENV=production` refusal inside the seed script itself. The overwrite
behaviour was deliberately kept, because restoring a known state is what a
development seed is for. The defect was the missing gate.

**Why I am recording it:** the finding's headline was a false positive and its
substance was a critical bug. Dismissing it on the headline - which was the
obvious move - would have shipped the bug.

**Verified by:** F02-T21, F02-T21b. Risk R-21.

### 12. A test that reported the intended behaviour as a leak

F02-T24 searched the API logs for the seeded password and found it - inside
the seed's own startup banner, which prints the development credentials on
purpose so a reviewer can sign in.

**How I noticed:** the companion check, F02-T24b, passed at the same time,
asserting that the banner was present. Both cannot be right.

**The tempting fix was to loosen the assertion.** Instead I made it more
precise: exclude the seed's own output block, then assert on everything else,
and add F02-T24c, which performs a real login and a real API key request and
re-reads the logs afterwards. The narrower test catches **more**, not less.

### 13. Lost backslashes silently blanked an entire log filter

The first version of that exclusion used `awk '/\[entrypoint\] seeding/'`. The
backslashes did not survive the shell plumbing, leaving `/[entrypoint]/` -
which in awk is a **character class** matching any one of those letters. Nearly
every line matched, the filter emptied the log, and both log tests then passed
by having nothing left to search.

**How I noticed:** counting. A filter that drops 64 of 64 lines is not
filtering, it is deleting. I checked the counts instead of trusting the PASS.

**Fix:** `index($0, "literal string")` rather than a regex, which removes the
escaping question entirely. Verified by a direct count: 64 in, 39 kept, 25
dropped, the startup line retained and the banner gone.

**This is the second time lost backslashes produced a silently wrong result**
here - F00 defect D-2 was the first, where a stale `tsbuildinfo` made a build
exit 0 while emitting nothing. The lesson applied both times: assert on the
artefact, not on the exit status.

### 14. A redaction "fix" I accepted broke the thing it was fixing

An automated review found that the credential redactor missed a password in a
comma-separated list of connection strings. The proposed fix was to treat `,`
and `;` as characters that end the userinfo part of a URL. It worked on the
reported input, so I nearly took it.

`,` and `;` are RFC 3986 **sub-delimiters** - legal, unencoded, inside a
password. Adding them as terminators meant `postgresql://u:pa,ss@host/db`
redacted `pa` and emitted `ss` in the log. The fix for a missed password
created a leaked password.

**How I noticed:** I ran the proposed version against a password containing a
comma before accepting it, because the change touched the definition of where
a credential ends, and that definition is the whole mechanism.

**Fix:** stop guessing where the credential ends from punctuation, and bound
each URL by where the **next scheme name** begins - collecting every `://`
first, then walking backwards over the scheme characters. The terminator set
now contains only characters RFC 3986 actually forbids in userinfo.

**What I then wrote down rather than kept fixing:** two inputs this still
misses - a raw `/` and a raw quote inside a password, both of which must be
percent-encoded, and scanning past either mangles ordinary URLs and
structured logs. They are documented as KNOWN LIMITS in the file itself, with
a header stating that this is a **backstop, not a guarantee**. The protection
that matters is structural: credentials are not put into log messages.

A sixth review finding arrived afterwards. I measured it across 200 padding
values, could not reproduce it, and did not change the code for it.

### 15. `'use client'` on a component that did not need it broke the build

I marked `sidebar-nav.tsx` as a client component out of habit - it uses
`usePathname`. That made it a **server/client boundary**, and a boundary
cannot receive a function prop, so the `onNavigate` callback the drawer passes
it was rejected.

The directive was unnecessary: the file is only ever imported by components
that are already client components, so it is already on the client. Removing
it fixed the build and removed a boundary that was never meant to exist.

**The lesson:** `'use client'` is not "this code uses hooks". It marks where
the boundary *is*, and marking one in the middle of a client tree creates a
constraint with no benefit.

### 16. A split that only showed up at build time

`lib/auth.ts` imports `next/headers`, which exists only on the server. The
login form imported a single pure function, `homePathFor`, from it - and that
import pulls the whole module into the browser bundle. The build failed.

Nothing in the editor flagged it; the type-check passed. The boundary is a
bundler rule, not a type rule.

**Fix:** split the module along the real line - `auth-shared.ts` for types and
pure helpers, `auth.ts` for anything touching `cookies()`. The architecture
document now states the rule in one line: *a client component imports from
`auth-shared`, always.*

### 17. My own browser check was wrong, and said the sidebar was hidden

Verifying the responsive layout, I asserted the sidebar was visible with
`offsetParent !== null`. It reported hidden at every width. The obvious
conclusion was a broken breakpoint.

`offsetParent` is `null` for **any** `position: fixed` element, which the
sidebar is. The check was measuring the wrong property, not finding a bug.
Re-measured with `getComputedStyle(el).display`, it is `flex` from 1024px
upward.

**The lesson is the one that keeps repeating here:** a failing check is a
claim about the check as much as about the code. This one would have had me
"fix" a layout that was already correct.

### 18. A failing test that was right about the problem and wrong about the place

The F02.1 acceptance run reported one failure: with the API stopped, the login
page did not say *"Service unavailable"*. The page clearly contains that
branch, so the first instinct was to call the check broken and relax it.

The check was requesting `/login` **without a cookie**, and `getCurrentUser()`
returns early in that case - no cookie, nothing to verify, no round trip. So
nothing probed the API and nothing threw. That early return is correct;
probing on every anonymous page view to detect a rare condition is a cost on
the common path.

But following it through found a real defect behind it. A visitor with no
cookie only learns the API is down **on submit**, and there the proxy's `502`
fell into the generic branch - *"Something went wrong signing you in. Please
try again."* That is precisely the retry loop the code's own comment says it
exists to prevent, and it reads like the password was wrong.

**Fix in the product, not the assertion:** `502`, `503` and `504` now say the
server could not be reached. The check was then split into the two visitors
that actually exist - one holding a session (the page explains), one with no
cookie (the form renders, and submitting returns a distinguishable `502`) -
plus a third asserting the gateway error does not echo the internal address.

**The lesson:** relaxing an assertion to make a suite green is how a real
defect gets written down as a test bug. The honest move was to ask why the
code and the check disagreed, and both had something to say.

### 19. A date that does not exist passed validation

The DTO accepted `2026-02-30T09:15:00Z`. The regex matched, `Date.parse`
returned a finite number, and the test expecting a 400 failed.

`Date.parse` does not reject 30 February. February 2026 has 28 days, so it
**rolls the surplus over** and returns **2 March** - two days past the end of
the month. The expense would have been stored on a date the caller never
wrote, in a different frequency window, with nothing anywhere recording that a
substitution had happened.

There is no meaningful number of days to quote here, because 30 February does
not exist. The defect is not that the date moved by some amount; it is that
the stored date is not the submitted one, and the rollover distance changes
with the month and the year.

**How I noticed:** the test was written from the requirement list before the
code, so the failure arrived as a question rather than as a discovery after
shipping.

**Fix:** check the calendar fields taken from the string itself, not the
parsed result. Against the string rather than the parsed UTC date, because an
offset legitimately moves the UTC day - `2026-11-20T01:00:00+03:00` really is
19 November in UTC.

### 20. The advisory lock hid the mechanism the tests were supposed to prove

The concurrency suite was going to be "five identical requests, assert one
row". It passes. It also passes **with the unique index dropped entirely**,
which I only realised when designing the negative control.

The advisory lock is keyed on `(companyId, employeeId)`. Five identical
requests share that key, so they serialise; the second finds the first's
committed row at the idempotency read and returns 200. The INSERT is never
attempted, so the index is never consulted.

The index only decides when two requests share an `externalId` and take
**different** lock keys - a different `employeeId`. That shape is the one
worth testing, and it is the one the negative control uses.

**The lesson:** "the test passes" and "the test exercises the mechanism" are
different claims. The only way I found the gap was asking what would happen if
I removed the thing I was claiming to verify.

### 21. The constraint I tried to drop was not a constraint

The negative control said `ALTER TABLE "expenses" DROP CONSTRAINT
"expenses_companyId_externalId_key"` and failed with `42704 does not exist` -
on a name the F01 tests already assert against.

Prisma's `@@unique` emits `CREATE UNIQUE INDEX`, not `ALTER TABLE ... ADD
CONSTRAINT`. The thing enforcing idempotency lives in `pg_indexes` and is
absent from `pg_constraint`. The guarantee and the `23505` it raises are
identical; the DDL to remove it, and the catalogue to verify it in, are not.

**What the fix then exposed, which was better than the original test:**
restoring the index failed too, with `23505 could not create unique index` -
because the duplicate rows the negative control had just created made the
index unbuildable. The damage is not merely detectable afterwards, it
physically blocks the guarantee from being restored. That rejection is now an
explicit assertion rather than a footnote.

### 22. A failing assertion blew up instead of reporting

`expect(evaluator.calls).toHaveLength(2)` failed with
`RangeError: Invalid string length`. The real failure was replaced by a stack
trace about string length.

The test evaluator was recording its whole input, which includes the Prisma
transaction client. When the assertion failed, Jest tried to serialise that
object to print it.

**Fix:** record only the five fields a test actually asserts on. The object
being too big to print was a symptom; keeping a database client inside test
observation state was the actual mistake.

### 23. A hang that was not in the code under test

The negative-control suite took 254 seconds and then hung. I had killed an
earlier run, which left two connections attached to `limaz_test`, and
`globalSetup` drops and recreates that database on every run - `DROP DATABASE`
waits indefinitely while a connection is attached.

**How I found it:** `pg_stat_activity` showed two idle connections and nothing
blocked, which ruled out a deadlock in the feature and pointed at setup rather
than at the tests.

**Fix:** terminate the stale backends. After that the same suite ran in 4.7
seconds. I also stopped piping test output into `tail`, which buffers until
the command finishes and had been hiding every interim line.

**The lesson worth keeping:** a slow or hanging test is a claim about the
environment as much as about the code, and I nearly started optimising a
transaction that was never slow.

### 24. A barrier that would have deadlocked the test it was written for

F03's concurrency barrier lives inside the evaluator, which runs **after** the
advisory lock. Every F03 test that used it contended on different lock keys,
so it worked, and I had written the limitation into the code: *"it cannot be
used for requests that share a lock key."*

F04's central test is five requests for the **same** employee - the same lock
key. Reusing the barrier would have hung every run until the timeout, and the
cause would have looked like a database problem rather than a test-design one.

**How I noticed:** the project owner flagged it in the F04 requirements before
I wrote the test. I had written the warning in F03 and would plausibly have
walked into it anyway, because the barrier was right there and had worked
five times.

**Fix:** a test-only interceptor that holds each request **before** the
controller, so before the transaction and before the lock. All five are
genuinely in flight, then race for the lock as real clients would.

### 25. A pre-lock barrier proves overlap, not agreement

The first negative control released five requests together with the lock
replaced by a no-op, expecting all five to count zero and approve. That is
**not** guaranteed: without serialisation one transaction can still count,
insert and commit before another reaches its count, so the result would be a
mixture that sometimes looks correct. The control would have passed
intermittently and proved nothing - the exact failure mode a negative control
exists to rule out.

**Fix:** a second synchronisation point, after the frequency count and before
the first write, used only when the lock is a no-op. Every competitor must
reach it before any continues, which makes "all five counted zero" determined
rather than likely.

Pairing that second barrier with the real lock deadlocks by construction, so
**F04-NC2 demonstrates that deadlock on purpose**, with a short timeout, so it
is documented rather than waiting for the next person.

### 26. Ordering by a Postgres enum is not alphabetical

A test asserted the three rule hits came back as AMOUNT_LIMIT,
BLOCKED_CATEGORY, FREQUENCY from `ORDER BY "ruleCode"`. They came back
AMOUNT_LIMIT, FREQUENCY, BLOCKED_CATEGORY.

`RuleCode` is a PostgreSQL enum, and ordering by one uses **declaration**
order, not the alphabet. The API response sorts in JavaScript with
`localeCompare` and *is* alphabetical, so the two genuinely differ.

**Fix:** the assertion now records the enum order rather than working around
it, because anything in F06 that sorts in SQL will see that sequence and the
contract promises the other one.

### 27. A manual test run contaminated itself, and the data was innocent

Running the manual cycle, the first expense for an employee came back REVIEW
when it should have been APPROVE. The obvious reading was a frequency bug.

An earlier run of the same script - one whose output formatting had failed -
had still **successfully created four expenses** for the same `emp-freq`. The
second run inherited them.

**How I noticed:** the recorded `countIncludingCurrent` was higher than the
number of expenses the run had created, which only makes sense if rows already
existed.

**Fix:** derive the employee id from a per-run identifier, not just the
external id. The asymmetry is the lesson worth keeping: **a reused
`externalId` is caught immediately by the 409 or the 200; a reused
`employeeId` is silent**, and silently wrong is the dangerous one.

### 28. "The index exists" is not "the index is used"

I was about to document that the composite index guarantees an index scan on
the frequency query. The project owner asked for `EXPLAIN ANALYZE` instead.

On the test database - a few dozen rows - PostgreSQL chooses a **sequential
scan**, and is right to: scanning a tiny table is cheaper than descending an
index. The claim would have been false in exactly the environment the tests
run in.

**What I did instead:** load 4,000 representative rows, `ANALYZE`, and print
the real plan. It is an `Index Only Scan` with all four conditions inside
`Index Cond` and four buffer hits. The test asserts only that the index
appears - not the node type - so a future PostgreSQL choosing an equally
correct plan does not fail the suite.

**The lesson:** an index definition is a statement about what is *possible*,
and only the planner's output is a statement about what *happens*.

### 29. A "concurrent" request that never left the starting line

A test held a row lock in one transaction, dispatched a competing HTTP
request, and polled `pg_blocking_pids()` expecting to see it blocked.
Nothing was ever blocked.

A supertest `Test` object is **lazy**: it does not send its request until
`.then()` is called. `const competitor = resolve(...)` creates it and sends
nothing. Awaiting it at the end of the test dispatched it *then* - long after
the lock had been released.

**What makes this worth recording is the test next to it.** F05-T38 had the
same bug and **passed**: it asserted that a waiting request succeeds once the
first transaction rolls back, and the request did succeed - because it only
started after the rollback. The assertion was true for the wrong reason, and
nothing about the result looked suspicious.

**How I noticed:** only because the neighbouring test had a direct probe of
the database. Without `pg_blocking_pids()` asserting that something really was
blocked, both tests would have gone green and the suite would have claimed to
exercise lock contention it never reached.

**Fix:** `.then((r) => r)` to dispatch eagerly, and F05-T38 now waits for a
blocked backend to appear *before* releasing. The suite also got faster -
30 seconds to 5 - because the requests stopped timing out.

### 30. My own coordination deadlocked the negative control

The lost-update experiment needs two transactions to read before either
writes, then the first to commit before the second writes. I wrote two
rendezvous gates for that. The second one had a default size of 2, and only
one participant ever arrived at it.

The test hung for its full 60-second timeout.

**The irony is the point:** this is a test whose entire subject is one
participant waiting for another, and I deadlocked it on a default argument.
The F04 lesson - barriers must be sized for who can actually reach them - is
the same lesson, in the test harness rather than the database.

**Fix:** `gate(1)` for the single-signal case, stated in the code with the
reason.

### 31. A design justification that a test proved false

The cursor for review listing is a pair, `(createdAt, id)`. I justified that
in the design, in the DTO's header comment and in the feature document, by
saying two reviews created in the same transaction share a `createdAt` -
because the column is declared `DEFAULT CURRENT_TIMESTAMP`, which is the
transaction's start time.

I wrote a test asserting exactly that. Three rows created in one Prisma
transaction came back with **three different timestamps**.

Prisma supplies `@default(now())` values from the client, per row, so the
database default never fires. The claim was wrong.

**The conclusion survived; the reasoning did not.** The real exposure is that
`createdAt` is `Timestamptz(3)` - one millisecond of resolution - so any bulk
insert, import or backfill can produce ties, and the UUIDv7 id is only
*approximately* time-ordered. A composite cursor is still right.

**Fix:** the test now constructs the tie explicitly and proves paging survives
it; the comments in `list-reviews.dto.ts` and the feature document state the
real reason and record that the first one was wrong.

**Why I am recording a case where the code did not change:** a right answer
held up by a wrong argument is fragile. The next person to read that comment
would have believed something false about their database.

## What I decided, not the AI

- Holding NestJS at 11 rather than upgrading Node machine-wide or swapping the
  test runner for Vitest. The AI laid out three options with evidence; the
  trade-off - risk in the test runner versus a framework major - was mine.
- Forward-only frequency evaluation, accepting the back-dated bypass as a
  documented risk rather than building retroactive re-evaluation.
- Keeping the optional webhook bonus entirely out of scope until the mandatory
  features are complete and approved.
- Rejecting React Hook Form, reducing shadcn/ui to only what is used, and
  deferring Playwright - on the grounds that the assessment says everything in
  the repository counts as mine and I will be asked why each part is there.
- Pushing on composite foreign keys during the F01 design review instead of
  accepting "the application writes both in one transaction" as sufficient.
- Accepting `category` as a free string with normalisation (risk R-17) rather
  than an enum, because the category vocabulary belongs to the company.
- Asking what "no CORS" actually protects before accepting it, which is how
  the server-side `Origin` check became a fourth CSRF layer rather than the
  design stopping at three.
- Keeping the seed's overwrite behaviour and gating it, instead of weakening
  what the seed does.
- Stopping work on the credential redactor at a stated point, with the
  declined findings reasoned in writing and the remaining gaps documented in
  the file - rather than chasing review findings on a backstop while three
  core guarantees were still unbuilt.
- Taking two Radix primitives and writing the other seven components by hand,
  on a criterion I can state: a dependency only where the accessible behaviour
  is non-trivial.
- Keeping the expense endpoint out of the deployed application rather than
  shipping a stub decision, accepting that the manual test cycle cannot run
  against the public API until F04.
- Treating identifier normalisation as a correctness question rather than a
  convenience one: rejecting an untrimmed externalId with 400 instead of
  trimming it, because trimming merges two caller identities silently.
- Taking the advisory lock in F03, which does not need it, so the transaction
  order is built once rather than rearranged in F04 under tests that had
  already passed.
- Keeping the policy rules in a file that cannot import Prisma, so the rule
  tests need no database and every boundary is covered rather than sampled.
- Making precedence a rank table rather than evaluation order, so that
  reordering the rules is provably irrelevant instead of accidentally safe.
- Evaluating every rule even after the decision is settled, because the
  decision carries one piece of information and the evaluation carries three.
- Keeping R-11 ACCEPTED rather than claiming the advisory lock addressed it.
  The lock orders concurrent writers; out-of-order evaluation is a different
  problem and conflating them would make the risk register useless.
- Denying the platform admin access to manager review operations rather than
  assuming the role inherits it. Reviewing a company's spending is that
  company's business, and no approved contract granted it.
- Keeping ADR-004's narrow retry exemption instead of a strict single-winner
  rule, and stating plainly that it produces two 200s with one transition -
  rather than quietly redefining what the requirement measures.
- Recording a wrong design justification in this log even though the code was
  already correct, because a right answer held up by a wrong argument is
  fragile for whoever reads it next.
- Refusing to put the seeded credentials on the login page, and refusing to
  put invented figures on the dashboard, even though both make the screenshots
  look better.

---

## Defects found during F06

### 32. A hundred-times money error, in my own mockup

While building the F06 visual proposal I wrote the dashboard's total as
**`SAR 296,500.00`**.

296,500 is the sum of the seeded expenses **in minor units**. The correct
figure is **`SAR 2,965.00`**.

I had printed the raw halalas with a currency label in front of them. Every
individual row on the same mockup was right - `SAR 200.00`, `SAR 1,250.00` -
because I had converted those by hand and simply forgot to convert the total.

**Why it matters more than a mockup typo:** it is exactly the failure the
assessment warns about, it was off by two orders of magnitude, and **it looked
entirely plausible**. Nothing about "SAR 296,500.00" reads as wrong on a
dashboard. If that had shipped, the first person to notice would have been
whoever reconciled the figure against their accounts.

**Fix:** the number was corrected before the proposal was sent, and the defect
became the argument for `lib/format.spec.ts` carrying a real boundary suite
rather than one happy-path assertion - including the top of the int4 range and
a zero-decimal currency.

### 33. Three test assumptions that were simply false

The first run of the F06 backend suite failed six times, and every failure was
my assumption rather than the code's behaviour:

| What I assumed | What is true |
|---|---|
| API keys are sent as `Authorization: Bearer` | They are sent as **`x-api-key`** (F02) |
| The submit DTO field is `amountMinor` | It is **`amount`**, and `.strict()` rejected the body |
| "Casino Royale" appears in both seeded companies | **Only Nile has it** |

The third is the one worth recording. A tenant-scoping test that searches for a
term only one company has would pass **with no tenant predicate at all** - the
other company has nothing to leak. The test would have been green and would
have proved nothing.

**Fix:** the search is now for `beans`, which **both** companies have, and the
test asserts the two result sets are disjoint. The comment in the file records
why the first merchant was the wrong choice.

I also tried to move a row out of a filtered set by updating `decision` alone,
and PostgreSQL refused with `23514` - `expenses_decision_status_check` forbids
`REJECT` with `APPROVED`. That was the constraint doing its job, not a
problem; both columns now change together.

### 34. A review that was opened after it was resolved

Reading the real expense detail page in the browser, `exp-1005` showed:

```
Opened     Nov 20, 2026, 22:19
Resolved   Nov 18, 2026, 13:30
```

Opened two days **after** it was resolved.

The seed sets `resolvedAt` from a fixture but never set `createdAt`, so the
column fell back to its `now()` default - **whenever the container last
started**. Every restart moved it.

**No test caught this**, and no test would have: the suites assert state,
outcome and reviewer, and nothing in F01 through F05 ever displayed the two
timestamps side by side. It took rendering them next to each other on a page.

**Fix:** the seed stamps `createdAt` from the expense's `spentAt` - a review is
opened when its expense is submitted - so the seeded data is now internally
coherent whenever it is run.

### 35. Two strings that were identical on screen and different in memory

The money tests failed with:

```
Expected: "SAR 1,250.00"
Received: "SAR 1,250.00"
```

`Intl.NumberFormat` separates a currency code from its amount with a
**non-breaking space** (U+00A0), so that "SAR" can never wrap away from its
figure.

**The tempting fix was the wrong one.** Replacing it with an ordinary space in
`formatMoney` would have made the tests pass and made the typography worse -
`SAR` could then wrap to the end of a line with its number on the next.

**Fix:** the tests build their expected strings through a helper that inserts
U+00A0, and one test asserts the non-breaking space **is** present - so the
decision is on the record rather than being an accident nobody noticed.

### 36. I broke my own verification, then nearly blamed the code

`scripts/verify-f02.sh` reported `F02-jest suite failed`. Run on its own, the
same command passed 32/32.

The script runs `npm test` **inside it**, and I had started it while a separate
`npm test` was already running. Jest's `globalSetup` does
`DROP DATABASE ... WITH (FORCE)` then `CREATE DATABASE`: the second run
deleted the first one's database out from under its workers.

**The dangerous part is not the lost time.** For a few minutes I had a red
check with no cause, on a feature I was about to commit - exactly the state in
which somebody decides the check is flaky and moves on.

**Fix:** `test/suite-lock.ts` takes a session-level PostgreSQL advisory lock
before `globalSetup` touches anything. A second run now refuses to start,
names the holding pid, and says why. Chosen over a lock file because
PostgreSQL releases a session lock when the connection dies however it dies -
there is no stale state to clean up. Proven by starting two runs and watching
the second refuse. Safe ordering is written down in
`docs/testing/verification-order.md`.

### 37. A 200-character merchant pushed half the table off the screen

F06-T45 was marked **PARTIAL**: the CSS was in place and the amount ceiling was
unit-tested, but no long string had ever been put through the UI. I wrote that
down as a limitation and moved on.

Submitting one took about a minute. The result: the merchant column stretched
to fit all 200 characters, pushed Amount, Spent, Decision and Status past the
viewport, and produced a **page-level horizontal scrollbar**. The column a
manager actually came for was off-screen behind a scrollbar they had no reason
to look for - the precise failure the "no essential information silently
hidden" requirement exists to prevent.

**Fix:** the table is `table-fixed` with percentage column widths, so it is
exactly as wide as its container whatever the data contains; every free-text
cell truncates with its full value in `title` and on the detail page. The
mobile card's flex children got `min-w-0`, which is the same bug in a
different layout.

**The lesson is about the PARTIAL, not the CSS.** "The code looks right and I
did not run it" was wrong, and it was wrong in a minute of work.

### 38. The error page a failure actually produced was Next's, not mine

I built `dashboard/error.tsx` and `[expenseId]/error.tsx`, wrote careful
copy, and marked F06-T35 **PARTIAL** because I had not injected a failure.

Stopping the API container produced Next's bare **"This page couldn't load"**
screen: no shell, no navigation, no way back, HTTP 500.

An `error.tsx` catches errors from its segment's **page** and below. It does
**not** catch its own `layout.tsx` - that is rendered by the parent, so a
parent boundary has to catch it. `(app)/layout.tsx` calls `requireUser()`,
which throws when the API is unreachable, and there was no boundary above it.

So the distinction F02.1 built so carefully - "the backend is down" is not
"you are signed out" - was correct in the code and **never reached a screen**.

**Fix:** `app/error.tsx`, the root boundary, with a message that says the
account is fine and offers two ways forward.

### 39. And then the retry button did not retry

With the new error page rendering, I restarted the API and pressed **Try
again**. The error page stayed.

`reset()` re-renders the boundary's subtree on the **client**, and every page
behind it is a Server Component - the router still held the failed RSC payload,
so the same failure was produced again. I then tried the usual remedy,
`router.refresh()` before `reset()`. **Still nothing**, because the throw came
from a layout: when a layout fails there is no rendered tree to refresh into.

**Fix:** the button reloads the document. These pages are server rendered and
all their state comes from one server render, so "try again" and "fetch this
page again" are the same operation. Verified the whole way through this time:
error page → API restored → press → full dashboard.

**Two attempts were wrong before the third worked**, and each looked correct
while being untested. That is the same shape as 37 and 38, three times in one
session.

## Running record

| Date | Phase | Notes |
|---|---|---|
| 2026-11-19 | Requirements and architecture | Assessment read, requirements extracted, 10 ADRs drafted, risk register created. No code |
| 2026-11-19 | Architecture review | Frequency out-of-order analysis, transaction boundary proof, O(log n) correction, guarantee separation, session and CSRF expansion |
| 2026-11-19 | F00 implementation | Monorepo, Docker, health check, config validation. Four defects found and fixed. 17/17 acceptance checks, 13/13 tests |
| 2026-11-20 | F01 design review | F00 re-verified. Schema, relationships, constraints and deletion behaviour agreed. Composite foreign key decision taken (ADR-011). Five open questions resolved before any code |
| 2026-11-20 | F01 implementation | 8 tables, 7 enums, 5 hand-written CHECK constraints, idempotent seed. Four defects found and fixed. 11/11 acceptance checks, 53/53 tests |
| 2026-11-20 | F02 design review | Seven comparisons, five diagrams, the API contract, and a security finding on the F01 seed. An eighth decision - the server-side Origin check - came out of a question from the project owner |
| 2026-11-20 | F02 implementation | Three global guards, typed principal, four CSRF layers, credential redaction, the seed gate. Four defects found and fixed. 16/16 acceptance checks, 112/112 tests |
| 2026-11-20 | F02.1 design review | Seven design and architecture decisions proposed and approved before any component was written, including the server-resolved identity model, the Radix criterion and the honest-placeholder rule |
| 2026-11-20 | F02.1 implementation | Design tokens, 7 primitives, 2 Radix-backed components, app shell, login, logout, role gate, same-origin identity resolution. Five defects found and fixed. 18/18 scripted acceptance checks, 5 browser-verified, 15/15 contrast pairs |
| 2026-11-20 | F03 design review | Ten-point plan agreed before any code: the F04 seam, the advisory lock's placement, the canonicalisation format, the normalisation rules, the 400/422 split and the validation ordering. The project owner added four requirements, one of which - that identifier normalisation must not merge client identities - changed the design rather than refining it |
| 2026-11-20 | F03 implementation | Canonicalisation, two-phase validation, the full submission transaction, aborted-transaction recovery, database-error classification, a sanitised conflict body. Five defects found and fixed. 130 new tests, 242/242 passing, no production endpoint published |
| 2026-11-20 | F04 design review | Ten-point proposal agreed before any code. The F03 port turned out to need no change at all, which was the clearest evidence the boundary had been drawn in the right place. The project owner added six requirements; two of them - the post-count synchronisation and EXPLAIN ANALYZE over an index claim - corrected real weaknesses in the plan rather than refining it |
| 2026-11-20 | F04 implementation | Three pure rules, a thin evaluator, the advisory lock as an injectable seam, and the production endpoint activated. Five defects found and fixed. 63 new tests, 305/305 passing, every F03 DEFERRED row closed |
| 2026-11-20 | F05 design review | Twelve-point proposal agreed before any code. The existing schema turned out to need no migration - the composite foreign key from F01 already guarantees a review's tenant matches its expense's. The project owner added six requirements; three changed the implementation rather than refining it: a composite keyset cursor, `clock_timestamp()` over `now()`, and measuring Prisma's query shape instead of claiming it |
| 2026-11-20 | F05 implementation | Review listing, details and resolution; a single conditional UPDATE with the tenant and concurrency guards in one WHERE; review and expense in one transaction. Three defects found and fixed. 66 new tests, 372/372 passing, R-04 mitigated with measured evidence |
| 2026-11-20 | F06 design review | A twelve-point proposal with a working HTML mockup built from the real design tokens and the real seeded rows, rather than a list of component names. The project owner approved all ten decisions and added two requirements: small, smooth open/close transitions rather than none, and a walkthrough session after delivery. Verifying the stated baseline found it was **372 tests, not 371** |
| 2026-11-20 | F06 implementation | Three tenant-scoped read endpoints, a single-statement aggregate, a shared keyset cursor, and three pages split between Server and Client Components on a stated rule. Four defects found and fixed - one of them a hundred-times money error in my own mockup. 67 new tests (45 backend, 22 frontend), 417/417 API tests passing, 23 browser checks at six viewport widths |
| 2026-11-21 | F06 closure | The three PARTIAL rows executed rather than described. Every one of them failed: a long merchant broke the table layout, a real backend outage produced Next's default error screen instead of the designed one, and its retry button did not retry. Four defects found and fixed, R-29 given a real endpoint, R-28 given an honest label, and test-database isolation enforced by an advisory lock |
