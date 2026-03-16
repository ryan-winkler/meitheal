/**
 * HA connection & webhook integration settings controller.
 *
 * Handles: HA connection test, HA standalone form save,
 * webhook save/test, n8n mode tabs, expand integration cards.
 */
import { pageLifecycle } from "@lib/page-lifecycle"
import { escapeHtml } from "@lib/safe-html"
import { showToast } from "@lib/toast"
import { saveSetting, log } from "@lib/settings-utils"

/** Shared helper: read entity value from EntitySelector (handles select OR manual input) */
export function readEntityValue(id: string): string {
  const select = document.getElementById(id) as HTMLSelectElement | null
  const manual = document.getElementById(`${id}-manual`) as HTMLInputElement | null
  if (select && select.style.display !== "none" && select.value) return select.value
  if (manual && manual.value) return manual.value
  return select?.value || manual?.value || ""
}

export function initHASettings(): void {
  // Test HA connection
  const testConnBtn = document.getElementById("test-connection")
  if (testConnBtn) {
    pageLifecycle.on(testConnBtn, "click", async () => {
    const statusEl = document.getElementById("ha-status")
    if (statusEl) statusEl.innerHTML = '<span style="color: var(--accent);">Testing HA connection...</span>'
    try {
      const res = await fetch((window.__ingress_path || "") + "/api/ha/connection", { signal: pageLifecycle.signal })
      const data = (await res.json()) as Record<string, unknown>
      if (statusEl) {
        if (data.connected) {
          const comps = Array.isArray(data.components) ? (data.components as string[]) : []
          const SHOW_LIMIT = 5
          const compId = `ha-comp-list-${Date.now()}`
          let compHtml = ""
          if (comps.length > 0) {
            const preview = comps.slice(0, SHOW_LIMIT)
            const remaining = comps.length - SHOW_LIMIT
            compHtml = `<div style="margin-top: 8px; padding: 10px 12px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; max-width: 100%; overflow: hidden;">
              <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); font-weight: 600; margin-bottom: 6px;">Components (${comps.length})</div>
              <div style="display: flex; flex-wrap: wrap; gap: 4px;">
                ${preview.map((c) => `<span style="font-family: 'JetBrains Mono', monospace; font-size: 11px; padding: 2px 6px; background: var(--bg-primary); border: 1px solid var(--border); border-radius: 4px; color: var(--text-secondary);">${escapeHtml(c)}</span>`).join("")}
              </div>
              ${remaining > 0 ? `<button type="button" onclick="const el=document.getElementById('${compId}');if(el){el.style.display=el.style.display==='none'?'flex':'none';this.textContent=el.style.display==='none'?'Show all ${comps.length}':'Collapse'}" style="margin-top: 6px; font-size: 11px; color: var(--accent); background: none; border: none; cursor: pointer; padding: 0;">Show all ${comps.length}</button><div id="${compId}" style="display: none; flex-wrap: wrap; gap: 4px; margin-top: 4px;">${comps.slice(SHOW_LIMIT).map((c) => `<span style="font-family: 'JetBrains Mono', monospace; font-size: 11px; padding: 2px 6px; background: var(--bg-primary); border: 1px solid var(--border); border-radius: 4px; color: var(--text-secondary);">${escapeHtml(c)}</span>`).join("")}</div>` : ""}
            </div>`
          }
          statusEl.innerHTML =
            `<span style="color: var(--accent); font-weight: 500;">✓ Connected</span> <span style="color: var(--text-secondary);">HA ${escapeHtml(data.version)} (${escapeHtml(data.mode)})</span>` +
            `<div style="margin-top: 4px; font-size: 12px; color: var(--text-muted);">${escapeHtml(data.location_name)} · ${escapeHtml(data.time_zone)}</div>` +
            compHtml
        } else {
          statusEl.innerHTML =
            `<span style="color: var(--danger);">⚠ ${escapeHtml(data.message ?? "HA not reachable")}</span>` +
            `<br><small style="color: var(--text-muted);">Mode: ${escapeHtml(data.mode ?? "unknown")}</small>`
        }
      }
    } catch {
      if (statusEl) statusEl.innerHTML = '<span style="color: var(--danger);">Connection test failed</span>'
    }
    })
  }

  // Save HA settings (standalone mode only)
  const haForm = document.getElementById("ha-form")
  if (haForm) {
    pageLifecycle.on(haForm, "submit", async (e) => {
    e.preventDefault()
    const haUrl = (document.getElementById("ha-url") as HTMLInputElement).value
    const haToken = (document.getElementById("ha-token") as HTMLInputElement).value

    const saveBtn = document.getElementById("save-ha") as HTMLButtonElement
    const origText = saveBtn.innerHTML
    saveBtn.innerHTML = "💾 Saving..."
    saveBtn.disabled = true

    await saveSetting("ha_url", haUrl)
    if (haToken) await saveSetting("ha_token", haToken)

    saveBtn.innerHTML = origText
    saveBtn.disabled = false
    showToast("settings.ha_saved")
    })
  }

  // Webhook Save
  const saveWebhookBtn = document.getElementById("save-webhook")
  if (saveWebhookBtn) {
    pageLifecycle.on(saveWebhookBtn, "click", async () => {
    const endpoint = (document.getElementById("webhook-endpoint") as HTMLInputElement).value
    const secret = (document.getElementById("webhook-secret") as HTMLInputElement).value
    const format = (document.getElementById("webhook-format") as HTMLSelectElement).value

    if (!endpoint) {
      showToast("settings.webhook_required", "error")
      return
    }

    const btn = document.getElementById("save-webhook") as HTMLButtonElement
    btn.textContent = "Saving..."
    btn.disabled = true

    await saveSetting("webhook_endpoint", endpoint)
    if (secret) await saveSetting("webhook_secret", secret)
    await saveSetting("webhook_format", format)

    btn.textContent = "Save Webhook"
    btn.disabled = false
    showToast("settings.webhook_saved")
    })
  }

  // Webhook Test
  const testWebhookBtn = document.getElementById("test-webhook")
  if (testWebhookBtn) {
    pageLifecycle.on(testWebhookBtn, "click", async () => {
    const endpoint = (document.getElementById("webhook-endpoint") as HTMLInputElement).value
    if (!endpoint) {
      showToast("settings.webhook_enter_url", "error")
      return
    }
    const btn = document.getElementById("test-webhook") as HTMLButtonElement
    btn.textContent = "Sending..."
    btn.disabled = true

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventType: "webhook.test",
          timestamp: new Date().toISOString(),
          payload: { message: "Test ping from Meitheal", source: "settings" },
        }),
        signal: pageLifecycle.signal,
      })
      showToast(res.ok ? `✅ Test sent — ${res.status}` : `⚠ Response: ${res.status}`, res.ok ? "success" : "error")
    } catch (err) {
      showToast(`❌ Failed: ${err instanceof Error ? err.message : "Network error"}`, "error")
    }

    btn.textContent = "Send Test"
    btn.disabled = false
    })
  }
}

