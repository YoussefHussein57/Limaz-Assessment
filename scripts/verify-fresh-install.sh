#!/usr/bin/env bash
#
# F13 - fresh installation from a clean checkout, in an ISOLATED compose
# project, followed by a restart that must preserve everything.
#
# Requires: docker, docker compose, git, curl, node.
#
# =============================================================================
# WHY THIS RUNS IN ITS OWN COMPOSE PROJECT, ON ITS OWN PORTS
# =============================================================================
#
# `docker compose down -v` deletes the volume of whatever project it is
# pointed at. Run from the working tree, that is the development database a
# reviewer may have data in. `-p limaz-fresh` plus a separate port block makes
# this a genuinely parallel stack: it never touches the dev volume, and it
# cannot collide with a dev stack that is already running.
#
# It also clones from the repository HEAD rather than copying the working
# tree, because the thing being verified is "what a reviewer gets", not "what
# is on my disk".
#
# DO NOT run two copies of this at once. They share the compose project name,
# so the second one's teardown destroys the first one's containers - which
# happened, and produced fifteen bogus failures (AI_LOG 53's sibling).
set -uo pipefail

PROJECT="limaz-fresh"
WEB_PORT=3100
API_PORT=3101
DB_PORT=5533
ORIGIN="http://localhost:${WEB_PORT}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
CHECKOUT="${WORK}/clone"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf '  PASS  %-10s %s\n' "$1" "$2"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %-10s %s\n' "$1" "$2"; }
check() { if [ "$1" = "0" ]; then pass "$2" "$3"; else fail "$2" "$3"; fi; }
section() { printf '\n=== %s ===\n' "$1"; }

compose() { docker compose -p "$PROJECT" --project-directory "$CHECKOUT" -f "${CHECKOUT}/docker-compose.yml" "$@"; }

cleanup() {
  section "teardown"
  compose down -v >/dev/null 2>&1
  local remaining
  remaining="$(docker ps -a --filter "name=${PROJECT}" --format '{{.Names}}' | wc -l | tr -d ' ')"
  check "$([ "$remaining" = "0" ] && echo 0 || echo 1)" "TEARDOWN" "no isolated containers remain [${remaining}]"
  rm -rf "$WORK"
  printf '\n%s\n FRESH INSTALL: %s passed, %s failed\n%s\n' "$(printf '=%.0s' {1..60})" "$PASS" "$FAIL" "$(printf '=%.0s' {1..60})"
  [ "$FAIL" = "0" ] || exit 1
}
trap cleanup EXIT

wait_healthy() {
  local deadline=$((SECONDS + ${1:-300}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local unhealthy=0
    for svc in db api web; do
      local cid status
      cid="$(compose ps -q "$svc" 2>/dev/null)"
      [ -z "$cid" ] && { unhealthy=1; break; }
      status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null)"
      [ "$status" = "healthy" ] || { unhealthy=1; break; }
    done
    [ "$unhealthy" = "0" ] && return 0
    sleep 3
  done
  return 1
}

# A session cookie file, so the admin steps look like a browser.
JAR="${WORK}/cookies.txt"

api() {
  # api METHOD PATH [BODY]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -b "$JAR" -c "$JAR" -X "$method" "http://127.0.0.1:${API_PORT}${path}" \
      -H 'content-type: application/json' -H 'x-limaz-client: 1' -H "origin: ${ORIGIN}" \
      --data-binary "$body"
  else
    curl -s -b "$JAR" -c "$JAR" -X "$method" "http://127.0.0.1:${API_PORT}${path}" \
      -H 'content-type: application/json' -H 'x-limaz-client: 1' -H "origin: ${ORIGIN}"
  fi
}

jget() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=process.argv[1].split('.').reduce((a,k)=>a?.[k],JSON.parse(s));process.stdout.write(v===undefined||v===null?'':String(v));}catch{process.stdout.write('');}})" "$1"; }

