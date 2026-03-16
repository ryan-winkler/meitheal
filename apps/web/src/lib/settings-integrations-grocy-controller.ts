/**
 * Grocy integration settings controller.
 *
 * Handles: Grocy save, auto-key, test connection, sync now,
 * and hydration of Grocy status on load.
 */
import { pageLifecycle } from "@lib/page-lifecycle"
import { escapeHtml } from "@lib/safe-html"
import { showToast } from "@lib/toast"
import { saveSetting, log } from "@lib/settings-utils"

export function initGrocySettings(): void {
  // Auto-key generation
  const autoKeyBtn = document.getElementById("grocy-auto-key")
  if (autoKeyBtn) {
    pageLifecycle.on(autoKeyBtn, "click", async () => {
    const btn = document.getElementById("grocy-auto-key") as HTMLButtonElement
    const origText = btn.textContent
    btn.disabled = true
    btn.textContent = "…"
    try {
      const urlInput = document.getElementById("grocy-url") as HTMLInputElement
      const keyInput = document.getElementById("grocy-key") as HTMLInputElement
      const body: Record<string, string> = {}
      if (urlInput?.value?.trim()) body.url = urlInput.value.trim()
      const res = await fetch((window.__ingress_path || "") + "/api/grocy/auto-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: pageLifecycle.signal,
      })
      const data = await res.json()
      if (data.ok) {
        if (keyInput) keyInput.placeholder = data.apiKey || "••••"
        if (urlInput && data.url) urlInput.value = data.url
        showToast("API key generated and saved", "success")
      } else {
        showToast(data.error || "Auto-key failed", "error")
      }
    } catch {
      showToast("Failed to auto-generate key", "error")
    } finally {
      btn.disabled = false
      btn.textContent = origText
    }
    })
  }

  // Save Grocy settings
  const saveGrocyBtn = document.getElementById("save-grocy")
  if (saveGrocyBtn) {
    pageLifecycle.on(saveGrocyBtn, "click", async () => {
    const url = (document.getElementById("grocy-url") as HTMLInputElement).value
    const key = (document.getElementById("grocy-key") as HTMLInputElement).value
    const syncMode = (document.getElementById("grocy-sync-mode") as HTMLSelectElement).value
    const syncInterval = (document.getElementById("grocy-sync-interval") as HTMLSelectElement).value

    const grocyAutoDetected = document.getElementById("grocy-auto-info")
    const isAutoDetected = grocyAutoDetected && grocyAutoDetected.style.display !== "none"
    if (!url && !isAutoDetected) {
      showToast("settings.grocy_required", "error")
      const urlInput = document.getElementById("grocy-url")
      urlInput?.classList.add("form-input--error")
      urlInput?.addEventListener("input", () => urlInput.classList.remove("form-input--error"), { once: true })
      return
    }
    if (url) {
      try { new URL(url) } catch {
        showToast("Please enter a valid URL", "error")
        const urlInput = document.getElementById("grocy-url")
        urlInput?.classList.add("form-input--error")
        urlInput?.addEventListener("input", () => urlInput.classList.remove("form-input--error"), { once: true })
        return
      }
    }

    const btn = document.getElementById("save-grocy") as HTMLButtonElement
    btn.textContent = "Saving..."
    btn.disabled = true
    try {
      const payload: Record<string, unknown> = {
        grocy_sync_mode: syncMode,
        grocy_sync_interval: Number(syncInterval),
        grocy_sync_enabled: true,
      }
      if (url) payload.grocy_url = url
      if (key) payload.grocy_api_key = key
      const res = await fetch((window.__ingress_path || "") + "/api/grocy/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: pageLifecycle.signal,
      })
      const data = await res.json()
      if (data.ok) {
        const statusEl = document.getElementById("grocy-status")
        if (statusEl) { statusEl.textContent = "Configured"; statusEl.className = "badge badge-active" }
        const syncBtn = document.getElementById("sync-grocy-now")
        if (syncBtn) syncBtn.style.display = ""
        showToast("Grocy settings saved")
      } else {
        showToast(data.error || "Failed to save Grocy settings", "error")
      }
    } catch {
      showToast("Failed to save Grocy settings", "error")
    }
    btn.textContent = "Save Grocy Settings"
    btn.disabled = false
    })
  }

  // Test Connection
  const testGrocyBtn = document.getElementById("test-grocy")
  if (testGrocyBtn) {
    pageLifecycle.on(testGrocyBtn, "click", async () => {
    const url = (document.getElementById("grocy-url") as HTMLInputElement).value
    const key = (document.getElementById("grocy-key") as HTMLInputElement).value
    const resultEl = document.getElementById("grocy-test-result")
    const btn = document.getElementById("test-grocy") as HTMLButtonElement
    const grocyAutoDetected = document.getElementById("grocy-auto-info")
    const isAutoDetected = grocyAutoDetected && grocyAutoDetected.style.display !== "none"
    if (!isAutoDetected && (!url || !key)) {
      if (resultEl) {
        resultEl.style.display = "block"
        resultEl.className = "integration-callout integration-callout--warning"
        resultEl.innerHTML = "<strong>⚠ URL and API key required</strong>"
      }
      return
    }
    btn.textContent = "Testing..."
    btn.disabled = true
    try {
      const res = await fetch((window.__ingress_path || "") + "/api/grocy/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url || undefined, api_key: key || undefined, auto_detected: isAutoDetected || false }),
        signal: pageLifecycle.signal,
      })
      const data = await res.json()
      if (resultEl) {
        resultEl.style.display = "block"
        if (data.ok) {
          resultEl.className = "integration-callout integration-callout--success"
          resultEl.innerHTML = `<strong>✓ Connected to Grocy ${escapeHtml(data.version)}</strong><div class="integration-callout__detail">${escapeHtml(data.counts.chores)} chore${data.counts.chores !== 1 ? "s" : ""} · ${escapeHtml(data.counts.tasks)} task${data.counts.tasks !== 1 ? "s" : ""} · ${escapeHtml(data.counts.shoppingItems)} shopping item${data.counts.shoppingItems !== 1 ? "s" : ""}</div>`
        } else {
          resultEl.className = "integration-callout integration-callout--warning"
          resultEl.innerHTML = `<strong>✗ Connection failed</strong><div class="integration-callout__detail">${escapeHtml(data.error || "Unknown error")}</div>`
        }
      }
    } catch (err) {
      if (resultEl) {
        resultEl.style.display = "block"
        resultEl.className = "integration-callout integration-callout--warning"
        resultEl.innerHTML = `<strong>✗ Network error</strong><div class="integration-callout__detail">${escapeHtml(err instanceof Error ? err.message : "Unknown")}</div>`
      }
    }
    btn.textContent = "Test Connection"
    btn.disabled = false
    })
  }

  // Sync Now
  const syncGrocyBtn = document.getElementById("sync-grocy-now")
  if (syncGrocyBtn) {
    pageLifecycle.on(syncGrocyBtn, "click", async () => {
    const btn = document.getElementById("sync-grocy-now") as HTMLButtonElement
    btn.textContent = "Syncing..."
    btn.disabled = true
    try {
      const syncMode = (document.getElementById("grocy-sync-mode") as HTMLSelectElement).value
      const syncInterval = (document.getElementById("grocy-sync-interval") as HTMLSelectElement).value
      const res = await fetch((window.__ingress_path || "") + "/api/grocy/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "sync", sync_mode: syncMode, interval_ms: Number(syncInterval) }),
        signal: pageLifecycle.signal,
      })
      const data = await res.json()
      if (data.ok) {
        showToast(data.message || "Grocy sync complete")
        const lastSyncedEl = document.getElementById("grocy-last-synced")
        const itemCountEl = document.getElementById("grocy-item-count")
        const syncInfoEl = document.getElementById("grocy-sync-info")
        if (syncInfoEl) syncInfoEl.style.display = ""
        if (lastSyncedEl) lastSyncedEl.textContent = `Last synced: ${new Date().toLocaleTimeString()}`
        if (itemCountEl && data.status) {
          const total = (data.status.choreCount || 0) + (data.status.taskCount || 0) + (data.status.shoppingCount || 0)
          itemCountEl.textContent = `${total} item${total !== 1 ? "s" : ""}`
        }
        const statusEl = document.getElementById("grocy-status")
        if (statusEl) {
          const total = (data.chores || 0) + (data.tasks || 0) + (data.shopping || 0)
          statusEl.textContent = total > 0 ? `Active (${total})` : "Active"
          statusEl.className = "badge badge-active"
        }
      } else {
        showToast(data.error || "Grocy sync failed", "error")
      }
    } catch {
      showToast("Grocy sync failed", "error")
    }
    btn.textContent = "Sync Now"
    btn.disabled = false
    })
  }

  // Hydrate on load
  hydrateGrocyStatus()
}

