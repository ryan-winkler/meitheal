/**
 * HA connection & webhook integration settings controller.
 *
 * Handles: HA connection status, HA standalone form save,
 * webhook save/test, n8n mode tabs, expand integration cards.
 */
import { withAsyncButton } from "@lib/async-button"
import { pageLifecycle } from "@lib/page-lifecycle"
import { showToast } from "@lib/toast"
import { saveSettings, showSettingsSaveError, log } from "@lib/settings-utils"

/** Shared helper: read entity value from EntitySelector (handles select OR manual input) */
export function readEntityValue(id: string): string {
  const select = document.getElementById(id) as HTMLSelectElement | null
  const manual = document.getElementById(`${id}-manual`) as HTMLInputElement | null
  if (select && select.style.display !== "none" && select.value) return select.value
  if (manual && manual.value) return manual.value
  return select?.value || manual?.value || ""
}

type ConnectionCheckState = "checking" | "connected" | "standalone" | "denied" | "disconnected" | "failed"

export async function refreshHAConnection(expandOnConnect = false): Promise<void> {
  const indicator = document.getElementById("ha-indicator")
  const mode = document.getElementById("ha-mode-label")
  const detail = document.getElementById("ha-detail-label")
  const badge = document.getElementById("ha-connection-badge")
  const info = document.getElementById("ha-info-panel")
  const button = document.getElementById("test-connection")
  if (!indicator || !mode || !detail || !badge || !info || !button || button.hasAttribute("aria-busy")) return

  function setStatus(state: ConnectionCheckState): void {
    const message = (part: string) => {
      const key = `settings.ha_check.${state}.${part}`
      const value = window.mI18n?.get(key)
      return value === key ? "" : value ?? ""
    }
    const tone = state === "connected" ? "active" : state === "failed" || state === "denied" ? "error" : "pending"
    mode!.textContent = message("title")
    detail!.textContent = message("detail")
    badge!.textContent = message("badge")
    badge!.className = `badge badge-${tone}`
    indicator!.classList.toggle("ha-status-indicator--checking", state === "checking")
    indicator!.classList.toggle("ha-status-indicator--connected", state === "connected")
    info!.hidden = state !== "connected"
  }

  const signal = pageLifecycle.signal
  button.setAttribute("aria-busy", "true")
  button.setAttribute("aria-disabled", "true")
  setStatus("checking")

  try {
    const response = await fetch("/api/ha/connection", {
      cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    })
    if (!response.ok) throw new Error(`Connection check returned ${response.status}`)
    const data = await response.json()
    if (signal.aborted) return
    if (typeof data?.connected !== "boolean" || !["standalone", "ha-addon"].includes(data.mode)) throw new Error("Invalid connection check response")

    if (!data.connected) {
      const state = data.mode === "standalone" ? "standalone" : data.message === "INVALID_AUTH" ? "denied" : "disconnected"
      setStatus(state)
      return
    }

    for (const [id, value] of Object.entries({
      version: data.version, location: data.location_name, timezone: data.time_zone, mode: data.mode,
    })) {
      const element = document.getElementById(`ha-info-${id}`)
      if (element) element.textContent = typeof value === "string" && value ? value : "—"
    }
    setStatus("connected")
    if (expandOnConnect) window.expandIntegrationCard?.("integration-ha-body")
  } catch {
    if (!signal.aborted) setStatus("failed")
  } finally {
    button.removeAttribute("aria-busy")
    button.removeAttribute("aria-disabled")
  }
}

export function initHASettings(): void {
  const testConnection = document.getElementById("test-connection")
  if (testConnection) pageLifecycle.on(testConnection, "click", () => { void refreshHAConnection() })

  // Save HA settings (standalone mode only)
  const haForm = document.getElementById("ha-form")
  if (haForm) {
    const saveButton = document.getElementById("save-ha") as HTMLButtonElement | null
    if (saveButton) {
      const save = withAsyncButton(saveButton, async () => {
        const haUrl = (document.getElementById("ha-url") as HTMLInputElement).value
        const haToken = (document.getElementById("ha-token") as HTMLInputElement).value
        await saveSettings({ ha_url: haUrl, ...(haToken ? { ha_token: haToken } : {}) })
        showToast("settings.ha_saved")
      }, { loadingText: "Saving…", onError: showSettingsSaveError })
      pageLifecycle.on(haForm, "submit", (event) => {
        event.preventDefault()
        save(event)
      })
    }
  }

  // Webhook Save
  const saveWebhookBtn = document.getElementById("save-webhook") as HTMLButtonElement
  if (saveWebhookBtn) {
    pageLifecycle.on(saveWebhookBtn, "click", withAsyncButton(saveWebhookBtn, async () => {
    const endpoint = (document.getElementById("webhook-endpoint") as HTMLInputElement).value
    const secret = (document.getElementById("webhook-secret") as HTMLInputElement).value
    const format = (document.getElementById("webhook-format") as HTMLSelectElement).value

    if (!endpoint) {
      showToast("settings.webhook_required", "error")
      return
    }

    await saveSettings({
      webhook_endpoint: endpoint,
      ...(secret && secret !== "••••••••" ? { webhook_secret: secret } : {}),
      webhook_format: format,
    })
    showToast("settings.webhook_saved")
    }, { loadingText: "Saving…", onError: showSettingsSaveError }))
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
