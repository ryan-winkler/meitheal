/**
 * n8n & Node-RED integration settings controller.
 *
 * Handles: n8n HA addon mode save, n8n standalone save,
 * test event bus, test webhook (standalone), n8n diagnostics,
 * HA bus status, Node-RED copy/deploy/status, event count,
 * n8n mode selection, and n8n settings restore.
 */
import { withAsyncButton } from "@lib/async-button"
import { confirmDialog } from "@lib/confirm-dialog"
import { pageLifecycle } from "@lib/page-lifecycle"
import { escapeHtml } from "@lib/safe-html"
import { showToast } from "@lib/toast"
import { saveSettings, showSettingsSaveError, log } from "@lib/settings-utils"

function showN8nMode(mode: "auto" | "standalone"): void {
  for (const option of ["auto", "standalone"] as const) {
    const selected = option === mode
    const button = document.getElementById(`n8n-mode-${option}`)
    const content = document.getElementById(`n8n-${option}-content`)
    button?.setAttribute("aria-pressed", String(selected))
    button?.classList.toggle("mode-tab--active", selected)
    if (content) content.style.display = selected ? "" : "none"
  }
}

export function initN8nSettings(): void {
  for (const mode of ["auto", "standalone"] as const) {
    const button = document.getElementById(`n8n-mode-${mode}`)
    if (!button) continue
    pageLifecycle.on(button, "click", () => {
      showN8nMode(mode)
      localStorage.setItem("meitheal:n8n-mode", mode)
    })
  }

  // ───── n8n Save (HA Addon / Auto mode) ─────
  const saveN8nBtn = document.getElementById("save-n8n") as HTMLButtonElement
  if (saveN8nBtn) {
    pageLifecycle.on(saveN8nBtn, "click", withAsyncButton(saveN8nBtn, async () => {
    const webhookUrl = (document.getElementById("n8n-webhook-url") as HTMLInputElement)?.value || ""
    const events: string[] = []
    document.querySelectorAll(".n8n-event:checked").forEach((cb) => {
      events.push((cb as HTMLInputElement).value)
    })
    await saveSettings({
      n8n_mode: "ha_addon",
      ...(webhookUrl ? { n8n_webhook_url: webhookUrl } : {}),
      n8n_events: events,
    })
    const statusEl = document.getElementById("n8n-status")
    if (statusEl) { statusEl.textContent = "Configured"; statusEl.className = "badge badge-active" }
    showToast("settings.n8n_saved")
    }, { loadingText: "Saving…", onError: showSettingsSaveError }))
  }

  // ───── Test Event Bus ─────
  const testEventBtn = document.getElementById("test-event-bus")
  if (testEventBtn) {
    pageLifecycle.on(testEventBtn, "click", async () => {
    const btn = document.getElementById("test-event-bus") as HTMLButtonElement
    const resultDiv = document.getElementById("test-event-result")
    const msgSpan = document.getElementById("test-event-message")
    if (!btn) return
    btn.textContent = "🔌 Sending..."
    btn.disabled = true
    try {
      const res = await fetch((window.__ingress_path || "") + "/api/integrations/test-event", {
        method: "POST", headers: { "content-type": "application/json" }, signal: pageLifecycle.signal,
      })
      const data = await res.json()
      if (resultDiv && msgSpan) {
        resultDiv.style.display = "block"
        if (data.success) {
          resultDiv.className = "integration-callout integration-callout--success"
          msgSpan.textContent = `✅ ${data.hint}`
        } else {
          resultDiv.className = "integration-callout integration-callout--warning"
          msgSpan.textContent = `⚠ ${data.error || data.hint || "Failed to send test event"}`
        }
      }
    } catch (err) {
      if (resultDiv && msgSpan) {
        resultDiv.style.display = "block"
        resultDiv.className = "integration-callout integration-callout--warning"
        msgSpan.textContent = `❌ Network error: ${err instanceof Error ? err.message : "unknown"}`
      }
    }
    btn.textContent = "🧪 Test Event Bus"
    btn.disabled = false
    })
  }

  // ───── Event Count Updaters ─────
  function updateEventCount(selectorClass: string, countId: string) {
    const total = document.querySelectorAll(`.${selectorClass}`).length
    const checked = document.querySelectorAll(`.${selectorClass}:checked`).length
    const el = document.getElementById(countId)
    if (el) el.textContent = `${checked} of ${total} events enabled`
  }
  document.querySelectorAll(".n8n-event").forEach((cb) => {
    pageLifecycle.on(cb, "change", () => updateEventCount("n8n-event", "n8n-event-count-auto"))
  })
  updateEventCount("n8n-event", "n8n-event-count-auto")
  document.querySelectorAll(".n8n-event-standalone").forEach((cb) => {
    pageLifecycle.on(cb, "change", () => updateEventCount("n8n-event-standalone", "n8n-event-count-standalone"))
  })
  updateEventCount("n8n-event-standalone", "n8n-event-count-standalone")

  // ───── Copy Node-RED flows ─────
  const copyNodeRedBtn = document.getElementById("copy-nodered-flows")
  if (copyNodeRedBtn) {
    pageLifecycle.on(copyNodeRedBtn, "click", async () => {
    const btn = document.getElementById("copy-nodered-flows") as HTMLButtonElement
    if (!btn) return
    try {
      const res = await fetch((window.__ingress_path || "") + "/api/integrations/nodered/flows", { signal: pageLifecycle.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const flowJson = await res.text()
      await navigator.clipboard.writeText(flowJson)
      btn.textContent = "✅ Copied!"
      showToast("Node-RED flows copied to clipboard — paste in Node-RED → Import")
      setTimeout(() => { if (!pageLifecycle.signal.aborted) btn.textContent = "📋 Copy Flow JSON" }, 2000)
    } catch (err) {
      btn.textContent = "❌ Failed"
      showToast(`Failed to copy: ${err instanceof Error ? err.message : "error"}`, "error")
      setTimeout(() => { if (!pageLifecycle.signal.aborted) btn.textContent = "📋 Copy Flow JSON" }, 2000)
    }
    })
  }

  // ───── Deploy Node-RED flows ─────
  const deployNodeRedBtn = document.getElementById("deploy-nodered-flows")
  if (deployNodeRedBtn) {
    pageLifecycle.on(deployNodeRedBtn, "click", async () => {
    const btn = document.getElementById("deploy-nodered-flows") as HTMLButtonElement
    const resultDiv = document.getElementById("nodered-deploy-result")
    const msgSpan = document.getElementById("nodered-deploy-message")
    const badge = document.getElementById("nodered-deploy-badge")
    if (!btn) return
    if (badge && badge.classList.contains("badge-success")) {
      const confirmed = await confirmDialog({ message: "This will replace existing Meitheal flows in Node-RED. Continue?", variant: "warning", confirmText: "Replace" })
      if (!confirmed) return
    }
    btn.textContent = "🔄 Deploying..."
    btn.disabled = true
    try {
      const res = await fetch((window.__ingress_path || "") + "/api/integrations/nodered/deploy", {
        method: "POST", headers: { "content-type": "application/json" }, signal: pageLifecycle.signal,
      })
      const data = await res.json() as { success: boolean; message?: string; error?: string; nodeCount?: number }
      if (resultDiv && msgSpan) {
        resultDiv.style.display = "block"
        if (data.success) {
          resultDiv.className = "integration-callout integration-callout--success"
          msgSpan.textContent = `✅ ${data.message || "Flows deployed"} (${data.nodeCount || "?"} nodes)`
          initNodeRedDeployStatus()
        } else {
          resultDiv.className = "integration-callout integration-callout--warning"
          msgSpan.textContent = `⚠ ${data.message || data.error || "Deploy failed"}`
        }
      }
    } catch (err) {
      if (resultDiv && msgSpan) {
        resultDiv.style.display = "block"
        resultDiv.className = "integration-callout integration-callout--warning"
        msgSpan.textContent = `❌ Network error: ${err instanceof Error ? err.message : "unknown"}`
      }
    }
    btn.textContent = "🚀 Deploy to Node-RED"
    btn.disabled = false
    })
  }

  // ───── Node-RED Deploy Status ─────
  initNodeRedDeployStatus()

  // ───── n8n Standalone Save ─────
  const saveStandaloneBtn = document.getElementById("save-n8n-standalone") as HTMLButtonElement
  if (saveStandaloneBtn) {
    pageLifecycle.on(saveStandaloneBtn, "click", withAsyncButton(saveStandaloneBtn, async () => {
    const webhookUrl = (document.getElementById("n8n-webhook-url") as HTMLInputElement).value
    const apiKey = (document.getElementById("n8n-api-key") as HTMLInputElement).value
    const secret = (document.getElementById("n8n-secret") as HTMLInputElement).value
    if (!webhookUrl) { showToast("settings.n8n_required", "error"); return }
    const events: string[] = []
    document.querySelectorAll(".n8n-event-standalone:checked").forEach((cb) => {
      events.push((cb as HTMLInputElement).value)
    })
    await saveSettings({
      n8n_mode: "standalone",
      n8n_webhook_url: webhookUrl,
      ...(apiKey && apiKey !== "••••••••" ? { n8n_api_key: apiKey } : {}),
      ...(secret && secret !== "••••••••" ? { n8n_signing_secret: secret } : {}),
      n8n_events: events,
    })
    const statusEl = document.getElementById("n8n-status")
    if (statusEl) { statusEl.textContent = "Configured"; statusEl.className = "badge badge-active" }
    showToast("settings.n8n_saved")
    }, { loadingText: "Saving…", onError: showSettingsSaveError }))
  }

  // ───── Test Webhook (Standalone) ─────
  const testWebhookStandaloneBtn = document.getElementById("test-webhook-standalone")
  if (testWebhookStandaloneBtn) {
    pageLifecycle.on(testWebhookStandaloneBtn, "click", async () => {
    const btn = document.getElementById("test-webhook-standalone") as HTMLButtonElement
    const resultDiv = document.getElementById("test-webhook-result")
    const msgSpan = document.getElementById("test-webhook-message")
    if (!btn) return
    btn.textContent = "🔌 Sending..."
    btn.disabled = true
    try {
      const res = await fetch((window.__ingress_path || "") + "/api/integrations/test-webhook", {
        method: "POST", headers: { "content-type": "application/json" }, signal: pageLifecycle.signal,
      })
      const data = await res.json()
      if (resultDiv && msgSpan) {
        resultDiv.style.display = "block"
        if (data.success) {
          resultDiv.className = "integration-callout integration-callout--success"
          msgSpan.textContent = data.hint || `✅ Delivered (${data.status_code}) in ${data.latency_ms}ms`
        } else {
          resultDiv.className = "integration-callout integration-callout--warning"
          msgSpan.textContent = data.hint || data.error || "Failed to send test webhook"
        }
      }
      // Live-update the last delivery indicator
      const lastDeliveryEl = document.getElementById("n8n-last-delivery")
      if (lastDeliveryEl) {
        const timeStr = data.timestamp ? new Date(data.timestamp).toLocaleString() : "Just now"
        const statusSpan = document.createElement("span")
        const metaSpan = document.createElement("span")
        metaSpan.style.fontSize = "11px"
        metaSpan.style.color = "var(--text-muted)"
        if (data.success) {
          statusSpan.style.color = "var(--success)"
          statusSpan.textContent = `✓ Success (${String(data.status_code ?? "")})`
          metaSpan.textContent = `${timeStr} · ${String(data.latency_ms ?? "")}ms`
        } else {
          statusSpan.style.color = "var(--error)"
          statusSpan.textContent = `❌ Failed (${String(data.status_code || data.error || "Error")})`
          metaSpan.textContent = timeStr
        }
        lastDeliveryEl.replaceChildren(statusSpan, document.createElement("br"), metaSpan)
      }
    } catch (err) {
      if (resultDiv && msgSpan) {
        resultDiv.style.display = "block"
        resultDiv.className = "integration-callout integration-callout--warning"
        msgSpan.textContent = `❌ Network error: ${err instanceof Error ? err.message : "unknown"}`
      }
    }
    btn.textContent = "🔌 Test Webhook"
    btn.disabled = false
    })
  }

  // ───── n8n Diagnostics ─────
  async function initN8nDiagnostics(_forceRefresh: boolean = false) {
    const healthDetail = document.getElementById("n8n-health-detail")
    const workflowsList = document.getElementById("n8n-workflows-list")
    const urlInput = (document.getElementById("n8n-webhook-url") as HTMLInputElement)?.value
    if (!urlInput) return
    if (healthDetail) healthDetail.textContent = "Checking..."
    if (workflowsList) {
      workflowsList.innerHTML = `<div class="cal-empty-state"><span class="cal-empty-icon">⏳</span><span>Fetching workflows...</span></div>`
    }
    try {
      const res = await fetch((window.__ingress_path || "") + "/api/integrations/n8n/health", { signal: pageLifecycle.signal })
      const data = await res.json()
      if (healthDetail) {
        const span = document.createElement("span")
        if (data.status === "connected") {
          span.style.color = "var(--success)"
          span.style.fontWeight = "600"
          span.textContent = "✓ Connected"
        } else if (data.status === "unreachable") {
          span.style.color = "var(--error)"
          span.textContent = "Unreachable"
        } else if (data.status === "unconfigured") {
          span.style.color = "var(--text-muted)"
          span.textContent = "Unconfigured"
        } else {
          span.style.color = "var(--warning)"
          span.textContent = `Error: ${String(data.code || data.message || "Unknown")}`
        }
        healthDetail.replaceChildren(span)
      }
    } catch {
      if (healthDetail) {
        const span = document.createElement("span")
        span.style.color = "var(--error)"
        span.textContent = "Failed to check"
        healthDetail.replaceChildren(span)
      }
    }
    try {
      const res = await fetch((window.__ingress_path || "") + "/api/integrations/n8n/workflows", { signal: pageLifecycle.signal })
      const data = await res.json()
      if (workflowsList) {
        const setEmptyState = (icon: string, text: string) => {
          const empty = document.createElement("div")
          empty.className = "cal-empty-state"
          const iconEl = document.createElement("span")
          iconEl.className = "cal-empty-icon"
          iconEl.textContent = icon
          const msgEl = document.createElement("span")
          msgEl.textContent = text
          empty.append(iconEl, msgEl)
          workflowsList.replaceChildren(empty)
        }
        if (data.success && Array.isArray(data.workflows)) {
          if (data.workflows.length === 0) {
            setEmptyState("📭", "No workflows found.")
          } else {
            workflowsList.replaceChildren()
            data.workflows.forEach((wf: { id: string; name: string; active: boolean }) => {
              const el = document.createElement("div")
              el.className = "cal-entity-card"
              const info = document.createElement("div")
              info.className = "cal-entity-card__info"
              info.style.flex = "1"
              const strong = document.createElement("strong")
              strong.textContent = wf.name
              const idDiv = document.createElement("div")
              idDiv.style.fontSize = "11px"
              idDiv.style.color = "var(--text-muted)"
              idDiv.style.marginTop = "2px"
              idDiv.textContent = `ID: ${wf.id}`
              info.append(strong, idDiv)
              const toggle = document.createElement("div")
              toggle.className = "cal-entity-card__toggle"
              const badge = document.createElement("span")
              badge.className = `badge ${wf.active ? "badge-active" : "badge-disabled"}`
              badge.textContent = wf.active ? "Active" : "Inactive"
              toggle.appendChild(badge)
              el.append(info, toggle)
              workflowsList.appendChild(el)
            })
          }
        } else if (data.error === "not_configured") {
          setEmptyState("🔒", "API Key missing or invalid.")
        } else if (data.error === "unconfigured") {
          setEmptyState("📭", "Configure URL to discover workflows.")
        } else {
          setEmptyState("⚠️", `Failed to load workflows: ${String(data.message || data.error || "Unknown error")}`)
        }
      }
    } catch {
      if (workflowsList) {
        const empty = document.createElement("div")
        empty.className = "cal-empty-state"
        const iconEl = document.createElement("span")
        iconEl.className = "cal-empty-icon"
        iconEl.textContent = "❌"
        const msgEl = document.createElement("span")
        msgEl.textContent = "Network error fetching workflows."
        empty.append(iconEl, msgEl)
        workflowsList.replaceChildren(empty)
      }
    }
  }

  // Expose for restore flow
  window.__initN8nDiagnostics = initN8nDiagnostics

  const refreshStandalone = document.getElementById("refresh-n8n-standalone")
  if (refreshStandalone) pageLifecycle.on(refreshStandalone, "click", () => initN8nDiagnostics(true))
  const refreshStatus = document.getElementById("refresh-n8n-status")
  if (refreshStatus) pageLifecycle.on(refreshStatus, "click", () => initN8nDiagnostics(true))
  const refreshWorkflows = document.getElementById("refresh-n8n-workflows")
  if (refreshWorkflows) pageLifecycle.on(refreshWorkflows, "click", () => initN8nDiagnostics(true))

  // ───── HA Bus Status ─────
  async function initHABusStatus() {
    const busStatusEl = document.getElementById("n8n-ha-bus-status")
    const haVersionEl = document.getElementById("n8n-ha-version")
    if (!busStatusEl) return
    try {
      const res = await fetch((window.__ingress_path || "") + "/api/integrations/status", { signal: pageLifecycle.signal })
      const data = await res.json()
      if (data.ha_connection) {
        if (data.ha_connection.connected)
          busStatusEl.innerHTML = `<span style="color: var(--success); font-weight: 600;">✓ Connected</span>`
        else if (data.ha_connection.supervisor_token_present)
          busStatusEl.innerHTML = `<span style="color: var(--warning);">Disconnected</span>`
        else
          busStatusEl.innerHTML = `<span style="color: var(--text-muted);">Not running as HA addon</span>`
        if (haVersionEl && data.ha_connection.version)
          haVersionEl.textContent = data.ha_connection.version
      }
    } catch {
      if (busStatusEl) busStatusEl.innerHTML = `<span style="color: var(--error);">Failed to check</span>`
    }
  }
  setTimeout(() => {
    if (!pageLifecycle.signal.aborted) initHABusStatus()
  }, 300)
}

async function initNodeRedDeployStatus() {
  const statusDiv = document.getElementById("nodered-deploy-status")
  const badge = document.getElementById("nodered-deploy-badge")
  const openLink = document.getElementById("nodered-open-link") as HTMLAnchorElement | null
  if (!statusDiv || !badge) return
  statusDiv.style.display = "flex"
  statusDiv.style.alignItems = "center"
  badge.textContent = "Checking..."
  badge.className = "badge badge-disabled"
  try {
    const res = await fetch((window.__ingress_path || "") + "/api/integrations/nodered/status", { signal: pageLifecycle.signal })
    const data = await res.json() as { available?: boolean; reachable?: boolean; flowDeployed?: boolean; nodeRedUrl?: string }
    if (!data.available) {
      badge.textContent = "N/A (standalone)"
      badge.className = "badge badge-disabled"
      const deployBtn = document.getElementById("deploy-nodered-flows")
      if (deployBtn) deployBtn.style.display = "none"
      return
    }
    if (!data.reachable) { badge.textContent = "Node-RED not running"; badge.className = "badge badge-disabled"; return }
    if (data.flowDeployed) { badge.textContent = "✓ Flows deployed"; badge.className = "badge badge-success" }
    else { badge.textContent = "Not deployed"; badge.className = "badge badge-disabled" }
    if (data.nodeRedUrl && openLink) { openLink.href = data.nodeRedUrl; openLink.style.display = "inline-flex" }
  } catch { badge.textContent = "Error checking"; badge.className = "badge badge-disabled" }
}

/** Restore n8n-related settings from loaded settings object */
export function restoreN8nSettings(s: Record<string, unknown>): void {
  // n8n webhook URL
  if (s.n8n_webhook_url) {
    (document.getElementById("n8n-webhook-url") as HTMLInputElement).value = String(s.n8n_webhook_url)
    const el = document.getElementById("n8n-status")
    if (el) { el.textContent = "Configured"; el.className = "badge badge-active" }
    window.expandIntegrationCard?.("integration-n8n-body")
  }
  if (Array.isArray(s.n8n_events)) {
    document.querySelectorAll(".n8n-event").forEach((cb) => {
      (cb as HTMLInputElement).checked = (s.n8n_events as string[]).includes((cb as HTMLInputElement).value)
    })
    document.querySelectorAll(".n8n-event-standalone").forEach((cb) => {
      (cb as HTMLInputElement).checked = (s.n8n_events as string[]).includes((cb as HTMLInputElement).value)
    })
  }
  if (s.n8n_api_key) (document.getElementById("n8n-api-key") as HTMLInputElement).value = String(s.n8n_api_key)
  if (s.n8n_signing_secret) (document.getElementById("n8n-secret") as HTMLInputElement).value = String(s.n8n_signing_secret)

  // Last delivery
  if (s.n8n_last_delivery) {
    const lastDeliveryEl = document.getElementById("n8n-last-delivery")
    if (lastDeliveryEl) {
      try {
        const res = typeof s.n8n_last_delivery === "string" ? JSON.parse(s.n8n_last_delivery) : s.n8n_last_delivery
        const timeStr = res.timestamp ? new Date(res.timestamp).toLocaleString() : "Unknown"
        const statusSpan = document.createElement("span")
        const timeSpan = document.createElement("span")
        timeSpan.style.fontSize = "11px"
        timeSpan.style.color = "var(--text-muted)"
        timeSpan.textContent = timeStr
        if (res.success) {
          statusSpan.style.color = "var(--success)"
          statusSpan.textContent = `✓ Success (${String(res.status ?? "")})`
        } else {
          statusSpan.style.color = "var(--error)"
          statusSpan.textContent = `❌ Failed (${String(res.status || "Error")})`
        }
        lastDeliveryEl.replaceChildren(statusSpan, document.createElement("br"), timeSpan)
      } catch { lastDeliveryEl.textContent = "Parse error" }
    }
  }

  // Trigger diagnostics after loading
  if (s.n8n_webhook_url) {
    if (typeof window.__initN8nDiagnostics === "function") setTimeout(() => window.__initN8nDiagnostics!(), 500)
  }

  const standalone = s.n8n_mode === "standalone" ||
    (!s.n8n_mode && localStorage.getItem("meitheal:n8n-mode") === "standalone")
  showN8nMode(standalone ? "standalone" : "auto")
}
