#!/usr/bin/env bash
# =============================================================================
# F02.1 acceptance verification.
#
#   bash scripts/verify-f02-1.sh
#
# Covers what HTTP can show: the login lifecycle through the same-origin
# proxy, route protection, role gating, session expiry, logout, and that no
# seeded credential appears in the shipped markup.
#
# Visual and interaction checks (F02.1-T04, T05, T11, T12, T13) are done in a
# real browser and recorded in docs/testing/F02.1-test-matrix.md. Contrast
# (F02.1-T14) is scripts/check-contrast.mjs.
#
# Requires: docker, docker compose, node, npm, curl.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WEB="http://127.0.0.1:${WEB_PORT:-3000}"
DB_CONTAINER="limaz-expense-policy-db-1"

MANAGER_EMAIL="manager@nile-logistics.test"
MANAGER_PASSWORD="NileManager!2026"
ADMIN_EMAIL="admin@limaz.test"
ADMIN_PASSWORD="PlatformAdmin!2026"

PASSED=0
FAILED=0
RESULTS=()

pass() { RESULTS+=("PASS  $1  $2"); PASSED=$((PASSED + 1)); echo "  PASS  $1  $2"; }
fail() { RESULTS+=("FAIL  $1  $2"); FAILED=$((FAILED + 1)); echo "  FAIL  $1  $2"; }
section() { echo ""; echo "--- $1 ---"; }

wait_for_healthy() {
  local timeout="${1:-420}" waited=0 cid status unhealthy
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

# Signs in and prints the session token, or nothing.
login_token() {
  curl -s -D - -o /dev/null -X POST "${WEB}/api/v1/auth/login" \
    -H 'content-type: application/json' \
    -H 'x-limaz-client: 1' \
    --data "{\"email\":\"$1\",\"password\":\"$2\"}" 2>/dev/null \
    | grep -i '^set-cookie:' \
    | sed -n 's/.*limaz_session=\([^;]*\).*/\1/p' \
    | tr -d '\r'
}

status_of() {
  # $1 url, $2 optional cookie
  if [ -n "${2:-}" ]; then
    curl -s -o /dev/null -w '%{http_code}' "$1" -H "cookie: limaz_session=$2" 2>/dev/null
  else
    curl -s -o /dev/null -w '%{http_code}' "$1" 2>/dev/null
  fi
}

body_of() {
  if [ -n "${2:-}" ]; then
    curl -s "$1" -H "cookie: limaz_session=$2" 2>/dev/null
  else
    curl -s "$1" 2>/dev/null
  fi
}

echo "============================================================"
echo " F02.1 acceptance verification"
echo "============================================================"

# -----------------------------------------------------------------------------
section "F02.1-T16 / T14  build and design tokens"

if npm run build --workspace @limaz/web >/dev/null 2>&1 && [ -d apps/web/.next ]; then
  pass "F02.1-T16" "production build succeeds and emits .next"
else
  fail "F02.1-T16" "production build failed"
fi

if node scripts/check-contrast.mjs >/dev/null 2>&1; then
  pass "F02.1-T14" "every design-token pair meets its WCAG target"
else
  fail "F02.1-T14" "a token pair is below its contrast target"
  node scripts/check-contrast.mjs | grep FAIL
fi

# -----------------------------------------------------------------------------
section "F02.1-T17  docker startup"

docker compose up -d --build >/dev/null 2>&1
if wait_for_healthy 420; then
  STACK_UP=1
  pass "F02.1-T17" "db, api and web all healthy"
else
  STACK_UP=0
  fail "F02.1-T17" "stack did not become healthy"
  docker compose ps
fi

# -----------------------------------------------------------------------------
section "F02.1-T01 / T02  signing in"

if [ "$STACK_UP" -eq 1 ]; then
  MANAGER_TOKEN="$(login_token "$MANAGER_EMAIL" "$MANAGER_PASSWORD")"
  ADMIN_TOKEN="$(login_token "$ADMIN_EMAIL" "$ADMIN_PASSWORD")"

  if [ -n "$MANAGER_TOKEN" ] && echo "$(body_of "${WEB}/dashboard" "$MANAGER_TOKEN")" | grep -q 'Nile Logistics'; then
    pass "F02.1-T01" "manager signs in and their own company is rendered"
  else
    fail "F02.1-T01" "manager workspace did not render the expected company"
  fi

  if [ -n "$ADMIN_TOKEN" ] && echo "$(body_of "${WEB}/admin" "$ADMIN_TOKEN")" | grep -q 'Platform administration'; then
    pass "F02.1-T02" "platform admin signs in and reaches administration"
  else
    fail "F02.1-T02" "admin workspace did not render"
  fi
fi

# -----------------------------------------------------------------------------
section "F02.1-T03  invalid credentials"

if [ "$STACK_UP" -eq 1 ]; then
  BAD="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${WEB}/api/v1/auth/login" \
    -H 'content-type: application/json' -H 'x-limaz-client: 1' \
    --data "{\"email\":\"${MANAGER_EMAIL}\",\"password\":\"wrong\"}" 2>/dev/null)"
  UNKNOWN="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${WEB}/api/v1/auth/login" \
    -H 'content-type: application/json' -H 'x-limaz-client: 1' \
    --data '{"email":"nobody@nowhere.invalid","password":"whatever"}' 2>/dev/null)"

  if [ "$BAD" = "401" ] && [ "$UNKNOWN" = "401" ]; then
    pass "F02.1-T03" "wrong password and unknown email both give 401"
  else
    fail "F02.1-T03" "wrong=${BAD} unknown=${UNKNOWN}"
  fi
