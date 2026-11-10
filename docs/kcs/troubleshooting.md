---
type: "Runbook"
title: "Troubleshooting"
description: "Diagnose common connection, search, and sync problems."
---

# Troubleshooting

## Common Issues

### Universal Search Hub

**Symptoms**: `Cmd/Ctrl+K` does nothing, the topbar launcher feels empty, or search is missing settings/views/actions results.

**Fix**:

1. Make sure the page has fully loaded, then click the topbar search field once to open the shared search hub.
2. Use the scope chips (`All`, `Tasks`, `Views`, `Settings`, `Actions`) to narrow results before assuming the item is missing.
3. For task-only misses, enable the field toggles you need (`IDs`, `Labels`, `Custom fields`, `Comments`) and decide whether `Completed` or `Archived` should be included.
4. See `docs/kcs/search-hub-guide.md` for the full search behavior and Home Assistant parity notes.

### Settings Shell Navigation

**Symptoms**: A setting feels hard to find, a companion reopen flow is unclear, or a Settings cross-link lands somewhere unexpected.

**Fix**:

1. Open the top bar search from Settings to find a field by name.
2. Use `Settings → App & PWA` for companion URL handler and x-callback actions.
3. See `docs/kcs/settings-troubleshooting.md` for the Settings-specific runbook.

### Restore an inline helper

Dismissed helpers stay hidden on reload. Press `?` outside a text field to restore them. Use **Toggle helper** to expand or collapse the explanation without dismissing it.

### IDB Quota Exceeded

**Symptoms**: Tasks fail to save locally, "QuotaExceededError" in console.

**Fix**:

1. Open DevTools → Application → Storage → Clear site data
2. Or delete the `meitheal-offline` database from IndexedDB directly
3. Monitor IDB usage in DevTools → Application → IndexedDB

### Service Worker Cache Stale

**Symptoms**: App shows old version, changes don't appear after deploy.

**Fix**:

1. Check for SW update prompt in the UI — accept it
2. Force update: DevTools → Application → Service Workers → Update
3. Hard refresh: Ctrl+Shift+R (clears SW cache)
4. Nuclear option: Unregister all service workers in DevTools

### HA Connection Timeout

**Symptoms**: Settings page shows "Connection failed" for Home Assistant.

**Fix**:

1. Verify the add-on is running in HA → Add-ons → Meitheal Hub
2. Check `SUPERVISOR_TOKEN` is available: inspect add-on logs for `Missing SUPERVISOR_TOKEN`
3. Test manually: `curl -s -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/core/api/config`
4. Verify `config.yaml` has `homeassistant_api: true` and `hassio_api: true`

### HA Panel Opens Home Assistant UI Inside the Add-on Iframe

**Symptoms**: Opening `/app/868b2fee_meitheal` loads the HA dashboard inside the iframe ("double UI" effect) or immediately leaves the add-on route.

**Fix**:

1. Update to add-on version `0.2.5` or newer.
2. In Home Assistant: Add-ons → Meitheal → **Check for updates** → **Update** → **Restart**.
3. Hard refresh the HA frontend tab (`Ctrl+Shift+R`) to clear stale client router state.
4. Check add-on logs for `ingress.path.missing` warnings:
   this indicates Supervisor-token ingress fallback was used when `x-ingress-path` was unavailable.
5. Re-open from the sidebar and verify URL stays under `/app/868b2fee_meitheal`.

### Custom Component Cannot Reach Add-on Hostname After Upgrade

**Symptoms**: Integration setup fails with host resolution errors after moving from legacy installs.

**Fix**:

1. Use `local_meitheal` as the default hostname for new setup.
2. If your environment still uses legacy naming, `local_meitheal_hub` is tried automatically.
3. If needed, set host manually in the config flow and verify `http://<host>:3000/api/health` responds with `200`.

### Sync Queue Stuck

**Symptoms**: "Pending" indicator never clears, tasks don't sync.

**Fix**:

1. Check connectivity indicator in sidebar — must show "Online"
2. Open DevTools → Console → Look for `[sync-engine]` messages
3. If max retries exceeded: clear site data to reset the queue
4. Force sync: navigate to any page while online

### Task Create API Returns 400

**Symptoms**: Create task button does nothing, or shows error toast.

**Fix**:

1. Check browser console for the specific 400 error message
2. Most common: `title is required` — empty title field
3. Verify API is healthy: `GET /api/health` should return 200

### Offline Page Showing When Online

**Symptoms**: App shows offline fallback page despite having internet.

**Fix**:

1. Health check endpoint `/api/health` may be failing — check server logs
2. The connectivity monitor debounces state transitions by 2 seconds — wait briefly
3. Check if a VPN or proxy is blocking the health check request
