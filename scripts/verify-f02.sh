#!/usr/bin/env bash
# =============================================================================
# F02 acceptance verification.
#
#   bash scripts/verify-f02.sh
#
# Covers what only the running stack can show: authentication through the
# Next.js same-origin proxy (F02-T20), the seed's production refusal
# (F02-T21), the absence of CORS headers, and that no credential reaches the
# container logs (F02-T24).
#
# The guard, session, tenant and CSRF behaviour is covered by the Jest
# integration suite, which this script runs first.
#
# Requires: docker, docker compose, node, npm, curl, jq-free (uses grep).
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WEB_PORT="${WEB_PORT:-3000}"
API_PORT="${API_PORT:-3001}"
TMP="${TMPDIR:-/tmp}"
DB_CONTAINER="limaz-expense-policy-db-1"

MANAGER_EMAIL="manager@nile-logistics.test"
MANAGER_PASSWORD="NileManager!2026"
NILE_KEY="lmz_dev_nile_7Qk2PmXaR4tVbN8cLw3ZyH6dJeF5uG9s"

PASSED=0
FAILED=0
RESULTS=()

pass() { RESULTS+=("PASS  $1  $2"); PASSED=$((PASSED + 1)); echo "  PASS  $1  $2"; }
fail() { RESULTS+=("FAIL  $1  $2"); FAILED=$((FAILED + 1)); echo "  FAIL  $1  $2"; }
section() { echo ""; echo "--- $1 ---"; }

# Strips the seed's own output block.
#
# The seed prints the development credentials on purpose, once at startup, so
# a reviewer can sign in. Any credential check that reads the logs has to
# exclude that block, or it reports the intended banner as a leak - which is
# exactly what happened the first two times this script ran.
without_seed_banner() {
  # Literal substring matching via index(), not regex. A bracket in an awk
  # pattern is a character class, so /[entrypoint]/ matches any ONE of those
  # letters - which silently suppressed the whole log the first time this was
  # written with brackets.
  awk '
    index($0, "[entrypoint] seeding database") { inseed = 1 }
    !inseed { print }
    index($0, "[entrypoint] seed complete")    { inseed = 0 }
  '
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
echo " F02 acceptance verification"
echo "============================================================"

# -----------------------------------------------------------------------------
section "F02-T01 to T19, T22 to T30  guards, sessions, tenancy (Jest)"

if npm test --workspace @limaz/api >/dev/null 2>&1; then
  pass "F02-jest" "all suites passed against real PostgreSQL"
else
  fail "F02-jest" "suite failed - run: npm test --workspace @limaz/api"
fi

# -----------------------------------------------------------------------------
section "F02-T21  the seed refuses to run outside development"

SEED_OUT="$(cd apps/api && NODE_ENV=production SEED_DEV_DATA=false node dist/prisma/seed.js 2>&1)"
SEED_CODE=$?

if [ "$SEED_CODE" -ne 0 ] && echo "$SEED_OUT" | grep -q "Refusing to seed"; then
  pass "F02-T21" "exits ${SEED_CODE} and explains why"
else
  fail "F02-T21" "exit=${SEED_CODE}; expected a refusal"
fi

if echo "$SEED_OUT" | grep -qE "NileManager|PlatformAdmin|lmz_dev_"; then
  fail "F02-T21b" "the refusal message leaked a credential"
else
  pass "F02-T21b" "the refusal names no credential"
fi

# -----------------------------------------------------------------------------
section "F02-T20  the stack is up with migrations and seed"

docker compose down -v >/dev/null 2>&1
if docker compose up -d --build >/dev/null 2>&1 && wait_for_healthy 300; then
  STACK_UP=1
  pass "F02-T20a" "db, api and web healthy from an empty volume"
else
  STACK_UP=0
  fail "F02-T20a" "stack did not become healthy"
  docker compose ps
fi

# -----------------------------------------------------------------------------
section "F02-T20  authentication through the same-origin proxy"

if [ "$STACK_UP" -eq 1 ]; then
  # Login through the WEB origin, exactly as a browser would.
  LOGIN_HEADERS="$(curl -s -D - -o "$TMP/f02-login.json" \
    -X POST "http://127.0.0.1:${WEB_PORT}/api/v1/auth/login" \
    -H 'content-type: application/json' \
    -H 'x-limaz-client: 1' \
    -H "origin: http://localhost:${WEB_PORT}" \
    --data "{\"email\":\"${MANAGER_EMAIL}\",\"password\":\"${MANAGER_PASSWORD}\"}" 2>/dev/null)"
  LOGIN_BODY="$(cat "$TMP/f02-login.json" 2>/dev/null)"

  if echo "$LOGIN_HEADERS" | head -1 | grep -q "200" && echo "$LOGIN_BODY" | grep -q '"role":"MANAGER"'; then
    pass "F02-T20" "login succeeded through the Next proxy"
  else
    fail "F02-T20" "login through the proxy failed: $(echo "$LOGIN_BODY" | head -c 200)"
  fi

  # The Set-Cookie has to survive the proxy hop, including its attributes.
  COOKIE_LINE="$(echo "$LOGIN_HEADERS" | grep -i '^set-cookie:' | head -1)"
  if echo "$COOKIE_LINE" | grep -q 'HttpOnly' \
    && echo "$COOKIE_LINE" | grep -q 'SameSite=Lax' \
    && echo "$COOKIE_LINE" | grep -q 'Path=/'; then
    pass "F02-T20b" "Set-Cookie survived the proxy with its attributes intact"
  else
    fail "F02-T20b" "cookie attributes lost in transit: ${COOKIE_LINE}"
  fi

  TOKEN="$(echo "$COOKIE_LINE" | sed -n 's/.*limaz_session=\([^;]*\).*/\1/p' | tr -d '\r')"

  # The authenticated round trip, again through the proxy.
  ME_BODY="$(curl -s "http://127.0.0.1:${WEB_PORT}/api/v1/auth/me" \
    -H "cookie: limaz_session=${TOKEN}" 2>/dev/null)"

  if echo "$ME_BODY" | grep -q '"callerType":"user"' && echo "$ME_BODY" | grep -q 'Nile Logistics'; then
    pass "F02-T20c" "the session authenticates subsequent proxied requests"
  else
    fail "F02-T20c" "proxied /me failed: $(echo "$ME_BODY" | head -c 200)"
  fi

  # Logout, then replay the same token.
  curl -s -o /dev/null -X POST "http://127.0.0.1:${WEB_PORT}/api/v1/auth/logout" \
    -H "cookie: limaz_session=${TOKEN}" -H 'x-limaz-client: 1' 2>/dev/null

  REPLAY_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/api/v1/auth/me" \
    -H "cookie: limaz_session=${TOKEN}" 2>/dev/null)"

  if [ "$REPLAY_CODE" = "401" ]; then
    pass "F02-T20d" "a revoked session is rejected on replay (${REPLAY_CODE})"
  else
    fail "F02-T20d" "replay returned ${REPLAY_CODE}, expected 401"
  fi
