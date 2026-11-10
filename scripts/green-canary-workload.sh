#!/usr/bin/env bash
set -euo pipefail
origin=http://127.0.0.1:3000
version=$1
mode=$2
curl -fsS "$origin/api/health" | jq -e --arg version "$version" '.status == "ok" and .version == $version' >/dev/null
if [[ "$mode" == seed ]]; then
  curl -fsS "$origin/api/tasks?limit=1" >/dev/null
  cd /opt/meitheal/apps/web
  node --input-type=module <<'NODE'
import { createClient } from "@libsql/client"

const db = createClient({ url: "file:/data/meitheal.db" })
const now = 1794250000000
for (let offset = 0; offset < 2000; offset += 100) {
  const entries = Array.from({ length: 100 }, (_, position) => {
    const n = offset + position + 1
    const id = "green-fixture-" + n
    return {
      sql: "INSERT INTO tasks (id, title, description, status, priority, idempotency_key, request_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [id, "Green fixture task " + n, "Synthetic workload fixture", n % 4 === 0 ? "complete" : "todo", n % 5 + 1, id, id, now + n, now + n],
    }
  })
  await db.batch(entries, "write")
}
const { rows } = await db.execute("SELECT count(*) AS count FROM tasks")
if (rows[0]?.count !== 2000) process.exitCode = 1
console.log(JSON.stringify({ synthetic_tasks: rows[0]?.count }))
db.close()
NODE
  exit
fi

cycles=$3
workdir=$(mktemp -d /dev/shm/meitheal-response.XXXXXX)
trap 'unlink "$workdir/body" 2>/dev/null || true; rmdir "$workdir"' EXIT
response="$workdir/body"
run() {
  local operation=$1 expected=$2 path=$3
  shift 3
  local measurement code elapsed
  measurement=$(curl --silent --show-error --max-time 5 --output "$response" --write-out '%{http_code} %{time_total}' \
    -H "Origin: $origin" "$@" "$origin$path")
  read -r code elapsed <<< "$measurement"
  printf 'http,%s,%s,%s\n' "$operation" "$code" "$elapsed"
  test "$code" = "$expected"
}

for ((i=1;i<=cycles;i+=1)); do
  fixture_id="green-fixture-$((i * 13 % 1999 + 1))"
  run today 200 /today
  run list 200 '/api/tasks?limit=50'
  run search 200 "/api/search?q=Green+fixture+task&scope=tasks"
  run open 200 "/api/tasks/$fixture_id"
  jq -e --arg id "$fixture_id" '.id == $id' "$response" >/dev/null
  run create 201 /api/tasks --json "{\"title\":\"Green measured mutation $i\"}"
  id=$(jq -er '.id' "$response")
  run complete 200 "/api/tasks/$id" --request PATCH --json '{"status":"done"}'
  run readback 200 "/api/tasks/$id"
  jq -e --arg id "$id" '.id == $id and .status == "complete"' "$response" >/dev/null
  sleep 2.5
done
printf 'workload,completed,%d\n' "$cycles"
