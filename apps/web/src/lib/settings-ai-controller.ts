import { settingsAction } from "@lib/settings-utils"
/**
 * AI & Agent settings controller.
 *
 * Handles AI provider selection, custom URL toggle, save,
 * and agent protocol (A2A / WebMCP / MCP) toggles.
 */
import { pageLifecycle } from "@lib/page-lifecycle"
import { showToast } from "@lib/toast"
import { saveSetting } from "@lib/settings-utils"
import { AGENT_PROTOCOLS, agentProtocolEnabled, agentProtocolSettingKey } from "@lib/agent-protocol-options"
import { settingsStore } from "@lib/settings-store"
import { configureWebMcp, notifyWebMcpPreferenceChanged } from "@lib/webmcp-controller"

let protocolRender = 0

async function renderProtocolSettings(settings: Record<string, unknown>, hydrateSwitches = true) {
  const signal = pageLifecycle.signal
  const render = ++protocolRender
  await Promise.all(AGENT_PROTOCOLS.map(async protocol => {
    const enabled = agentProtocolEnabled(protocol, settings[agentProtocolSettingKey(protocol)])
    const input = document.querySelector<HTMLInputElement>(`#agent-${protocol}-enabled`)
    if (input && hydrateSwitches) input.checked = enabled
    if (protocol === "webmcp") {
      await configureWebMcp(enabled)
      return
    }
    const status = document.getElementById(`agent-${protocol}-runtime-status`)
    const link = document.querySelector<HTMLAnchorElement>(`[data-protocol-link="${protocol}"]`)
    if (!status || !link) return
    link.hidden = true
    status.textContent = enabled ? "Checking discovery…" : "Disabled."
    if (!enabled) return
    let available = false
    try {
      const path = protocol === "a2a" ? "/.well-known/agent-card.json" : "/.well-known/mcp.json"
      const response = await fetch(path, { signal, cache: "no-store" })
      if (response.ok) available = typeof (await response.json())?.name === "string"
    } catch { /* Display unavailable; keep the preference for retry. */ }
    if (signal.aborted || render !== protocolRender) return
    status.textContent = available ? "Discovery is available." : "Discovery is unavailable. Check the connection and retry."
    link.hidden = !available
  }))
  const badge = document.getElementById("agent-protocols-status")
  if (badge && !signal.aborted && render === protocolRender) {
    const count = AGENT_PROTOCOLS.filter(protocol => agentProtocolEnabled(protocol, settings[agentProtocolSettingKey(protocol)])).length
    badge.textContent = `${count} protocols enabled`
    badge.className = count ? "badge badge-active" : "badge badge-pending"
  }
}

export function initAISettings(): void {
  // AI provider custom URL toggle
  const aiProviderEl = document.getElementById("ai-provider")
  if (aiProviderEl) {
    pageLifecycle.on(aiProviderEl, "change", () => {
      const group = document.getElementById("ai-custom-url-group")
      if (group) {
        group.style.display = (aiProviderEl as HTMLSelectElement).value === "custom" ? "block" : "none"
      }
    })
  }

  // Save AI settings
  const saveAiBtn = document.getElementById("save-ai")
  if (saveAiBtn) {
    pageLifecycle.on(saveAiBtn, "click", settingsAction(async () => {
    const provider = (document.getElementById("ai-provider") as HTMLSelectElement).value
    const customUrl = (document.getElementById("ai-custom-url") as HTMLInputElement).value

    const saveBtn = document.getElementById("save-ai") as HTMLButtonElement
    if (!saveBtn) return
    const origText = saveBtn.textContent
    saveBtn.textContent = "💾 Saving..."
    saveBtn.disabled = true

    await saveSetting("ai-provider", provider)
    localStorage.setItem("meitheal-ai-provider", provider)
    if (provider === "custom" || provider === "ollama") {
      await saveSetting("ai-custom-url", customUrl)
      localStorage.setItem("meitheal-ai-custom-url", customUrl)
    }

    saveBtn.textContent = origText
    saveBtn.disabled = false
    showToast("settings.ai_saved")
    }))
  }

  // Save agent protocols
  const saveProtocolsBtn = document.getElementById("save-agent-protocols")
  if (saveProtocolsBtn) {
    pageLifecycle.on(saveProtocolsBtn, "click", settingsAction(async () => {
    const saveBtn = document.getElementById("save-agent-protocols") as HTMLButtonElement
    if (!saveBtn) return
    const origText = saveBtn.textContent
    saveBtn.textContent = "Saving…"
    saveBtn.disabled = true
    const changes = Object.fromEntries(AGENT_PROTOCOLS.map(protocol => [
      agentProtocolSettingKey(protocol), document.querySelector<HTMLInputElement>(`#agent-${protocol}-enabled`)?.checked ?? false,
    ]))
    try {
      for (const [key, value] of Object.entries(changes)) await saveSetting(key, value)
    } catch (error) {
      settingsStore.invalidate()
      const persisted = await settingsStore.load().catch(() => null)
      if (persisted) await renderProtocolSettings(persisted, false)
      notifyWebMcpPreferenceChanged()
      throw error
    }
    notifyWebMcpPreferenceChanged()
    await renderProtocolSettings(changes)
    saveBtn.textContent = origText
    saveBtn.disabled = false
    showToast("settings.agent_protocols_saved")
    }))
  }
}

/** Restore AI & agent protocol settings from loaded settings object */
export function restoreAISettings(s: Record<string, unknown>): void {
  // AI provider
  if (s["ai-provider"]) {
    const el = document.getElementById("ai-provider") as HTMLSelectElement | null
    if (el) el.value = String(s["ai-provider"])
    const group = document.getElementById("ai-custom-url-group")
    if (group) group.style.display = s["ai-provider"] === "custom" ? "block" : "none"
  }
  if (s["ai-custom-url"]) {
    const el = document.getElementById("ai-custom-url") as HTMLInputElement | null
    if (el) el.value = String(s["ai-custom-url"])
  }

  // Agent Protocols: one default and persistence policy shared with the API.
  void renderProtocolSettings(s)
}