# =============================================================================
section "1. clean checkout"
# =============================================================================

HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
git clone --quiet --no-hardlinks "$REPO_ROOT" "$CHECKOUT" 2>/dev/null
check "$?" "CLONE" "cloned the repository at ${HEAD_SHA:0:8}"

git -C "$CHECKOUT" checkout --quiet "$HEAD_SHA" 2>/dev/null
check "$?" "CHECKOUT" "checked out the exact commit under test"

[ -f "${CHECKOUT}/.env" ]
check "$([ ! -f "${CHECKOUT}/.env" ] && echo 0 || echo 1)" "NO-ENV" "the clone carries NO .env - compose defaults must suffice"

[ -f "${CHECKOUT}/.env.example" ]
check "$?" "ENV-EXAMPLE" ".env.example is present for a reviewer who wants their own"

# Only the ports move. Everything else must come from the committed defaults,
# because that is what a reviewer gets.
cat > "${CHECKOUT}/.env" <<EOF
WEB_PORT=${WEB_PORT}
API_PORT=${API_PORT}
DB_PORT=${DB_PORT}
APP_ORIGIN=${ORIGIN}
EOF

# =============================================================================
section "2. one command, from cold"
# =============================================================================

START=$SECONDS
compose up -d --build >"${WORK}/up.log" 2>&1
UP_EXIT=$?
check "$UP_EXIT" "UP" "docker compose up -d --build returned ${UP_EXIT}"

if wait_healthy 420; then
  ELAPSED=$((SECONDS - START))
  pass "HEALTHY" "db, api and web all reached healthy in ${ELAPSED}s"
else
  fail "HEALTHY" "the stack did not become healthy"
  compose ps
  tail -40 "${WORK}/up.log"
fi

MIGRATED="$(compose logs api 2>/dev/null | grep -cE 'migrations applied|No pending migrations|applying database migrations')"
check "$([ "$MIGRATED" -gt 0 ] && echo 0 || echo 1)" "MIGRATE" "the entrypoint ran migrations [${MIGRATED} line(s)]"

SEEDED="$(compose logs api 2>/dev/null | grep -c 'seed complete')"
check "$([ "$SEEDED" -gt 0 ] && echo 0 || echo 1)" "SEED" "the seed ran to completion"

WORKER_OFF="$(compose logs api 2>/dev/null | grep -c 'Webhook worker disabled')"
check "$([ "$WORKER_OFF" = "0" ] && echo 0 || echo 1)" "WORKER" "the webhook worker is enabled by default"

CRASHED="$(compose logs api 2>/dev/null | grep -ciE 'UnknownDependenciesException|Refusing to start|unhandled')"
check "$([ "$CRASHED" = "0" ] && echo 0 || echo 1)" "CLEAN" "no startup errors in the api log [${CRASHED}]"

API_CODE="$(curl -s -o "${WORK}/health.json" -w '%{http_code}' "http://127.0.0.1:${API_PORT}/health")"
check "$([ "$API_CODE" = "200" ] && echo 0 || echo 1)" "API" "GET /health -> ${API_CODE}"

DB_UP="$(jget 'checks.database.status' < "${WORK}/health.json")"
check "$([ "$DB_UP" = "up" ] && echo 0 || echo 1)" "DB" "health reports the database ${DB_UP:-unknown}"

WEB_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/login")"
check "$([ "$WEB_CODE" = "200" ] && echo 0 || echo 1)" "WEB" "GET /login -> ${WEB_CODE}"

PROXY_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/api/health")"
check "$([ "$PROXY_CODE" = "200" ] && echo 0 || echo 1)" "PROXY" "the web origin proxies /api/health -> ${PROXY_CODE}"

# =============================================================================
section "3. the seeded fixtures work"
# =============================================================================

