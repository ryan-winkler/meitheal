#!/bin/sh
set -eu

cd "$(dirname "$0")/../apps/web"
fixture_dir=$(mktemp -d)
trap 'rm -rf -- "$fixture_dir"' EXIT

env -i PATH="$PATH" NODE_ENV=production HOST=127.0.0.1 PORT="$1" \
  TZ=Europe/Dublin MEITHEAL_DB_URL="file:$fixture_dir/meitheal.db" \
  node scripts/serve.mjs &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" || true; exit 0' INT TERM
wait "$server_pid"