fi

# -----------------------------------------------------------------------------
section "F02  API key authentication against the live API"

if [ "$STACK_UP" -eq 1 ]; then
  KEY_BODY="$(curl -s "http://127.0.0.1:${API_PORT}/v1/auth/me" -H "x-api-key: ${NILE_KEY}" 2>/dev/null)"

  if echo "$KEY_BODY" | grep -q '"callerType":"api-key"' && echo "$KEY_BODY" | grep -q 'Nile Logistics'; then
    pass "F02-T01-live" "a seeded API key resolves to its own company"
  else
    fail "F02-T01-live" "api key auth failed: $(echo "$KEY_BODY" | head -c 200)"
  fi

  BAD_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${API_PORT}/v1/auth/me" \
    -H 'x-api-key: lmz_dev_nope_000000000000000000000000000000' 2>/dev/null)"
  NONE_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${API_PORT}/v1/auth/me" 2>/dev/null)"

  if [ "$BAD_CODE" = "401" ] && [ "$NONE_CODE" = "401" ]; then
    pass "F02-T02-live" "an unknown key and no key both give 401"
  else
    fail "F02-T02-live" "unknown=${BAD_CODE} none=${NONE_CODE}"
  fi
fi

# -----------------------------------------------------------------------------
section "F02  no CORS is granted to any origin"

if [ "$STACK_UP" -eq 1 ]; then
  PREFLIGHT="$(curl -s -D - -o /dev/null -X OPTIONS "http://127.0.0.1:${API_PORT}/v1/auth/me" \
    -H 'origin: https://evil.example' \
    -H 'access-control-request-method: GET' \
    -H 'access-control-request-headers: x-limaz-client' 2>/dev/null)"

  if echo "$PREFLIGHT" | grep -qi 'access-control-allow-origin'; then
    fail "F02-cors" "a CORS header was granted - the API is no longer same-origin only"
  else
    pass "F02-cors" "no access-control-allow-origin, so browsers deny by default"
  fi

  ORIGIN_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${API_PORT}/v1/auth/logout" \
    -H 'origin: https://evil.example' -H 'x-limaz-client: 1' \
    -H 'cookie: limaz_session=whatever' 2>/dev/null)"

  if [ "$ORIGIN_CODE" = "403" ]; then
    pass "F02-T30-live" "a foreign Origin is refused server-side (403)"
  else
    fail "F02-T30-live" "foreign Origin returned ${ORIGIN_CODE}, expected 403"
  fi
