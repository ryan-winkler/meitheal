#!/bin/bash
# Meitheal Hub — Local testing entrypoint (no bashio/Supervisor)
#
# Usage: podman run --rm -p 127.0.0.1:3333:3000 -v /tmp/meitheal-data:/data --entrypoint /run-local.sh local/meitheal-hub
set -eu
if (set -o pipefail) 2>/dev/null; then
  set -o pipefail
fi

is_uint() {
  case "${1:-}" in
    ""|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

resolve_max_old_space_mb() {
  if is_uint "${MEITHEAL_MAX_OLD_SPACE_MB:-}" && [ "${MEITHEAL_MAX_OLD_SPACE_MB}" -ge 96 ]; then
    printf '%s\n' "${MEITHEAL_MAX_OLD_SPACE_MB}"
    return 0
  fi

  _cg_v2="${MEITHEAL_CGROUP_V2_MAX_FILE:-/sys/fs/cgroup/memory.max}"
  _cg_v1="${MEITHEAL_CGROUP_V1_LIMIT_FILE:-/sys/fs/cgroup/memory/memory.limit_in_bytes}"
  _raw=""
  if [ -r "${_cg_v2}" ]; then
    _raw="$(tr -d '[:space:]' < "${_cg_v2}" 2>/dev/null || true)"
  elif [ -r "${_cg_v1}" ]; then
    _raw="$(tr -d '[:space:]' < "${_cg_v1}" 2>/dev/null || true)"
  fi

  if is_uint "${_raw}" && [ "${_raw}" -gt 0 ] && [ "${_raw}" -lt 1099511627776 ]; then
    _total_mb=$(( _raw / 1048576 ))
    _target_mb=$(( _total_mb * 55 / 100 ))
    if [ "${_target_mb}" -lt 96 ]; then
      _target_mb=96
    elif [ "${_target_mb}" -gt 160 ]; then
      _target_mb=160
    fi
    printf '%s\n' "${_target_mb}"
    return 0
  fi

  printf '128\n'
}

resolve_v8_pool_size() {
  if is_uint "${MEITHEAL_V8_POOL_SIZE:-}" && [ "${MEITHEAL_V8_POOL_SIZE}" -ge 1 ]; then
    printf '%s\n' "${MEITHEAL_V8_POOL_SIZE}"
    return 0
  fi

  _cpu_v2=""
  if [ -n "${MEITHEAL_CGROUP_V2_CPU_MAX_FILE:-}" ]; then
    _cpu_v2="${MEITHEAL_CGROUP_V2_CPU_MAX_FILE}"
  elif [ -z "${MEITHEAL_CGROUP_V2_MAX_FILE:-}" ]; then
    _cpu_v2="/sys/fs/cgroup/cpu.max"
  fi

  if [ -n "${_cpu_v2}" ] && [ -r "${_cpu_v2}" ]; then
    _quota=""
    _period=""
    read -r _quota _period _ < "${_cpu_v2}" 2>/dev/null || true
    if is_uint "${_quota}" && is_uint "${_period}" && [ "${_quota}" -gt 0 ] && [ "${_period}" -gt 0 ] &&
      [ "${_quota}" -lt 1099511627776 ] && [ "${_period}" -lt 1099511627776 ] &&
      [ $(( _quota * 2 )) -le $(( _period * 3 )) ]; then
      printf '1\n'
      return 0
    fi
  fi

  printf '\n'
}

apply_resolved_node_options() {
  _resolved_mb="$(resolve_max_old_space_mb)"
  case " ${NODE_OPTIONS:-} " in
    *" --max-old-space-size="*)
      ;;
    *)
      NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--max-old-space-size=${_resolved_mb}"
      ;;
  esac
  _pool_size="$(resolve_v8_pool_size)"
  if [ -n "${_pool_size}" ]; then
    case " ${NODE_OPTIONS:-} " in
      *" --v8-pool-size="*|*" --v8_pool_size="*|*" --v8-pool_size="*|*" --v8_pool-size="*|*" --v8-pool-size "*|*" --v8_pool_size "*|*" --v8-pool_size "*|*" --v8_pool-size "*)
        ;;
      *)
        NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--v8-pool-size=${_pool_size}"
        ;;
    esac
  fi
  export NODE_OPTIONS
}

if [ "${MEITHEAL_SOURCE_LIB_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

export MEITHEAL_LOG_LEVEL="${MEITHEAL_LOG_LEVEL:-info}"
export MEITHEAL_LOG_REDACTION="${MEITHEAL_LOG_REDACTION:-true}"
export MEITHEAL_AUDIT_ENABLED="${MEITHEAL_AUDIT_ENABLED:-true}"
export MEITHEAL_DB_URL="${MEITHEAL_DB_URL:-file:/data/meitheal.db}"
export MEITHEAL_RUNTIME="${MEITHEAL_RUNTIME:-standalone}"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-3000}"
apply_resolved_node_options

echo "=== Meitheal Hub — Local Testing Mode ==="
echo "Runtime: ${MEITHEAL_RUNTIME} | DB: ${MEITHEAL_DB_URL} | Port: ${PORT}"

cd /opt/meitheal/apps/web

# Ensure data dir is writable
mkdir -p /data 2>/dev/null || true

# Run migrations before starting the web server.
node scripts/migrate.mjs
export MEITHEAL_STARTUP_BACKUP_HANDLED=1

# Verify build output exists
if [ ! -f dist/server/entry.mjs ]; then
  echo "ERROR: Missing dist/server/entry.mjs"
  exit 1
fi

echo "Starting Meitheal on ${HOST}:${PORT}..."
exec node dist/server/entry.mjs
