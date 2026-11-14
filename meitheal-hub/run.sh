#!/usr/bin/with-contenv bashio
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

apply_resolved_node_options() {
  _resolved_mb="$(resolve_max_old_space_mb)"
  case " ${NODE_OPTIONS:-} " in
    *" --max-old-space-size="*)
      export NODE_OPTIONS
      ;;
    *)
      export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--max-old-space-size=${_resolved_mb}"
      ;;
  esac
}

if [ "${MEITHEAL_SOURCE_LIB_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

if [ -z "${MEITHEAL_VERSION:-}" ]; then
  export MEITHEAL_VERSION="0.0.1"
fi
export NODE_ENV="production"
STARTUP_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "{\"event\":\"addon.startup\",\"version\":\"${MEITHEAL_VERSION}\",\"time\":\"${STARTUP_TS}\"}"

export MEITHEAL_LOG_CATEGORIES="$(bashio::config 'log_categories | join(",")')"
export MEITHEAL_LOG_LEVEL="$(bashio::config 'log_level')"
export MEITHEAL_LOG_REDACTION="$(bashio::config 'log_redaction')"
export MEITHEAL_AUDIT_ENABLED="$(bashio::config 'audit_enabled')"
export LOKI_URL="$(bashio::config 'loki_url')"
export MEITHEAL_LICENSE_KEY="$(bashio::config 'license_key' '')"

# Transfer App files in fresh and restored Supervisor volumes before dropping
# privileges. Retry any remaining entries on the next start after a failure.
mkdir -p /data
if ! find /data -xdev -path /data/options.json -prune -o \
    \( ! -user meitheal -o ! -group meitheal \) -exec chown -h meitheal:meitheal {} +; then
  echo "Could not prepare /data for the meitheal service account" >&2
  exit 1
fi

export MEITHEAL_DB_URL="${MEITHEAL_DB_URL:-file:/data/meitheal.db}"

# Prefer Supervisor credentials for direct Home Assistant service calls.
if [ -n "${SUPERVISOR_TOKEN:-}" ]; then
  export HA_BASE_URL="${HA_BASE_URL:-http://supervisor/core}"
  export HA_TOKEN="${HA_TOKEN:-$SUPERVISOR_TOKEN}"

  # ── Query addon self-info from Supervisor API ──
  # We cache the full JSON response here and reuse it for:
  #   1. Ingress path discovery
  #   2. Addon hostname for integration discovery
  ADDON_SELF_INFO=$(curl -fsS -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
    http://supervisor/addons/self/info 2>/dev/null || true)

  # ── Discover ingress path ──
  # HA Supervisor is supposed to inject X-Ingress-Path on proxied requests,
  # but some versions/configurations don't. Query the API to get the definitive
  # ingress URL and export it so serve.mjs can inject the header on every request.
  if [ -n "${ADDON_SELF_INFO:-}" ]; then
    INGRESS_URL=$(echo "${ADDON_SELF_INFO}" \
      | grep -o '"ingress_url":"[^"]*"' \
      | head -1 \
      | sed 's/"ingress_url":"\(.*\)"/\1/' || true)
  else
    INGRESS_URL=""
  fi
  if [ -n "${INGRESS_URL:-}" ]; then
    export INGRESS_PATH="${INGRESS_URL}"
    echo "{\"event\":\"ingress.path.discovered\",\"time\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}"
  else
    echo "{\"event\":\"ingress.path.discovery.failed\",\"time\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}" >&2
  fi

  # ── Discover addon hostname ──
  # Supervisor names addon containers as {REPO}_{SLUG}:
  #   - local_meitheal for locally-installed addons
  #   - {hash}_meitheal for GitHub-installed addons (hash from repo URL)
  # The hostname field in /addons/self/info gives the DNS-resolvable name.
  # IMPORTANT: Docker DNS resolves HYPHENS, not underscores. We must
  # convert the hostname before using it for discovery or connection tests.
  if [ -n "${ADDON_SELF_INFO:-}" ]; then
    ADDON_HOSTNAME_RAW=$(echo "${ADDON_SELF_INFO}" \
      | grep -o '"hostname":"[^"]*"' \
      | head -1 \
      | sed 's/"hostname":"\(.*\)"/\1/' || true)
  else
    ADDON_HOSTNAME_RAW=""
  fi
  if [ -z "${ADDON_HOSTNAME_RAW}" ]; then
    ADDON_HOSTNAME_RAW="local_meitheal"
  fi
  # Convert underscores to hyphens for Docker DNS resolution
  ADDON_HOSTNAME=$(echo "${ADDON_HOSTNAME_RAW}" | tr '_' '-')
  echo "{\"event\":\"addon.hostname.discovered\",\"hostname_raw\":\"${ADDON_HOSTNAME_RAW}\",\"hostname\":\"${ADDON_HOSTNAME}\",\"time\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}"
fi

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-3000}"
apply_resolved_node_options
HEALTHCHECK_URL="http://127.0.0.1:${PORT}/api/health"

if [ -f /opt/meitheal/apps/web/package.json ]; then
  (
    cd /opt/meitheal/apps/web
    export HOME=/data
    s6-setuidgid meitheal node scripts/migrate.mjs || {
      exit_code=$?
      echo "Database migration failed: 'node scripts/migrate.mjs' exited with ${exit_code}" >&2
      exit "${exit_code}"
    }
    export MEITHEAL_STARTUP_BACKUP_HANDLED=1
    if [ ! -f dist/server/entry.mjs ]; then
      echo "Missing Astro server entry at dist/server/entry.mjs"
      exit 1
    fi
    echo "{\"event\":\"web.starting\",\"host\":\"${HOST}\",\"port\":\"${PORT}\",\"time\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}"
    # Use ingress-safe wrapper to normalize double slashes from HA Supervisor
    # before they reach Astro's routing layer (prevents 301 redirect loop).
    if [ -f scripts/serve.mjs ]; then
      exec s6-setuidgid meitheal node scripts/serve.mjs
    else
      exec s6-setuidgid meitheal node dist/server/entry.mjs
    fi
  ) &
  WEB_PID=$!

  for attempt in $(seq 1 45); do
    if ! kill -0 "${WEB_PID}" 2>/dev/null; then
      echo "Meitheal web process (${WEB_PID}) exited prematurely during startup (attempt ${attempt})" >&2
      exit 1
    fi
    if curl -fsS "${HEALTHCHECK_URL}" >/dev/null 2>&1; then
      echo "{\"event\":\"healthcheck.passed\",\"attempt\":${attempt},\"time\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}"
      break
    fi
    if [ "${attempt}" -eq 45 ]; then
      echo "Meitheal startup healthcheck did not pass after ${attempt} attempts" >&2
      exit 1
    fi
    sleep 1
  done

  # ── Auto-register integration via Supervisor Discovery ──
  # Tells HA Supervisor this addon provides the "meitheal" service.
  # HA Core will trigger async_step_hassio() in the custom component's
  # config flow when the optional Core integration is installed.
  # The user supplies the scoped API token in the discovery form.
  # The Supervisor deduplicates these calls, so it's safe every boot.
  #
  # The integration provides the to-do entity, task sensors and actions.
  # Home Assistant controls whether the entity is exposed to Assist.
  if [ -n "${SUPERVISOR_TOKEN:-}" ]; then
    DISCOVERY_PAYLOAD="{\"service\":\"meitheal\",\"config\":{\"host\":\"${ADDON_HOSTNAME:-local-meitheal}\",\"port\":${PORT}}}"
    DISC_SUCCESS=false
    for disc_attempt in 1 2 3; do
      DISC_RESULT=$(curl -fsS -X POST \
        -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "${DISCOVERY_PAYLOAD}" \
        http://supervisor/discovery 2>/dev/null || true)
      if [ -n "${DISC_RESULT}" ]; then
        DISC_UUID=$(echo "${DISC_RESULT}" | grep -o '"uuid":"[^"]*"' | head -1 | sed 's/"uuid":"\(.*\)"/\1/' || true)
        echo "{\"event\":\"discovery.registered\",\"uuid\":\"${DISC_UUID:-unknown}\",\"host\":\"${ADDON_HOSTNAME:-local-meitheal}\",\"port\":${PORT},\"attempt\":${disc_attempt},\"time\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}"
        DISC_SUCCESS=true
        break
      fi
      echo "{\"event\":\"discovery.registration.retry\",\"attempt\":${disc_attempt},\"time\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}" >&2
      sleep 5
    done
    if [ "${DISC_SUCCESS}" != "true" ]; then
      echo "{\"event\":\"discovery.registration.failed\",\"attempts\":3,\"time\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}" >&2
    fi
  fi
fi

# Placeholder for Alloy sidecar integration path.
# In production add-on packaging, run alloy with config below.
if [ -f /opt/meitheal/meitheal-hub/rootfs/etc/alloy/config.river ]; then
  echo "Alloy config present at /opt/meitheal/meitheal-hub/rootfs/etc/alloy/config.river"
fi

# ── Graceful shutdown ──
# HA Supervisor sends SIGTERM on addon stop/restart. Trap it to
# gracefully terminate the Node process and allow in-flight requests
# to complete (up to 10s timeout).
graceful_shutdown() {
  echo "{\"event\":\"addon.stopping\",\"signal\":\"$1\",\"time\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}"
  if [ -n "${WEB_PID:-}" ] && kill -0 "${WEB_PID}" 2>/dev/null; then
    kill -TERM "${WEB_PID}" 2>/dev/null || true
    # Wait up to 10s for graceful exit
    for i in $(seq 1 10); do
      if ! kill -0 "${WEB_PID}" 2>/dev/null; then
        echo "{\"event\":\"addon.stopped\",\"graceful\":true,\"time\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}"
        exit 0
      fi
      sleep 1
    done
    # Force kill after 10s
    kill -9 "${WEB_PID}" 2>/dev/null || true
    echo "{\"event\":\"addon.stopped\",\"graceful\":false,\"reason\":\"force_kill_after_10s\",\"time\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}"
  fi
  exit 0
}

trap 'graceful_shutdown SIGTERM' SIGTERM
trap 'graceful_shutdown SIGINT' SIGINT

wait -n
