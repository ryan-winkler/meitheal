#!/usr/bin/env bash
# Use a host-configured build store when available, including nested commands.
set -euo pipefail
project=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$project"
command=(podman build --format docker --file "$project/meitheal-hub/Dockerfile" "$@" "$project")
if command -v meitheal-build >/dev/null 2>&1; then
  exec meitheal-build "${command[@]}"
fi
exec "${command[@]}"
