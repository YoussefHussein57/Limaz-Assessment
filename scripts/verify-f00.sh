#!/usr/bin/env bash
# =============================================================================
# F00 acceptance verification.
#
#   bash scripts/verify-f00.sh
#
# Runs the F00 test matrix (docs/testing/F00-test-matrix.md) and prints a
# PASS / FAIL / SKIP line per test ID. Exits non-zero if any test fails.
#
# Requires: docker, docker compose, node, npm, curl, git.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WEB_PORT="${WEB_PORT:-3000}"
API_PORT="${API_PORT:-3001}"
TMP="${TMPDIR:-/tmp}"

PASSED=0
FAILED=0
SKIPPED=0
RESULTS=()

pass() { RESULTS+=("PASS  $1  $2"); PASSED=$((PASSED + 1)); echo "  PASS  $1  $2"; }
fail() { RESULTS+=("FAIL  $1  $2"); FAILED=$((FAILED + 1)); echo "  FAIL  $1  $2"; }
skip() { RESULTS+=("SKIP  $1  $2"); SKIPPED=$((SKIPPED + 1)); echo "  SKIP  $1  $2"; }

section() { echo ""; echo "--- $1 ---"; }

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
echo " F00 acceptance verification"
echo "============================================================"

# -----------------------------------------------------------------------------
section "F00-T08 / T09 / T11  static gates"

if npm run lint >/dev/null 2>&1; then
  pass "F00-T08" "eslint exits 0"
else
  fail "F00-T08" "eslint reported problems"
fi

if npm run typecheck >/dev/null 2>&1; then
  pass "F00-T09" "tsc --noEmit exits 0 for both workspaces"
else
  fail "F00-T09" "typecheck failed"
fi