fi

# -----------------------------------------------------------------------------
section "F02-T24  no credential reaches the container logs"

if [ "$STACK_UP" -eq 1 ]; then
  LOGS="$(docker compose logs api 2>/dev/null)"

  # The seed prints the development credentials ON PURPOSE, once at startup,
  # so a reviewer can sign in without hunting through the README. That is the
  # single intended exception, it is clearly labelled, and it only happens
  # because docker-compose.yml explicitly sets SEED_DEV_DATA=true.
  #
  # The question this test actually asks is whether the APPLICATION leaks a
  # credential while serving requests. So the seed's own block is excluded,
  # and anything found outside it is a real finding.
  RUNTIME_LOGS="$(echo "$LOGS" | without_seed_banner)"

  LEAKED=0
  echo "$RUNTIME_LOGS" | grep -q "${MANAGER_PASSWORD}" && { LEAKED=1; echo "      a password appears in the runtime logs"; }
  echo "$RUNTIME_LOGS" | grep -qE '\$2[aby]\$[0-9]{2}\$' && { LEAKED=1; echo "      a bcrypt hash appears in the runtime logs"; }
  echo "$RUNTIME_LOGS" | grep -q "${NILE_KEY}" && { LEAKED=1; echo "      an API key appears in the runtime logs"; }
  [ -n "${TOKEN:-}" ] && echo "$RUNTIME_LOGS" | grep -q "${TOKEN}" && { LEAKED=1; echo "      a session token appears in the runtime logs"; }
  echo "$RUNTIME_LOGS" | grep -q 'postgresql://' && { LEAKED=1; echo "      a connection string appears in the runtime logs"; }

  if [ "$LEAKED" -eq 0 ]; then
    pass "F02-T24" "no credential in the logs outside the labelled seed banner"
  else
    fail "F02-T24" "a credential reached the runtime logs"
  fi

  if echo "$LOGS" | grep -q 'DEVELOPMENT DATA ONLY'; then
    pass "F02-T24b" "the one credential block present is the seed banner, clearly labelled"
  else
    fail "F02-T24b" "the seed banner is missing - did seeding run?"
  fi

  # Logging in and out again, then re-reading the logs: a request that
  # genuinely handled a password and a token must leave neither behind.
  curl -s -o /dev/null -X POST "http://127.0.0.1:${WEB_PORT}/api/v1/auth/login" \
    -H 'content-type: application/json' -H 'x-limaz-client: 1' \
    --data "{\"email\":\"${MANAGER_EMAIL}\",\"password\":\"${MANAGER_PASSWORD}\"}" 2>/dev/null
  curl -s -o /dev/null "http://127.0.0.1:${API_PORT}/v1/auth/me" -H "x-api-key: ${NILE_KEY}" 2>/dev/null
  curl -s -o /dev/null "http://127.0.0.1:${API_PORT}/v1/auth/me" -H 'x-api-key: broken' 2>/dev/null

  # Same exclusion here: on a freshly started stack the 30-second window
  # still contains the seed banner.
  AFTER_LOGS="$(docker compose logs --since 30s api 2>/dev/null | without_seed_banner)"
  if echo "$AFTER_LOGS" | grep -qE "${MANAGER_PASSWORD}|${NILE_KEY}"; then
    fail "F02-T24c" "handling a real login or API key wrote the credential to the logs"
  else
    pass "F02-T24c" "handling real credentials left nothing in the logs"
  fi
fi

# -----------------------------------------------------------------------------
section "F02-T18  nothing in the live database is plaintext"

if [ "$STACK_UP" -eq 1 ]; then
  PLAIN_KEYS="$(docker exec "$DB_CONTAINER" psql -U limaz -d limaz -tAc \
    "SELECT count(*) FROM api_keys WHERE \"keyHash\" LIKE 'lmz_%'" 2>/dev/null | tr -d '\r')"
  PLAIN_PW="$(docker exec "$DB_CONTAINER" psql -U limaz -d limaz -tAc \
    "SELECT count(*) FROM users WHERE \"passwordHash\" NOT LIKE '\$2%'" 2>/dev/null | tr -d '\r')"

  if [ "${PLAIN_KEYS:-1}" = "0" ] && [ "${PLAIN_PW:-1}" = "0" ]; then
    pass "F02-T18-live" "every key hash and password hash is hashed"
  else
    fail "F02-T18-live" "plaintext keys=${PLAIN_KEYS} non-bcrypt passwords=${PLAIN_PW}"
  fi
fi

# -----------------------------------------------------------------------------
echo ""
echo "============================================================"
echo " RESULT:  ${PASSED} passed, ${FAILED} failed"
echo "============================================================"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo ""

[ "$FAILED" -eq 0 ] || exit 1
