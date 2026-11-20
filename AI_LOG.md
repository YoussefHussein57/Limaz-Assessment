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
- Refusing to put the seeded credentials on the login page, and refusing to
  put invented figures on the dashboard, even though both make the screenshots
  look better.

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