fi

# -----------------------------------------------------------------------------
section "F02.1-T06  protected routes"

if [ "$STACK_UP" -eq 1 ]; then
  # curl does not follow redirects by default, so a 307 here IS the redirect.
  HEADERS="$(curl -s -D - -o /dev/null "${WEB}/dashboard" 2>/dev/null)"

  if echo "$HEADERS" | head -1 | grep -qE '30[0-9]' && echo "$HEADERS" | grep -qi 'location:.*login'; then
    pass "F02.1-T06" "an unauthenticated protected route redirects to login"
  else
    fail "F02.1-T06" "no redirect to login: $(echo "$HEADERS" | head -1)"
  fi

  if [ "$(status_of "${WEB}/login")" = "200" ]; then
    pass "F02.1-T09" "the login page itself is reachable - no redirect loop"
  else
    fail "F02.1-T09" "login page returned $(status_of "${WEB}/login")"
  fi
fi

# -----------------------------------------------------------------------------
section "F02.1-T07  role gating"

if [ "$STACK_UP" -eq 1 ] && [ -n "${MANAGER_TOKEN:-}" ]; then
  ADMIN_AS_MANAGER="$(body_of "${WEB}/admin" "$MANAGER_TOKEN")"

  # A page, not a silent bounce: the manager is told why it will not open.
  if echo "$ADMIN_AS_MANAGER" | grep -q 'for platform administrators'; then
    pass "F02.1-T07" "a manager opening the admin area is told why it is closed"
  else
    fail "F02.1-T07" "no access-denied explanation rendered"
  fi

  if echo "$ADMIN_AS_MANAGER" | grep -q 'Companies'; then
    fail "F02.1-T07b" "admin navigation leaked into the denied page"
  else
    pass "F02.1-T07b" "no admin navigation is rendered for a manager"
  fi
fi

# -----------------------------------------------------------------------------
section "F02.1-T08 / T10  logout and refresh"

if [ "$STACK_UP" -eq 1 ] && [ -n "${MANAGER_TOKEN:-}" ]; then
  if [ "$(status_of "${WEB}/dashboard" "$MANAGER_TOKEN")" = "200" ]; then
    pass "F02.1-T10" "a valid session survives a fresh request"
  else
    fail "F02.1-T10" "session did not survive"
  fi

  curl -s -o /dev/null -X POST "${WEB}/api/v1/auth/logout" \
    -H "cookie: limaz_session=${MANAGER_TOKEN}" -H 'x-limaz-client: 1' 2>/dev/null

  AFTER="$(curl -s -D - -o /dev/null "${WEB}/dashboard" -H "cookie: limaz_session=${MANAGER_TOKEN}" 2>/dev/null)"

  if echo "$AFTER" | grep -qi 'location:.*login'; then
    pass "F02.1-T08" "the revoked session no longer opens the workspace"
  else
    fail "F02.1-T08" "revoked session still served: $(echo "$AFTER" | head -1)"
  fi
fi

# -----------------------------------------------------------------------------
section "F02.1-T18  one identity never leaks into another"

