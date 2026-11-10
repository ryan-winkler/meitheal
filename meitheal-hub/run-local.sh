#!/bin/bash
# Meitheal Hub — Local testing entrypoint (no bashio/Supervisor)
#
# Usage: podman run --rm -p 3333:3000 -v /tmp/meitheal-data:/data local/meitheal-hub /run-local.sh
set -euo pipefail

export MEITHEAL_LOG_LEVEL="${MEITHEAL_LOG_LEVEL:-info}"
export MEITHEAL_LOG_REDACTION="${MEITHEAL_LOG_REDACTION:-true}"
export MEITHEAL_AUDIT_ENABLED="${MEITHEAL_AUDIT_ENABLED:-true}"
export MEITHEAL_DB_URL="${MEITHEAL_DB_URL:-file:/data/meitheal.db}"
export MEITHEAL_RUNTIME="${MEITHEAL_RUNTIME:-standalone}"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-3000}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=128}"

echo "=== Meitheal Hub — Local Testing Mode ==="
echo "Runtime: ${MEITHEAL_RUNTIME} | DB: ${MEITHEAL_DB_URL} | Port: ${PORT}"

cd /opt/meitheal/apps/web

# Ensure data dir is writable
mkdir -p /data 2>/dev/null || true

# Run migrations (non-fatal)
node scripts/migrate.mjs 2>&1 || echo "⚠ Migrations skipped (no DB yet — will create on first write)"

# Verify build output exists
if [ ! -f dist/server/entry.mjs ]; then
  echo "ERROR: Missing dist/server/entry.mjs"
  exit 1
fi

echo "Starting Meitheal on ${HOST}:${PORT}..."
exec node dist/server/entry.mjs
