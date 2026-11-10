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

container="$("$engine" run --detach --pull=never --platform "$platform" --network none \
  --env "EXPECTED_VERSION=$VERSION" --env MEITHEAL_DB_URL=file:/data/smoke.db "$image")"
cleanup() {
  local status=$?
  if [[ "$status" != 0 ]]; then "$engine" logs --tail 40 "$container" >&2 || true; fi
  "$engine" rm --force --volumes "$container" >/dev/null || status=1
  exit "$status"
}
trap cleanup EXIT

"$engine" exec "$container" bash -e -o pipefail -c '
  health="$(curl --silent --fail --max-time 2 --retry 30 --retry-connrefused --retry-delay 1 http://127.0.0.1:3000/api/health)"
  service_uid="$(id -u meitheal)"
  test "$service_uid" != 0
  web_processes=0
  for command_line in /proc/[0-9]*/cmdline; do
    if tr "\000" "\n" <"$command_line" 2>/dev/null |
      grep -Fx -e scripts/serve.mjs -e dist/server/entry.mjs >/dev/null; then
      status_file="${command_line%/cmdline}/status"
      grep -Eq "^Uid:[[:space:]]+$service_uid[[:space:]]+$service_uid[[:space:]]" "$status_file"
      grep -Eq "^CapEff:[[:space:]]+0+$" "$status_file"
      web_processes=$((web_processes + 1))
    fi
  done
  test "$web_processes" = 1
  printf "%s" "$health" |
    node -e '\''const health = JSON.parse(require("node:fs").readFileSync(0)); if (health.version !== process.env.EXPECTED_VERSION || health.db_integrity !== "ok") process.exit(1)'\''
  curl -fsS http://127.0.0.1:3000/today > /dev/null
  curl -fsS http://127.0.0.1:3000/api/frameworks |
    node -e '\''const {data} = JSON.parse(require("node:fs").readFileSync(0)); const ids = new Set(data.filter(f => f.source === "built-in").map(f => f.id)); if (!["rice", "ice", "eisenhower", "heart", "moscow", "wsjf", "ddd", "drice", "kcs"].every(id => ids.has(id))) process.exit(1)'\''
  collision_status="$(curl --silent --output /tmp/framework-collision.json --write-out "%{http_code}" \
    --json "{\"id\":\"rice\",\"name\":\"RICE\",\"archetype\":\"formula\",\"badgeThresholds\":[],\"formula\":\"reach\",\"fields\":[{\"key\":\"reach\",\"label\":\"Reach\",\"type\":\"number\",\"uiType\":\"number\",\"weight\":1,\"helpText\":\"\"}]}" \
    -H "Origin: http://127.0.0.1:3000" http://127.0.0.1:3000/api/frameworks)"
  test "$collision_status" = 409
  curl -fsS --json "{\"title\":\"Release smoke fixture\"}" \
    -H "Origin: http://127.0.0.1:3000" http://127.0.0.1:3000/api/tasks |
    node -e '\''const task = JSON.parse(require("node:fs").readFileSync(0)); if (!task.id || task.title !== "Release smoke fixture") process.exit(1)'\''
'
"$engine" exec --user meitheal --workdir /opt/meitheal/apps/web "$container" node scripts/migrate.mjs --check