LOGIN_CODE="$(curl -s -o "${WORK}/login.json" -w '%{http_code}' -c "$JAR" \
  -X POST "http://127.0.0.1:${API_PORT}/v1/auth/login" \
  -H 'content-type: application/json' -H 'x-limaz-client: 1' -H "origin: ${ORIGIN}" \
  -d '{"email":"admin@limaz.test","password":"PlatformAdmin!2026"}')"
check "$([ "$LOGIN_CODE" = "200" ] && echo 0 || echo 1)" "ADMIN" "the seeded administrator signs in -> ${LOGIN_CODE}"

KEY_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${API_PORT}/v1/expenses" \
  -H 'x-api-key: lmz_dev_nile_7Qk2PmXaR4tVbN8cLw3ZyH6dJeF5uG9s' -H 'content-type: application/json' \
  -d "{\"externalId\":\"fresh-api-1\",\"employeeId\":\"emp-fresh\",\"amount\":1000,\"currency\":\"SAR\",\"merchant\":\"Fresh\",\"category\":\"OFFICE\",\"spentAt\":\"$(node -e 'process.stdout.write(new Date(Date.now()-60000).toISOString())')\"}")"
check "$([ "$KEY_CODE" = "201" ] && echo 0 || echo 1)" "APIKEY" "a seeded API key submits an expense -> ${KEY_CODE}"

COMPANIES="$(api GET /v1/admin/companies | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(JSON.parse(s).items.length));}catch{process.stdout.write('0');}})")"
check "$([ "$COMPANIES" -ge 2 ] && echo 0 || echo 1)" "SEED-2" "both seeded companies are present [${COMPANIES}]"

# =============================================================================
section "4. onboarding a company through the application"
# =============================================================================

STAMP="$(date +%s)"
CREATED="$(api POST /v1/admin/companies "{\"name\":\"Fresh Co ${STAMP}\",\"currency\":\"SAR\",\"autoApproveLimitMinor\":40000,\"blockedCategories\":[\"GAMBLING\"]}")"
COMPANY_ID="$(printf '%s' "$CREATED" | jget 'company.id')"
check "$([ -n "$COMPANY_ID" ] && echo 0 || echo 1)" "COMPANY" "created a company [${COMPANY_ID:0:8}]"

MGR_EMAIL="fresh-${STAMP}@fresh.test"
MGR_PASS="FreshManager!2026"
MGR="$(api POST "/v1/admin/companies/${COMPANY_ID}/managers" "{\"displayName\":\"Fresh Manager\",\"email\":\"${MGR_EMAIL}\",\"password\":\"${MGR_PASS}\"}")"
MGR_ID="$(printf '%s' "$MGR" | jget 'id')"
check "$([ -n "$MGR_ID" ] && echo 0 || echo 1)" "MANAGER" "provisioned a manager through the API"

INTEGRATION="$(api POST "/v1/admin/companies/${COMPANY_ID}/webhook-integration")"
DELIVERY_ID="$(printf '%s' "$INTEGRATION" | jget 'integration.deliveryId')"
SIGNING_SECRET="$(printf '%s' "$INTEGRATION" | jget 'signingSecret')"
check "$([ -n "$DELIVERY_ID" ] && [ -n "$SIGNING_SECRET" ] && echo 0 || echo 1)" "WEBHOOK" "provisioned a webhook integration [${DELIVERY_ID:0:12}...]"

# =============================================================================
section "5. a signed card webhook, end to end"
# =============================================================================

SIM="$(api POST /v1/admin/simulator/payments "{\"companyId\":\"${COMPANY_ID}\",\"cardholderId\":\"emp-fresh-wh\",\"merchant\":\"Grand Hotel\",\"category\":\"TRAVEL\",\"amount\":95000}")"
DELIVERY_STATUS="$(printf '%s' "$SIM" | jget 'delivery.status')"
EVENT_ID="$(printf '%s' "$SIM" | jget 'eventId')"
check "$([ "$DELIVERY_STATUS" = "202" ] && echo 0 || echo 1)" "SIM" "the simulator's signed request was accepted [${DELIVERY_STATUS}]"