/** Restore HA/webhook related settings */
export function restoreHASettings(s: Record<string, unknown>): void {
  // Webhook
  if (s.webhook_endpoint)
    (document.getElementById("webhook-endpoint") as HTMLInputElement).value = String(s.webhook_endpoint)
  if (s.webhook_format)
    (document.getElementById("webhook-format") as HTMLSelectElement).value = String(s.webhook_format)
  if (s.webhook_endpoint) {
    const el = document.getElementById("webhook-status")
    if (el) { el.textContent = "Active"; el.className = "badge badge-active" }
    window.expandIntegrationCard?.("integration-webhooks-body")
  } else {
    const el = document.getElementById("webhook-status")
    if (el) { el.textContent = "Not configured"; el.className = "badge badge-pending" }
  }

  // Grocy
  if (s.grocy_url)
    (document.getElementById("grocy-url") as HTMLInputElement).value = String(s.grocy_url)
  if (s.grocy_sync_mode)
    (document.getElementById("grocy-sync-mode") as HTMLSelectElement).value = String(s.grocy_sync_mode)
  if (s.grocy_url) {
    const el = document.getElementById("grocy-status")
    if (el) { el.textContent = "Configured"; el.className = "badge badge-active" }
    window.expandIntegrationCard?.("integration-grocy-body")
  }

  // Calendar — pre-check saved entities in toggle cards
  const calEntityVal = s.calendar_entities ?? s.calendar_entity ?? s.cal_entity
  if (calEntityVal) window.expandIntegrationCard?.("integration-calendar-body")
}
