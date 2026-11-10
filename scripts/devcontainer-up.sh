#!/usr/bin/env bash
# Meitheal — Devcontainer CLI Launcher
#
# Starts or recovers the HA development stack without replacing editor containers.
# First creation uses the Dev Containers CLI so configured Features are applied.
#
# Usage:
#   ./scripts/devcontainer-up.sh          # Start stack
#   ./scripts/devcontainer-up.sh down     # Stop stack
#   ./scripts/devcontainer-up.sh status   # Show running containers
#   ./scripts/devcontainer-up.sh logs     # Tail HA logs
#
# Ports:
#   7123 → HA UI + API
#   7357 → Supervisor API
#   9192 → Grocy
#   1880 → Node-RED

set -euo pipefail

BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
RESET="\033[0m"

log()  { echo -e "${GREEN}[devcontainer]${RESET} $*"; }
warn() { echo -e "${YELLOW}[devcontainer]${RESET} $*"; }
err()  { echo -e "${RED}[devcontainer]${RESET} $*" >&2; }

# ── Resolve project root (works from any subdir) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/.devcontainer/docker-compose.yml"
DEVCONTAINER_ENV_FILE="$PROJECT_ROOT/.devcontainer/.env"
DEVCONTAINER_ENV_LOCAL_FILE="$PROJECT_ROOT/.devcontainer/.env.local"

load_env_file() {
  local env_file="$1"

  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
}

load_env_file "$DEVCONTAINER_ENV_FILE"
load_env_file "$DEVCONTAINER_ENV_LOCAL_FILE"

HA_UI_PORT="${HA_UI_PORT:-7123}"
HA_CORE_PORT="${HA_CORE_PORT:-80}"
HA_SUPERVISOR_PORT="${HA_SUPERVISOR_PORT:-7357}"
GROCY_HOST_PORT="${GROCY_HOST_PORT:-9192}"
NODERED_HOST_PORT="${NODERED_HOST_PORT:-1880}"

# ── Find compose command ──
# Distrobox containers have a path mismatch (/var/home vs /home) that breaks
# local podman. When inside a distrobox, always delegate to the host.
find_compose() {
  # Inside distrobox? Delegate to host (avoids /var/home path mismatch)
  if [[ -n "${DISTROBOX_ENTER_PATH:-}" ]] && command -v flatpak-spawn &>/dev/null; then
    echo "flatpak-spawn --host podman-compose"
    return
  fi

  # On bare host — try local compose tools
  if command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
    echo "docker compose"
  elif command -v podman-compose &>/dev/null; then
    echo "podman-compose"
  elif command -v podman &>/dev/null && podman compose version &>/dev/null 2>&1; then
    echo "podman compose"
  else
    err "No compose tool found. Install podman-compose:"
    err "  pip install podman-compose"
    err "  # or: brew install podman-compose"
    exit 1
  fi
}

COMPOSE_CMD=$(find_compose)
log "Using: ${BOLD}$COMPOSE_CMD${RESET}"
log "Project: $PROJECT_ROOT"

run_compose() {
  if [[ "$COMPOSE_CMD" == "flatpak-spawn --host podman-compose" ]]; then
    flatpak-spawn --host env \
      "TZ=${TZ:-Europe/Dublin}" \
      "NODE_RED_CREDENTIAL_SECRET=${NODE_RED_CREDENTIAL_SECRET:-dev-secret}" \
      "COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-meitheal-dev}" \
      "HA_UI_PORT=${HA_UI_PORT}" \
      "HA_CORE_PORT=${HA_CORE_PORT}" \
      "HA_SUPERVISOR_PORT=${HA_SUPERVISOR_PORT}" \
      "GROCY_HOST_PORT=${GROCY_HOST_PORT}" \
      "NODERED_HOST_PORT=${NODERED_HOST_PORT}" \
      podman-compose -f "$COMPOSE_FILE" "$@"
    return
  fi

  $COMPOSE_CMD -f "$COMPOSE_FILE" "$@"
}

start_stack() {
  local existing
  if [[ "$COMPOSE_CMD" == *podman* ]]; then
    # podman-compose 1.x lists stopped containers, but accepts no service filter.
    existing=""
    local container service
    for container in $(run_compose ps -q); do
      if [[ "$COMPOSE_CMD" == "flatpak-spawn --host podman-compose" ]]; then
        service=$(flatpak-spawn --host podman inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container")
      else
        service=$(podman inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container")
      fi
      if [[ "$service" == ha-devcontainer ]]; then existing="$container"; break; fi
    done
  else
    existing=$(run_compose ps --all --quiet ha-devcontainer)
  fi
  if [[ -n "$existing" ]]; then
    # Starting an existing container preserves its editor-generated image and Features.
    run_compose start ha-devcontainer
    run_compose exec -T ha-devcontainer sh -lc 'command -v node >/dev/null && command -v pnpm >/dev/null' || {
      err "The existing container is missing Node or pnpm. Rebuild it in the editor; this helper will not replace it."
      return 1
    }
    run_compose up -d --no-recreate grocy nodered
  elif command -v devcontainer &>/dev/null; then
    devcontainer up --workspace-folder "$PROJECT_ROOT"
  else
    err "Create the environment with Reopen in Container, or install the Dev Containers CLI and run this command again."
    return 1
  fi
}

# ── Commands ──
case "${1:-up}" in
  up|start)
    log "Starting HA devcontainer stack..."
    start_stack
    echo ""
    log "Stack is up! Access points:"
    echo -e "  ${BOLD}HA UI:${RESET}       http://localhost:${HA_UI_PORT}/"
    echo -e "  ${BOLD}Supervisor:${RESET}  http://localhost:${HA_SUPERVISOR_PORT}/"
    echo -e "  ${BOLD}Grocy:${RESET}       http://localhost:${GROCY_HOST_PORT}/"
    echo -e "  ${BOLD}Node-RED:${RESET}    http://localhost:${NODERED_HOST_PORT}/"
    echo ""
    log "Run ${BOLD}./scripts/devcontainer-up.sh logs${RESET} to tail HA logs"
    ;;
  down|stop)
    log "Stopping devcontainer stack..."
    run_compose down
    log "Stack stopped."
    ;;
  status|ps)
    run_compose ps
    ;;
  logs)
    run_compose logs -f --tail=50 ha-devcontainer
    ;;
  restart)
    log "Restarting devcontainer stack..."
    run_compose restart
    log "Stack restarted with its existing images."
    ;;
  *)
    echo "Usage: $0 {up|down|status|logs|restart}"
    exit 1
    ;;
esac