EVENT_STATUS=""
EXPENSE_ID=""
DECISION=""
for _ in $(seq 1 60); do
  EV="$(api GET "/v1/admin/webhook-events/${EVENT_ID}")"
  EVENT_STATUS="$(printf '%s' "$EV" | jget 'status')"
  if [ "$EVENT_STATUS" = "PROCESSED" ] || [ "$EVENT_STATUS" = "FAILED" ]; then
    EXPENSE_ID="$(printf '%s' "$EV" | jget 'expenseId')"
    DECISION="$(printf '%s' "$EV" | jget 'decision')"
    break
  fi
  sleep 1
done

check "$([ "$EVENT_STATUS" = "PROCESSED" ] && echo 0 || echo 1)" "ASYNC" "the worker processed it [${EVENT_STATUS}]"
check "$([ "$DECISION" = "REVIEW" ] && echo 0 || echo 1)" "POLICY" "the real policy engine decided ${DECISION}"
check "$([ -n "$EXPENSE_ID" ] && echo 0 || echo 1)" "EXPENSE" "an expense exists [${EXPENSE_ID:0:8}]"

BAD="$(api POST /v1/admin/simulator/payments "{\"companyId\":\"${COMPANY_ID}\",\"cardholderId\":\"emp-fresh-wh\",\"merchant\":\"Grand Hotel\",\"category\":\"TRAVEL\",\"amount\":95000,\"mode\":\"INVALID_SIGNATURE\"}")"
BAD_STATUS="$(printf '%s' "$BAD" | jget 'delivery.status')"
check "$([ "$BAD_STATUS" = "401" ] && echo 0 || echo 1)" "SIGCHECK" "an invalid signature is refused by the real verifier [${BAD_STATUS}]"

# =============================================================================
section "6. the provisioned manager resolves it"
# =============================================================================

MJAR="${WORK}/manager.txt"
MLOGIN="$(curl -s -o /dev/null -w '%{http_code}' -c "$MJAR" \
  -X POST "http://127.0.0.1:${API_PORT}/v1/auth/login" \
  -H 'content-type: application/json' -H 'x-limaz-client: 1' -H "origin: ${ORIGIN}" \
  -d "{\"email\":\"${MGR_EMAIL}\",\"password\":\"${MGR_PASS}\"}")"
check "$([ "$MLOGIN" = "200" ] && echo 0 || echo 1)" "SIGNIN" "the provisioned manager signs in -> ${MLOGIN}"

REVIEW_ID="$(curl -s -b "$MJAR" "http://127.0.0.1:${API_PORT}/v1/reviews?state=OPEN" \
  -H 'x-limaz-client: 1' -H "origin: ${ORIGIN}" | jget 'items.0.id')"
check "$([ -n "$REVIEW_ID" ] && echo 0 || echo 1)" "QUEUE" "the webhook expense is in their review queue"

RESOLVE="$(curl -s -o /dev/null -w '%{http_code}' -b "$MJAR" \
  -X POST "http://127.0.0.1:${API_PORT}/v1/reviews/${REVIEW_ID}/resolve" \
  -H 'content-type: application/json' -H 'x-limaz-client: 1' -H "origin: ${ORIGIN}" \
  -d '{"decision":"APPROVE"}')"
check "$([ "$RESOLVE" = "200" ] && echo 0 || echo 1)" "RESOLVE" "they resolve it -> ${RESOLVE}"

FINAL="$(curl -s -b "$MJAR" "http://127.0.0.1:${API_PORT}/v1/expenses/${EXPENSE_ID}" \
  -H 'x-limaz-client: 1' -H "origin: ${ORIGIN}" | jget 'status')"
check "$([ "$FINAL" = "APPROVED" ] && echo 0 || echo 1)" "FINAL" "the final status is ${FINAL}"

