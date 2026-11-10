#!/usr/bin/env bash
# Meitheal — Devcontainer Post-Create Setup
#
# Runs once when the devcontainer is created. Installs dependencies,
# waits for integration services, and configures Node-RED HA palette.
#
# Called by devcontainer.json postCreateCommand.
set -euo pipefail

BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
RESET="\033[0m"

log()  { echo -e "${GREEN}[setup]${RESET} $*"; }
warn() { echo -e "${YELLOW}[setup]${RESET} $*"; }
err()  { echo -e "${RED}[setup]${RESET} $*" >&2; }

# ── 1. Install Node/pnpm dependencies ──
log "Installing pnpm dependencies..."
if command -v pnpm &>/dev/null; then
  pnpm install --frozen-lockfile 2>&1 || pnpm install 2>&1
else
  npm install -g pnpm@10.8.0
  pnpm install --frozen-lockfile 2>&1 || pnpm install 2>&1
fi
log "Dependencies installed."

# ── 2. Wait for Grocy ──
GROCY_URL="${GROCY_URL:-http://grocy:80}"
log "Waiting for Grocy at ${GROCY_URL}..."
for i in $(seq 1 30); do
  if curl -fsS "${GROCY_URL}/api/system/info" >/dev/null 2>&1; then
    log "Grocy ready (attempt ${i})."
    break
  fi
  if [ "$i" -eq 30 ]; then
    warn "Grocy not reachable after 30 attempts — continuing without it."
  fi
  sleep 2
done

# ── 3. Wait for Node-RED ──
NODERED_URL="${NODERED_URL:-http://nodered:1880}"
log "Waiting for Node-RED at ${NODERED_URL}..."
for i in $(seq 1 20); do
  if curl -fsS "${NODERED_URL}/" >/dev/null 2>&1; then
    log "Node-RED ready (attempt ${i})."
    break
  fi
  if [ "$i" -eq 20 ]; then
    warn "Node-RED not reachable after 20 attempts — continuing without it."
  fi
  sleep 2
done

# ── 4. Install HA WebSocket palette in Node-RED ──
log "Installing node-red-contrib-home-assistant-websocket in Node-RED..."
# Use Node-RED admin API to install the palette
INSTALL_PAYLOAD='{"module":"node-red-contrib-home-assistant-websocket"}'
INSTALL_RESULT=$(curl -fsS -X POST \
  -H "Content-Type: application/json" \
  -d "${INSTALL_PAYLOAD}" \
  "${NODERED_URL}/nodes" 2>/dev/null || true)

if [ -n "${INSTALL_RESULT}" ]; then
  log "HA WebSocket palette installed in Node-RED."
else
  warn "Could not install HA palette via API — install manually from Node-RED editor."
fi

# ── 5. Print status ──
echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  Meitheal Dev Environment — Service Status${RESET}"
echo -e "${BOLD}═══════════════════════════════════════════════════════${RESET}"
echo ""

check_service() {
  local name="$1"
  local url="$2"
  local port="$3"
  if curl -fsS "$url" >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${RESET} ${name}  →  localhost:${port}"
  else
    echo -e "  ${RED}✗${RESET} ${name}  →  localhost:${port} (unreachable)"
  fi
}

check_service "Home Assistant" "http://localhost:7123/" "7123"
check_service "Grocy" "${GROCY_URL}/" "9192"
check_service "Node-RED" "${NODERED_URL}/" "1880"

echo ""
echo -e "${BOLD}Integration Docs:${RESET}"
echo "  • Grocy API:       https://github.com/hassio-addons/addon-grocy"
echo "  • Node-RED HA:     https://github.com/zachowj/node-red-contrib-home-assistant-websocket"
echo "  • HACS:            https://hacs.xyz/docs/use/"
echo "  • HA Calendar:     https://www.home-assistant.io/integrations/calendar/"
echo "  • HA Shopping List: https://www.home-assistant.io/integrations/shopping_list"
echo "  • HA Conversation: https://www.home-assistant.io/integrations/conversation/"
echo ""
echo -e "${BOLD}Quick commands:${RESET}"
echo "  pnpm --filter @meitheal/web dev    # Start Astro dev server"
echo "  bash scripts/integration-smoke.sh  # Smoke-test all services"
echo ""
