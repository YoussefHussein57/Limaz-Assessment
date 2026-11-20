#!/usr/bin/env bash
# =============================================================================
# F01 acceptance verification.
#
#   bash scripts/verify-f01.sh
#
# Covers the Docker-level acceptance checks (F01-T18, F01-T19). The schema,
# constraint and seed behaviour (F01-T01 to F01-T17) is covered by the Jest
# integration suite, which this script also runs.
#
# Requires: docker, docker compose, node, npm.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PASSED=0
FAILED=0
RESULTS=()

pass() { RESULTS+=("PASS  $1  $2"); PASSED=$((PASSED + 1)); echo "  PASS  $1  $2"; }
fail() { RESULTS+=("FAIL  $1  $2"); FAILED=$((FAILED + 1)); echo "  FAIL  $1  $2"; }
section() { echo ""; echo "--- $1 ---"; }

DB_CONTAINER="limaz-expense-policy-db-1"

psql_scalar() {
  docker exec "$DB_CONTAINER" psql -U limaz -d limaz -tAc "$1" 2>/dev/null | tr -d '\r'
}

wait_for_healthy() {
  local timeout="${1:-300}" waited=0 cid status unhealthy
  while [ "$waited" -lt "$timeout" ]; do
    unhealthy=0
    for svc in db api web; do
      cid="$(docker compose ps -q "$svc" 2>/dev/null)"
      if [ -z "$cid" ]; then unhealthy=1; break; fi
      status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null)"
      if [ "$status" != "healthy" ]; then unhealthy=1; break; fi
    done
    [ "$unhealthy" -eq 0 ] && return 0
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

echo "============================================================"
echo " F01 acceptance verification"
echo "============================================================"

# -----------------------------------------------------------------------------
section "F01-T01 to F01-T17  schema, constraints and seed (Jest integration suite)"

if npm test --workspace @limaz/api >/dev/null 2>&1; then
  pass "F01-T01..T17" "integration suite passed against real PostgreSQL"
else
  fail "F01-T01..T17" "integration suite failed - run: npm test --workspace @limaz/api"
fi

# -----------------------------------------------------------------------------
section "F01-T18  one cold start applies migrations AND seeds"

docker compose down -v >/dev/null 2>&1
if docker compose up -d --build >/dev/null 2>&1 && wait_for_healthy 300; then
  STACK_UP=1
  pass "F01-T18" "db, api and web healthy from an empty volume"
else
  STACK_UP=0
  fail "F01-T18" "stack did not become healthy"
  docker compose ps
fi

if [ "$STACK_UP" -eq 1 ]; then
  LOGS="$(docker compose logs api 2>/dev/null)"

  if echo "$LOGS" | grep -q "migrations applied"; then
    pass "F01-T18b" "entrypoint applied the migrations"
  else
    fail "F01-T18b" "entrypoint did not report applying migrations"
  fi

  if echo "$LOGS" | grep -q "seed complete"; then
    pass "F01-T18c" "entrypoint ran the seed"
  else
    fail "F01-T18c" "entrypoint did not report seeding"
  fi

  # The reviewer needs these to log in; they are printed once at startup.
  if echo "$LOGS" | grep -q "manager@nile-logistics.test"; then
    pass "F01-T18d" "startup output names the development credentials"
  else
    fail "F01-T18d" "startup output did not print the credentials"
  fi
fi

# -----------------------------------------------------------------------------
section "F01-T18e  the seeded data is what the assessment asks for"

if [ "$STACK_UP" -eq 1 ]; then
  COMPANIES="$(psql_scalar 'SELECT count(*) FROM companies')"
  EXPENSES="$(psql_scalar 'SELECT count(*) FROM expenses')"
  OPEN_REVIEWS="$(psql_scalar "SELECT count(*) FROM reviews WHERE state='OPEN'")"
  RESOLVED="$(psql_scalar "SELECT count(*) FROM reviews WHERE state='RESOLVED'")"
  DISTINCT_LIMITS="$(psql_scalar 'SELECT count(DISTINCT "autoApproveLimitMinor") FROM policies')"
  SHARED_EXTERNAL="$(psql_scalar "SELECT count(*) FROM expenses WHERE \"externalId\"='exp-1001'")"
  PLAINTEXT_KEYS="$(psql_scalar "SELECT count(*) FROM api_keys WHERE \"keyHash\" LIKE 'lmz_%'")"

  [ "$COMPANIES" = "2" ] \
    && pass "F01-T18e" "exactly two companies seeded" \
    || fail "F01-T18e" "companies=${COMPANIES}"

  [ "$DISTINCT_LIMITS" = "2" ] \
    && pass "F01-T18f" "the two companies have different policy limits" \
    || fail "F01-T18f" "distinct auto-approve limits=${DISTINCT_LIMITS}"

  [ "${EXPENSES:-0}" -gt 0 ] && [ "${OPEN_REVIEWS:-0}" -gt 0 ] && [ "${RESOLVED:-0}" -gt 0 ] \
    && pass "F01-T18g" "dashboard has data: ${EXPENSES} expenses, ${OPEN_REVIEWS} open and ${RESOLVED} resolved reviews" \
    || fail "F01-T18g" "expenses=${EXPENSES} open=${OPEN_REVIEWS} resolved=${RESOLVED}"

  [ "$SHARED_EXTERNAL" = "2" ] \
    && pass "F01-T18h" "the same externalId exists in both companies (tenant-scoped uniqueness)" \
    || fail "F01-T18h" "rows with externalId exp-1001=${SHARED_EXTERNAL}"

  [ "$PLAINTEXT_KEYS" = "0" ] \
    && pass "F01-T18i" "no plaintext API key is stored" \
    || fail "F01-T18i" "${PLAINTEXT_KEYS} api_keys rows look like plaintext"
fi

# -----------------------------------------------------------------------------
section "F01-T19  restarting does not duplicate the seeded data"

if [ "$STACK_UP" -eq 1 ]; then
  BEFORE="$(psql_scalar 'SELECT count(*) FROM expenses')|$(psql_scalar 'SELECT count(*) FROM reviews')|$(psql_scalar 'SELECT count(*) FROM users')"

  docker compose restart api >/dev/null 2>&1
  wait_for_healthy 180

  AFTER="$(psql_scalar 'SELECT count(*) FROM expenses')|$(psql_scalar 'SELECT count(*) FROM reviews')|$(psql_scalar 'SELECT count(*) FROM users')"

  [ "$BEFORE" = "$AFTER" ] \
    && pass "F01-T19" "row counts unchanged after a restart (${AFTER})" \
    || fail "F01-T19" "before=${BEFORE} after=${AFTER}"
fi

# -----------------------------------------------------------------------------
echo ""
echo "============================================================"
echo " RESULT:  ${PASSED} passed, ${FAILED} failed"
echo "============================================================"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo ""

[ "$FAILED" -eq 0 ] || exit 1
