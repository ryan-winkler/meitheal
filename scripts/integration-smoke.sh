#!/usr/bin/env bash
# Meitheal — Integration Smoke Test
#
# Validates that all integration services are reachable and HA components
# are loaded. Run inside the devcontainer or against a running compose stack.
#
# Usage: bash scripts/integration-smoke.sh [--ci]
#   --ci  Exit with non-zero on any failure (for CI pipelines)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEVCONTAINER_ENV_FILE="$PROJECT_ROOT/.devcontainer/.env"
DEVCONTAINER_ENV_LOCAL_FILE="$PROJECT_ROOT/.devcontainer/.env.local"

load_env_file() {
  local env_file="$1"

  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
}

load_env_file "$DEVCONTAINER_ENV_FILE"
load_env_file "$DEVCONTAINER_ENV_LOCAL_FILE"

CI_MODE="${1:-}"
PASS=0
FAIL=0

BOLD="\033[1m"
GREEN="\033[0;32m"
RED="\033[0;31m"
YELLOW="\033[0;33m"
DIM="\033[2m"
RESET="\033[0m"

# ── Config — override via env vars ──
HA_URL="${HA_URL:-http://localhost:${HA_UI_PORT:-7123}}"
GROCY_URL="${GROCY_SMOKE_URL:-http://localhost:${GROCY_HOST_PORT:-9192}}"
NODERED_URL="${NODERED_SMOKE_URL:-http://localhost:${NODERED_HOST_PORT:-1880}}"
HA_TOKEN="${HA_TOKEN:-}"  # Set if HA onboarding is complete

check() {
  local label="$1"
  local url="$2"
  local expect_status="${3:-200}"

  local status
  status=$(curl -o /dev/null -s -w "%{http_code}" --max-time 5 "$url" 2>/dev/null || echo "000")

  if [ "$status" = "$expect_status" ]; then
    echo -e "  ${GREEN}✓${RESET} ${label}  ${DIM}(${status})${RESET}"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${RESET} ${label}  ${DIM}(got ${status}, expected ${expect_status})${RESET}"
    FAIL=$((FAIL + 1))
  fi
}

check_ha_component() {
  local component="$1"
  if [ -z "$HA_TOKEN" ]; then
    echo -e "  ${YELLOW}?${RESET} HA component: ${component}  ${DIM}(no HA_TOKEN — skipped)${RESET}"
    return
  fi

  local status
  status=$(curl -o /dev/null -s -w "%{http_code}" --max-time 5 \
    -H "Authorization: Bearer ${HA_TOKEN}" \
    "${HA_URL}/api/services/${component}" 2>/dev/null || echo "000")

  if [ "$status" = "200" ]; then
    echo -e "  ${GREEN}✓${RESET} HA component: ${component}  ${DIM}(loaded)${RESET}"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${RESET} HA component: ${component}  ${DIM}(${status})${RESET}"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  Meitheal — Integration Smoke Test${RESET}"
echo -e "${BOLD}═══════════════════════════════════════════════════════${RESET}"
echo ""

# ── Service reachability ──
echo -e "${BOLD}Services:${RESET}"
check "Home Assistant" "${HA_URL}/" "200"
check "Grocy API" "${GROCY_URL}/api/system/info" "200"
check "Node-RED" "${NODERED_URL}/" "200"
echo ""

# ── HA API (requires onboarding + token) ──
echo -e "${BOLD}HA API:${RESET}"
if [ -n "$HA_TOKEN" ]; then
  check "HA API /api/" "${HA_URL}/api/" "200"
else
  echo -e "  ${YELLOW}?${RESET} HA API  ${DIM}(no HA_TOKEN — set after onboarding)${RESET}"
fi
echo ""

# ── HA components ──
echo -e "${BOLD}HA Components:${RESET}"
check_ha_component "calendar"
check_ha_component "shopping_list"
check_ha_component "conversation"
check_ha_component "todo"
echo ""

# ── Summary ──
TOTAL=$((PASS + FAIL))
echo -e "${BOLD}Results: ${GREEN}${PASS} passed${RESET}, ${RED}${FAIL} failed${RESET} (${TOTAL} total)"
echo ""

if [ "$FAIL" -gt 0 ] && [ "$CI_MODE" = "--ci" ]; then
  exit 1
fi
