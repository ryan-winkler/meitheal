#!/usr/bin/with-contenv bashio
# Meitheal Supervisor Post-Backup Script
#
# Called by HA Supervisor AFTER snapshot of /data completes.
# Acknowledges completion; checkpoint preparation does not pause normal IO.
#
# @see https://developers.home-assistant.io/docs/add-ons/configuration#optional-configuration-options

set -euo pipefail

BACKUP_URL="http://127.0.0.1:${PORT:-3000}/api/backup/complete"

echo "{\"event\":\"backup.post.start\",\"time\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}"

RESULT=$(curl -fsS -X POST -m 10 "${BACKUP_URL}" 2>/dev/null || true)

if echo "${RESULT}" | grep -q '"ok":true'; then
  echo "{\"event\":\"backup.post.ok\",\"time\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}"
else
  # Non-fatal: addon is already running normally
  echo "{\"event\":\"backup.post.info\",\"message\":\"Post-backup signal not acknowledged\",\"time\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}"
fi
