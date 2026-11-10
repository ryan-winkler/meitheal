#!/usr/bin/env bash
# Meitheal — Pre-flight Port Check
#
# Checks if required devcontainer ports are free before starting.
# Run from the HOST machine (not inside the container).
#
# Usage: bash scripts/preflight-check.sh
set -euo pipefail

BOLD="\033[1m"
GREEN="\033[0;32m"
RED="\033[0;31m"
YELLOW="\033[0;33m"
RESET="\033[0m"

PORTS=(7123 7357 9192 1880)
LABELS=("Home Assistant" "HA Supervisor API" "Grocy" "Node-RED")

echo ""
echo -e "${BOLD}Meitheal — Pre-flight Port Check${RESET}"
echo ""

BLOCKED=0

for i in "${!PORTS[@]}"; do
  PORT="${PORTS[$i]}"
  LABEL="${LABELS[$i]}"

  if ss -tlnp 2>/dev/null | grep -q ":${PORT} " || \
     lsof -i ":${PORT}" >/dev/null 2>&1; then
    echo -e "  ${RED}✗${RESET} Port ${PORT} (${LABEL}) — ${RED}IN USE${RESET}"
    # Try to identify what's using it
    PID_INFO=$(ss -tlnp 2>/dev/null | grep ":${PORT} " | head -1 || true)
    if [ -n "$PID_INFO" ]; then
      echo -e "    ${YELLOW}→ ${PID_INFO}${RESET}"
    fi
    BLOCKED=$((BLOCKED + 1))
  else
    echo -e "  ${GREEN}✓${RESET} Port ${PORT} (${LABEL}) — free"
  fi
done

echo ""

if [ "$BLOCKED" -gt 0 ]; then
  echo -e "${RED}${BLOCKED} port(s) blocked.${RESET} Free them before starting the devcontainer."
  echo ""
  echo "Common fixes:"
  echo "  • Stop local HA:       sudo systemctl stop home-assistant"
  echo "  • Stop local Node-RED: sudo systemctl stop nodered"
  echo "  • Kill by port:        fuser -k PORT/tcp"
  echo ""
  exit 1
else
  echo -e "${GREEN}All ports free — ready to start devcontainer.${RESET}"
  echo ""
fi