# =============================================================================
section "7. restart, and nothing created by a user is lost"
# =============================================================================

BEFORE_COMPANIES="$(api GET /v1/admin/companies | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(JSON.parse(s).items.length));}catch{process.stdout.write('0');}})")"
BEFORE_EVENTS="$(api GET "/v1/admin/webhook-events?companyId=${COMPANY_ID}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(JSON.parse(s).items.length));}catch{process.stdout.write('0');}})")"

compose restart api web >/dev/null 2>&1
if wait_healthy 240; then
  pass "RESTART" "the stack came back healthy"
else
  fail "RESTART" "the stack did not come back healthy"
fi

# The seed runs again on every start. It must not double anything, and must
# not reset what a user created - the F09 defect (AI_LOG 49) was exactly this.
SEED_AGAIN="$(compose logs api 2>/dev/null | grep -c 'seed complete')"
check "$([ "$SEED_AGAIN" -ge 2 ] && echo 0 || echo 1)" "RESEED" "the seed ran again without refusing [${SEED_AGAIN} runs]"

# A fresh session: the restart revoked nothing, but the cookie jar is reused
# deliberately to prove sessions survive a restart.
AFTER_COMPANIES="$(api GET /v1/admin/companies | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(JSON.parse(s).items.length));}catch{process.stdout.write('0');}})")"
check "$([ "$AFTER_COMPANIES" = "$BEFORE_COMPANIES" ] && echo 0 || echo 1)" "COMPANIES" "the same companies exist [${BEFORE_COMPANIES} -> ${AFTER_COMPANIES}]"

AFTER_MANAGERS="$(api GET "/v1/admin/companies/${COMPANY_ID}/managers" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(JSON.parse(s).items.length));}catch{process.stdout.write('0');}})")"
check "$([ "$AFTER_MANAGERS" = "1" ] && echo 0 || echo 1)" "MANAGERS" "the provisioned manager survived [${AFTER_MANAGERS}]"

AFTER_EVENTS="$(api GET "/v1/admin/webhook-events?companyId=${COMPANY_ID}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(JSON.parse(s).items.length));}catch{process.stdout.write('0');}})")"
check "$([ "$AFTER_EVENTS" = "$BEFORE_EVENTS" ] && echo 0 || echo 1)" "EVENTS" "accepted webhook events survived [${BEFORE_EVENTS} -> ${AFTER_EVENTS}]"

AFTER_FINAL="$(curl -s -b "$MJAR" "http://127.0.0.1:${API_PORT}/v1/expenses/${EXPENSE_ID}" \
  -H 'x-limaz-client: 1' -H "origin: ${ORIGIN}" | jget 'status')"
check "$([ "$AFTER_FINAL" = "APPROVED" ] && echo 0 || echo 1)" "RESOLVED" "the resolved expense is still ${AFTER_FINAL}"

AFTER_POLICY="$(api GET "/v1/admin/companies/${COMPANY_ID}" | jget 'policy.autoApproveLimitMinor')"
check "$([ "$AFTER_POLICY" = "40000" ] && echo 0 || echo 1)" "POLICY-2" "the company's policy is unchanged [${AFTER_POLICY}]"

# The webhook integration must still verify a signature after a restart - the
# encryption key comes from configuration, so a key that changed would make
# every stored secret undecryptable.
SIM2="$(api POST /v1/admin/simulator/payments "{\"companyId\":\"${COMPANY_ID}\",\"cardholderId\":\"emp-fresh-wh2\",\"merchant\":\"City Taxi\",\"category\":\"TRANSPORT\",\"amount\":1000}")"
SIM2_STATUS="$(printf '%s' "$SIM2" | jget 'delivery.status')"
check "$([ "$SIM2_STATUS" = "202" ] && echo 0 || echo 1)" "SECRET" "the stored signing secret still verifies after a restart [${SIM2_STATUS}]"
