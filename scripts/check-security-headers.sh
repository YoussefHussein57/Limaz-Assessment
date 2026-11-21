#!/usr/bin/env bash
#
# Checks the response headers added in F13 (risks R-39 and R-40).
#
# WHY THIS IS A SCRIPT AND NOT A TEST
#
# These headers are produced by the Next.js server and by the Express adapter,
# not by application code a Jest suite can reach. Asserting them meaningfully
# needs a real response from a running build - which is what this does.
#
# It is therefore NOT part of `npm test`. Run it after `docker compose up`,
# and it is step 7 of docs/testing/verification-order.md.
#
# Usage:
#   ./scripts/check-security-headers.sh [web-origin] [api-origin]

set -euo pipefail

WEB="${1:-http://localhost:3000}"
API="${2:-http://localhost:3001}"

pass=0
fail=0

ok() {
  printf '  \033[32mPASS\033[0m  %s\n' "$1"
  pass=$((pass + 1))
}

bad() {
  printf '  \033[31mFAIL\033[0m  %s\n' "$1"
  fail=$((fail + 1))
}

# Header names are case-insensitive, so every comparison lowercases first.
# `tr -d '\r'` matters: HTTP line endings are CRLF and a trailing \r breaks
# an exact match in a way that looks like a missing header.
headers_of() {
  curl --silent --show-error --dump-header - --output /dev/null "$1" |
    tr -d '\r' |
    tr '[:upper:]' '[:lower:]'
}

expect_present() {
  local blob="$1" needle="$2" label="$3"

  if printf '%s' "$blob" | grep -qi -- "$needle"; then
    ok "$label"
  else
    bad "$label  (expected to find: $needle)"
  fi
}

expect_absent() {
  local blob="$1" needle="$2" label="$3"

  if printf '%s' "$blob" | grep -qi -- "$needle"; then
    bad "$label  (found: $needle)"
  else
    ok "$label"
  fi
}

echo
echo "Security headers"
echo "================"
echo

echo "web  $WEB/login"
web_headers="$(headers_of "$WEB/login")"
expect_present "$web_headers" "content-security-policy: frame-ancestors 'none'" "frame-ancestors 'none'      (R-39)"
expect_present "$web_headers" "x-frame-options: deny" "X-Frame-Options: DENY       (R-39)"
expect_present "$web_headers" "x-content-type-options: nosniff" "X-Content-Type-Options      (R-40)"
expect_present "$web_headers" "referrer-policy: strict-origin-when-cross-origin" "Referrer-Policy             (R-40)"
expect_absent  "$web_headers" "x-powered-by" "no X-Powered-By             (R-40)"

echo
echo "api  $API/health"
api_headers="$(headers_of "$API/health")"
expect_absent "$api_headers" "x-powered-by" "no X-Powered-By             (R-40)"

# The API is reached by server-to-server callers and through the web tier's
# own proxy, never framed, so it carries no frame directives of its own. That
# is stated rather than silently untested.
echo
echo "  note: the API sends no frame directives. It is never loaded in a"
echo "        browsing context - the dashboard reaches it through the"
echo "        same-origin proxy, and company backends are not browsers."

echo
echo "----------------------------------------"
printf '%d passed, %d failed\n' "$pass" "$fail"
echo

[ "$fail" -eq 0 ]
