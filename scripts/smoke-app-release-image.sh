#!/usr/bin/env bash
set -euo pipefail

engine=$1
image=$2
revision=$3
ARCHITECTURE=$4
platform=$5
VERSION=$6

[[ "$engine" == docker || "$engine" == podman ]]
"$engine" image inspect "$image" |
  bash scripts/check-app-release-image.sh "$revision" "$ARCHITECTURE" "$platform" "$VERSION" "${7:-}"

"$engine" run --rm --platform "$platform" --network none --env "EXPECTED_VERSION=$VERSION" --entrypoint bash "$image" -e -c '
  export NODE_ENV=production HOST=127.0.0.1 PORT=3000 MEITHEAL_DB_URL=file:/data/smoke.db
  cd /opt/meitheal/apps/web
  node scripts/migrate.mjs
  node scripts/migrate.mjs --check
  node scripts/serve.mjs &
  pid=$!
  trap "kill $pid" EXIT
  for attempt in {1..30}; do
    if curl -fsS http://127.0.0.1:3000/api/health > /dev/null; then
      break
    fi
    sleep 1
  done
  curl -fsS http://127.0.0.1:3000/api/health |
    node -e '\''const health = JSON.parse(require("node:fs").readFileSync(0)); if (health.version !== process.env.EXPECTED_VERSION) process.exit(1)'\''
  curl -fsS http://127.0.0.1:3000/today > /dev/null
  curl -fsS --json "{\"title\":\"Release smoke fixture\"}" \
    -H "Origin: http://127.0.0.1:3000" http://127.0.0.1:3000/api/tasks |
    node -e '\''const task = JSON.parse(require("node:fs").readFileSync(0)); if (!task.id || task.title !== "Release smoke fixture") process.exit(1)'\''
'