async function hydrateGrocyStatus() {
  try {
    const res = await fetch((window.__ingress_path || "") + "/api/grocy/settings", { signal: pageLifecycle.signal })
    if (!res.ok) return
    const data = await res.json()
    const s = data.settings || {}
    if (s.grocy_url) (document.getElementById("grocy-url") as HTMLInputElement).value = s.grocy_url
    if (s.grocy_api_key_set) (document.getElementById("grocy-key") as HTMLInputElement).placeholder = s.grocy_api_key_masked || "••••"
    if (s.grocy_sync_mode) (document.getElementById("grocy-sync-mode") as HTMLSelectElement).value = s.grocy_sync_mode
    if (s.grocy_sync_interval !== undefined) (document.getElementById("grocy-sync-interval") as HTMLSelectElement).value = String(s.grocy_sync_interval)
    if (s.grocy_url || s.grocy_api_key_set) {
      const statusEl = document.getElementById("grocy-status")
      if (statusEl) { statusEl.textContent = "Configured"; statusEl.className = "badge badge-active" }
      const syncBtn = document.getElementById("sync-grocy-now")
      if (syncBtn) syncBtn.style.display = ""
      const openLink = document.getElementById("open-grocy-link") as HTMLAnchorElement | null
      if (openLink && s.grocy_url) { openLink.href = String(s.grocy_url); openLink.style.display = "" }
    }
    const syncRes = await fetch((window.__ingress_path || "") + "/api/grocy/sync", { signal: pageLifecycle.signal })
    if (syncRes.ok) {
      const syncData = await syncRes.json()
      const sync = syncData.sync
      if (sync?.active) {
        const statusEl = document.getElementById("grocy-status")
        if (statusEl) {
          statusEl.textContent = sync.itemCount > 0 ? `Active (${sync.itemCount})` : "Active"
          statusEl.className = "badge badge-active"
          if (sync.choreCount !== undefined) statusEl.title = `${sync.choreCount} chores · ${sync.taskCount} tasks · ${sync.shoppingCount} shopping`
        }
      }
      if (sync?.lastSyncAt) {
        const syncInfoEl = document.getElementById("grocy-sync-info")
        const lastSyncedEl = document.getElementById("grocy-last-synced")
        const itemCountEl = document.getElementById("grocy-item-count")
        if (syncInfoEl) syncInfoEl.style.display = ""
        if (lastSyncedEl) {
          const ts = new Date(sync.lastSyncAt).toLocaleTimeString()
          if (sync.lastSyncError) {
            lastSyncedEl.textContent = `⚠ ${sync.lastSyncError} — last sync: ${ts}`
            lastSyncedEl.style.color = "var(--danger, #e74c3c)"
            const statusEl = document.getElementById("grocy-status")
            if (statusEl) { statusEl.textContent = "Sync Error"; statusEl.className = "badge badge-error" }
          } else {
            lastSyncedEl.textContent = `Last synced: ${ts}`
            lastSyncedEl.style.color = ""
          }
        }
        if (itemCountEl) {
          if (sync.choreCount !== undefined && (sync.choreCount > 0 || sync.taskCount > 0 || sync.shoppingCount > 0)) {
            const parts: string[] = []
            if (sync.choreCount > 0) parts.push(`${sync.choreCount} chore${sync.choreCount !== 1 ? "s" : ""}`)
            if (sync.taskCount > 0) parts.push(`${sync.taskCount} task${sync.taskCount !== 1 ? "s" : ""}`)
            if (sync.shoppingCount > 0) parts.push(`${sync.shoppingCount} shopping`)
            itemCountEl.textContent = parts.join(" · ") || `${sync.itemCount} items`
          } else {
            itemCountEl.textContent = `${sync.itemCount} item${sync.itemCount !== 1 ? "s" : ""}`
          }
        }
      }
    }
  } catch { /* silently fail */ }
}