# Exit code 0 is NOT evidence of output. A tsbuildinfo left over from a previous
# run once made `nest build` exit 0 while emitting nothing at all, which
# produced an image with no application in it. Assert the artefacts.
rm -f apps/api/*.tsbuildinfo
if npm run build >/dev/null 2>&1; then
  BUILD_ARTEFACTS_OK=1
  [ -f apps/api/dist/main.js ] || { BUILD_ARTEFACTS_OK=0; echo "      missing: apps/api/dist/main.js"; }
  [ -d apps/web/.next ] || { BUILD_ARTEFACTS_OK=0; echo "      missing: apps/web/.next"; }

  if [ "$BUILD_ARTEFACTS_OK" -eq 1 ]; then
    pass "F00-T11" "both workspaces build AND emit their artefacts"
  else
    fail "F00-T11" "build exited 0 but did not emit its artefacts"
  fi
else
  fail "F00-T11" "build failed"
fi

# Running twice in a row is the case that previously emitted nothing.
if npm run build --workspace @limaz/api >/dev/null 2>&1 && [ -f apps/api/dist/main.js ]; then
  pass "F00-T11b" "a repeated build still emits dist/main.js"
else
  fail "F00-T11b" "a repeated build produced no output"
fi

# -----------------------------------------------------------------------------
section "F00-T06  invalid configuration fails fast"

if [ -f apps/api/dist/main.js ]; then
  BAD_ENV_OUT="$(cd apps/api && env -u DATABASE_URL NODE_ENV=production node dist/main.js 2>&1)"
  BAD_ENV_CODE=$?

  if [ "$BAD_ENV_CODE" -ne 0 ] && echo "$BAD_ENV_OUT" | grep -q "DATABASE_URL"; then
    pass "F00-T06" "exits ${BAD_ENV_CODE} and names DATABASE_URL"
  else
    fail "F00-T06" "exit=${BAD_ENV_CODE}; output did not name the missing variable"
  fi

  if echo "$BAD_ENV_OUT" | grep -qi "at Object\.\|node_modules"; then
    fail "F00-T06b" "a raw stack trace was printed instead of a config message"
  else
    pass "F00-T06b" "a readable config error, not a stack trace"
  fi
else
  skip "F00-T06" "no build artefact to run"
  skip "F00-T06b" "no build artefact to run"
fi

# -----------------------------------------------------------------------------
section "F00-T07  no secrets tracked by git"

if [ -d .git ]; then
  IGNORED_OK=1
  for p in .env node_modules apps/api/.env; do
    git check-ignore -q "$p" 2>/dev/null || { IGNORED_OK=0; echo "      not ignored: $p"; }
  done
  git ls-files --error-unmatch .env >/dev/null 2>&1 && { IGNORED_OK=0; echo "      .env is TRACKED"; }

  if [ "$IGNORED_OK" -eq 1 ]; then
    pass "F00-T07" ".env and node_modules ignored, no env file tracked"
  else
    fail "F00-T07" "gitignore does not cover all sensitive paths"
  fi
else
  fail "F00-T07" "not a git repository"
fi

# -----------------------------------------------------------------------------
section "F00-T01  full stack starts from a cold state"

docker compose down -v >/dev/null 2>&1
if docker compose up -d --build >/dev/null 2>&1 && wait_for_healthy 300; then
  STACK_UP=1
  pass "F00-T01" "db, api and web all reached healthy"
else
  STACK_UP=0
  fail "F00-T01" "stack did not become healthy within 300s"
  docker compose ps
fi

# -----------------------------------------------------------------------------
section "F00-T12  no secrets or stale build caches in the image"

API_IMAGE="$(docker compose config --images 2>/dev/null | grep -i 'api' | head -1)"
API_IMAGE="${API_IMAGE:-limaz-expense-policy-api}"

if docker image inspect "$API_IMAGE" >/dev/null 2>&1; then
  IMG_REPORT="$(docker run --rm --entrypoint sh "$API_IMAGE" -c '
    ls /app/apps/api/dist/main.js >/dev/null 2>&1 && echo DIST_OK
    ls /app/apps/api/.env >/dev/null 2>&1 && echo ENV_LEAK
    find /app -name "*.tsbuildinfo" -not -path "*/node_modules/*" 2>/dev/null | grep -q . && echo STALE_CACHE
    echo "USER=$(id -un)"
  ' 2>/dev/null)"

  IMG_OK=1
  echo "$IMG_REPORT" | grep -q DIST_OK      || { IMG_OK=0; echo "      image has no dist/main.js"; }
  echo "$IMG_REPORT" | grep -q ENV_LEAK     && { IMG_OK=0; echo "      image contains apps/api/.env"; }
  echo "$IMG_REPORT" | grep -q STALE_CACHE  && { IMG_OK=0; echo "      image contains a *.tsbuildinfo"; }
  echo "$IMG_REPORT" | grep -q "USER=node"  || { IMG_OK=0; echo "      image does not run as node"; }

  if [ "$IMG_OK" -eq 1 ]; then
    pass "F00-T12" "app present, no .env, no stale cache, runs as node"
  else
    fail "F00-T12" "image audit failed"
  fi
else
  skip "F00-T12" "api image not available"
fi

# -----------------------------------------------------------------------------
section "F00-T02  health endpoint reflects real database state"

if [ "$STACK_UP" -eq 1 ]; then
  HEALTH_CODE="$(curl -s -o "$TMP/f00-health.json" -w '%{http_code}' "http://127.0.0.1:${API_PORT}/health" 2>/dev/null)"
  HEALTH_BODY="$(cat "$TMP/f00-health.json" 2>/dev/null)"

  if [ "$HEALTH_CODE" = "200" ] \
    && echo "$HEALTH_BODY" | grep -q '"status":"ok"' \
    && echo "$HEALTH_BODY" | grep -q '"status":"up"' \
    && echo "$HEALTH_BODY" | grep -q '"latencyMs"'; then
    pass "F00-T02" "200 with database up and a latency reading"
  else
    fail "F00-T02" "code=${HEALTH_CODE} body=${HEALTH_BODY}"
  fi

  # Only meaningful when there is a body to inspect.
  if [ -n "$HEALTH_BODY" ]; then
    if echo "$HEALTH_BODY" | grep -q 'postgresql://'; then
      fail "F00-T02b" "health response leaked the connection string"
    else
      pass "F00-T02b" "health response contains no connection string"
    fi
  else
    skip "F00-T02b" "no response body to inspect"
  fi
else
  skip "F00-T02" "stack is not up"
  skip "F00-T02b" "stack is not up"
fi

# -----------------------------------------------------------------------------
section "F00-T03  api waited for the database rather than crash-looping"

if [ "$STACK_UP" -eq 1 ]; then
  API_CID="$(docker compose ps -q api 2>/dev/null)"
  RESTARTS="$(docker inspect --format='{{.RestartCount}}' "$API_CID" 2>/dev/null)"

  if [ "${RESTARTS:-x}" = "0" ]; then
    pass "F00-T03" "api RestartCount=0"
  else
    fail "F00-T03" "api RestartCount=${RESTARTS:-unknown}"
  fi

  if docker compose logs api 2>/dev/null | grep -q "no migrations present"; then
    pass "F00-T03b" "entrypoint migration and seed steps ran (no-op in F00)"
  else
    fail "F00-T03b" "entrypoint did not report its migration step"
  fi
else
  skip "F00-T03" "stack is not up"
  skip "F00-T03b" "stack is not up"
fi

# -----------------------------------------------------------------------------
section "F00-T04  web serves a page"

if [ "$STACK_UP" -eq 1 ]; then
  WEB_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/" 2>/dev/null)"
  WEB_TYPE="$(curl -s -o /dev/null -w '%{content_type}' "http://127.0.0.1:${WEB_PORT}/" 2>/dev/null)"

  if [ "$WEB_CODE" = "200" ] && echo "$WEB_TYPE" | grep -q "text/html"; then
    pass "F00-T04" "200 text/html"
  else
    fail "F00-T04" "code=${WEB_CODE} type=${WEB_TYPE}"
  fi
else
  skip "F00-T04" "stack is not up"
fi

# -----------------------------------------------------------------------------
section "F00-T05  same-origin proxy reaches the api with no CORS"

if [ "$STACK_UP" -eq 1 ]; then
  PROXY_HEADERS="$(curl -s -D - -o "$TMP/f00-proxy.json" "http://127.0.0.1:${WEB_PORT}/api/health" 2>/dev/null)"
  PROXY_BODY="$(cat "$TMP/f00-proxy.json" 2>/dev/null)"

  if echo "$PROXY_HEADERS" | head -1 | grep -q "200" \
    && echo "$PROXY_BODY" | grep -q '"status":"ok"' \
    && echo "$PROXY_BODY" | grep -q '"database"'; then
    pass "F00-T05" "web origin proxied /api/health to the api"
  else
    fail "F00-T05" "proxy did not return a healthy api response"
  fi

  # Only meaningful when the proxy actually answered.
  if [ -n "$PROXY_HEADERS" ]; then
    if echo "$PROXY_HEADERS" | grep -qi "access-control-allow-origin"; then
      fail "F00-T05b" "a CORS header was present - the deployment is not same-origin"
    else
      pass "F00-T05b" "no CORS header needed (same-origin confirmed)"
    fi
  else
    skip "F00-T05b" "no response headers to inspect"
  fi
else
  skip "F00-T05" "stack is not up"
  skip "F00-T05b" "stack is not up"
fi

# -----------------------------------------------------------------------------
section "F00-T10  repeated cold start is idempotent"

docker compose down -v >/dev/null 2>&1
if docker compose up -d >/dev/null 2>&1 && wait_for_healthy 300; then
  pass "F00-T10" "second cold start also reached healthy"
else
  fail "F00-T10" "second cold start failed"
  docker compose ps
fi

# -----------------------------------------------------------------------------
echo ""
echo "============================================================"
echo " RESULT:  ${PASSED} passed, ${FAILED} failed, ${SKIPPED} skipped"
echo "============================================================"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo ""

[ "$FAILED" -eq 0 ] || exit 1
