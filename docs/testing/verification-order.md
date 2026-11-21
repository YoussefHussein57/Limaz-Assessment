# Verification order

Which commands may run at the same time, and which may not.

---

## The rule

**Only one thing may touch `limaz_test` at a time.**

Jest's `globalSetup` does `DROP DATABASE ... WITH (FORCE)` and then `CREATE
DATABASE`. Two runs doing that concurrently is not a race that produces a
slightly wrong answer - the second one **deletes the first one's database out
from under its workers**, and the first fails with errors that point nowhere
near the cause.

This is not hypothetical. It happened during F06 verification and cost real
time (AI_LOG 36).

---

## What invokes the test database

Easy to miss, because two of these do it indirectly:

| Command | Touches `limaz_test` |
|---|---|
| `npm test` | **Yes** - the API workspace |
| `npm test --workspace @limaz/api` | **Yes** |
| `npx jest …` inside `apps/api` | **Yes** |
| `bash scripts/verify-f00.sh` | **Yes** - runs `npm test` internally |
| `bash scripts/verify-f01.sh` | **Yes** - runs `npm test` internally |
| `bash scripts/verify-f02.sh` | **Yes** - runs `npm test` internally |
| `bash scripts/verify-f02-1.sh` | **Yes** - runs `npm test` internally |
| `npm test --workspace @limaz/web` | No - pure functions, no database |
| `npm run verify` | No - lint, typecheck, build |
| `docker compose up` | No - uses `limaz`, the development database |

The four `verify-f0*.sh` scripts are the trap. They look like independent
acceptance scripts and each one runs the whole Jest suite inside.

---

## The guard

`apps/api/test/suite-lock.ts` takes a **session-level PostgreSQL advisory
lock** before `globalSetup` drops anything. A second run cannot start:

```
================================================================
 Another test run already owns limaz_test (pid 2198).
================================================================
```

Chosen over a lock file because PostgreSQL releases a session lock when the
connection ends **however it ends** - clean teardown, crash, Ctrl-C, or the
machine going away. There is no stale file to clean up and no pid liveness
check to get wrong.

It is the same mechanism F04 uses for the frequency rule, on a deliberately
separate key space so the two can never block each other.

### If it refuses and you are sure nothing is running

The connection was abandoned rather than closed - a detached or orphaned
process. Closing it frees the lock:

```bash
docker compose exec db psql -U limaz -d postgres \
  -c "SELECT pg_terminate_backend(a.pid)
        FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE l.locktype = 'advisory' AND l.granted"
```

The error message prints the exact pid, so you can terminate just that one.

### If `globalSetup` fails for some other reason

Jest reports it as `reason: [AggregateError]` and prints nothing else - the
causes are inside the error and a plain string interpolation drops them.
`global-setup.ts` now prints them itself before rethrowing: every nested
cause, the `code` (`ECONNREFUSED`, or a PostgreSQL SQLSTATE), the captured
output of a failed `prisma migrate deploy`, and the host and port it was
dialling. Look for:

```
[global-setup] Test database setup failed. The cause Jest omits:
```

Added in F13 after the QA regression pass spent ten minutes reconstructing
this file by hand to find out what it had been trying to do (MIN-06).

---

## Safe full verification, in order

Run these **sequentially**. Each line waits for the previous one.

```bash
# 1. The stack must be up: the API suite needs PostgreSQL.
docker compose up -d --build
docker compose ps                      # all three healthy

# 2. Static checks. No database, safe to run any time.
npm run verify                         # lint + typecheck + build

# 3. Tests. The API suite holds the lock for its duration.
npm test                               # both workspaces, API first

# 4. Acceptance scripts. ONE AT A TIME - each runs npm test inside.
bash scripts/verify-f00.sh
bash scripts/verify-f01.sh
bash scripts/verify-f02.sh
bash scripts/verify-f02-1.sh

# 5. Response headers. Needs a REBUILT stack, because they come from the
#    Next.js server and the Express adapter rather than from application
#    code - which is why no Jest suite asserts them (R-39, R-40).
bash scripts/check-security-headers.sh

# 6. The fresh install, LAST. It clones the repository at HEAD and runs it
#    in an isolated compose project on its own ports, so it is the only step
#    that does not touch the development stack - but it is still one at a
#    time, because two copies share the compose project name.
bash scripts/verify-fresh-install.sh
```

Do **not** background any of steps 3 to 6, and do not run two of them in
separate terminals.

### Why step 6 is isolated, and why that is not enough on its own

`verify-fresh-install.sh` uses `-p limaz-fresh` and ports 3100/3101/5533, so
it never touches the development volume and can run beside a dev stack. What
it cannot survive is **a second copy of itself**: they share the compose
project name, so the older run’s teardown destroys the newer run’s
containers. That happened, and produced fifteen failures that had nothing to
do with the product.

It also clones from the repository **HEAD**, not the working tree - the
thing being verified is what a reviewer gets.

### Run all four, not the two you are thinking of

F00 and F01 feel settled, so from F03 onwards the reports quoted F02 and F02.1
and left the other two alone. `verify-f00.sh` had been **failing since
F02.1** - its F00-T04 asserted `200` on `/`, which became a redirect to
`/login` - and nothing noticed for six features (AI_LOG 45).

A gate nobody runs is not a gate. All four run in every full verification,
and the fresh install runs after them.

### Never edit a file while a script is building it

The acceptance scripts run `docker compose up -d --build`, which copies the
**working tree** into the image. Editing a source file mid-run gives the
rebuilt image a half-applied change - and when that change was a Prisma
schema, the result was three F00 checks failing against a client expecting a
column no migration had created (AI_LOG 53).

If work is in progress and the baseline needs verifying, `git stash` first.
The failures that come out of ignoring this look exactly like product
defects.

### A faster loop while developing

The acceptance scripts repeat the Jest suite, so during development run the
suite directly and save the scripts for the final gate:

```bash
npx jest test/dashboard                        # one directory
npx jest test/expenses/expense-access.e2e-spec.ts   # one file
TZ=America/New_York npm test --workspace @limaz/web  # no lock needed
```

The web suite takes no lock and can run alongside anything.

---

## Never

- Point `DATABASE_URL` at the development or any real database while running
  tests. The destructive suites (`negative-control.e2e-spec.ts`,
  `review-negative-control.e2e-spec.ts`) refuse to start unless
  `current_database()` reads `limaz_test`, but the rest of the suite would
  happily truncate whatever it is given.
- Run `npm audit fix --force`. It proposes a major **downgrade** of Prisma -
  see the dependency note in `docs/risks.md` (R-30).