if [ "$STACK_UP" -eq 1 ] && [ -n "${ADMIN_TOKEN:-}" ]; then
  ADMIN_BODY="$(body_of "${WEB}/admin" "$ADMIN_TOKEN")"

  # The admin belongs to no company, so no company name may appear.
  if echo "$ADMIN_BODY" | grep -qE 'Nile Logistics|Delta Consulting'; then
    fail "F02.1-T18" "a company name appeared in the platform admin workspace"
  else
    pass "F02.1-T18" "the admin workspace carries no company identity"
  fi

  FRESH_MANAGER="$(login_token "$MANAGER_EMAIL" "$MANAGER_PASSWORD")"
  MANAGER_BODY="$(body_of "${WEB}/dashboard" "$FRESH_MANAGER")"

  if echo "$MANAGER_BODY" | grep -q 'Delta Consulting'; then
    fail "F02.1-T18b" "the other company appeared in this manager's workspace"
  else
    pass "F02.1-T18b" "only the signed-in manager's own company is rendered"
  fi
fi

# -----------------------------------------------------------------------------
section "F02.1  no seeded credential is shipped to the browser"

if [ "$STACK_UP" -eq 1 ]; then
  LOGIN_HTML="$(body_of "${WEB}/login")"

  if echo "$LOGIN_HTML" | grep -qE "${MANAGER_PASSWORD}|${ADMIN_PASSWORD}|lmz_dev_"; then
    fail "F02.1-creds" "a seeded credential is rendered on the sign-in page"
  else
    pass "F02.1-creds" "the sign-in page shows no seeded credential"
  fi
fi

# -----------------------------------------------------------------------------
section "F02.1-T15  the backend being down is explained, not hidden"

if [ "$STACK_UP" -eq 1 ]; then
  # Two different visitors meet a dead API by two different routes, because
  # getCurrentUser() skips the round trip entirely when there is no cookie to
  # verify. Both have to be checked; the first version of this test checked
  # only the second case and reported the first as broken.
  LIVE_SESSION="$(login_token "$MANAGER_EMAIL" "$MANAGER_PASSWORD")"

  docker compose stop api >/dev/null 2>&1
  sleep 3

  # (a) Someone holding a session: the server probes the API, the probe fails,
  #     and the page says so instead of offering a form that cannot work.
  if body_of "${WEB}/login" "$LIVE_SESSION" | grep -q 'Service unavailable'; then
    pass "F02.1-T15a" "a visitor with a session is told the service is unavailable"
  else
    fail "F02.1-T15a" "no recoverable error state was rendered for a held session"
  fi

  # (b) Someone with no cookie: nothing is probed, so the form renders. They
  #     find out on submit, and the proxy must answer in a way the form can
  #     distinguish from a wrong password.
  NO_COOKIE_HTML="$(body_of "${WEB}/login")"
  DOWN_LOGIN="$(curl -s -w '\n%{http_code}' -X POST "${WEB}/api/v1/auth/login" \
    -H 'content-type: application/json' -H 'x-limaz-client: 1' \
    --data "{\"email\":\"${MANAGER_EMAIL}\",\"password\":\"${MANAGER_PASSWORD}\"}" 2>/dev/null)"
  DOWN_STATUS="$(echo "$DOWN_LOGIN" | tail -1)"
  DOWN_BODY="$(echo "$DOWN_LOGIN" | sed '$d')"

  if echo "$NO_COOKIE_HTML" | grep -q 'Sign in to LIMAZ' \
    && [ "$DOWN_STATUS" = "502" ] \
    && echo "$DOWN_BODY" | grep -q 'upstream_unavailable'; then
    pass "F02.1-T15b" "with no cookie the form renders and submitting gives a distinguishable 502"
  else
    fail "F02.1-T15b" "status=${DOWN_STATUS} body=${DOWN_BODY}"
  fi

  # The internal address is topology, not something a browser may learn.
  if echo "$DOWN_BODY" | grep -qE 'localhost:3001|api:3001|INTERNAL_API_URL'; then
    fail "F02.1-T15c" "the upstream address leaked in the gateway error"
  else
    pass "F02.1-T15c" "the gateway error does not echo the internal address"
  fi

  docker compose start api >/dev/null 2>&1
  wait_for_healthy 240 || true
fi

# -----------------------------------------------------------------------------
echo ""
echo "============================================================"
echo " RESULT:  ${PASSED} passed, ${FAILED} failed"
echo "============================================================"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo ""
echo " Visual checks (T04, T05, T11, T12, T13) are browser-verified and"
echo " recorded in docs/testing/F02.1-test-matrix.md."
echo ""

[ "$FAILED" -eq 0 ] || exit 1
