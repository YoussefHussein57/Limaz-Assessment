#!/bin/sh
# =============================================================================
# API container entrypoint.
#
# The assessment requires that a single `docker compose up` starts the complete
# application. That means migrations and seeding are the container's job, not a
# second command the reviewer has to remember.
#
# Migrations always run. SEEDING DOES NOT: it is gated behind an explicit
# SEED_DEV_DATA=true opt-in, because the seed writes credentials that are
# published in this repository and rewrites them on every start. Without the
# gate, a restart would silently restore a known admin password and re-activate
# a revoked API key. docker-compose.yml sets the opt-in because it is the
# development and review stack; a real deployment simply does not.
# =============================================================================
set -eu

API_DIR="/app/apps/api"

apply_migrations() {
  if [ -d "${API_DIR}/prisma/migrations" ] && [ -n "$(ls -A "${API_DIR}/prisma/migrations" 2>/dev/null || true)" ]; then
    echo "[entrypoint] applying database migrations"
    (cd "${API_DIR}" && npx --no-install prisma migrate deploy)
    echo "[entrypoint] migrations applied"
  else
    echo "[entrypoint] no migrations present - skipping"
  fi
}

run_seed() {
  if [ "${SEED_DEV_DATA:-false}" != "true" ]; then
    echo "[entrypoint] seeding disabled (SEED_DEV_DATA is not true) - skipping"
    return 0
  fi

  if [ -f "${API_DIR}/dist/prisma/seed.js" ]; then
    echo "[entrypoint] seeding database (development data)"
    node "${API_DIR}/dist/prisma/seed.js"
    echo "[entrypoint] seed complete"
  else
    echo "[entrypoint] no seed script present - skipping"
  fi
}

apply_migrations
run_seed

echo "[entrypoint] starting API"
exec "$@"
