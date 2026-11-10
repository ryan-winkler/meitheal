import { withAsyncButton } from "@lib/async-button"
import { parseAiHandoffUrl } from "@lib/ai-handoff-url"
/**
 * AI & Agent settings controller.
 *
 * Handles AI provider selection, custom URL toggle, save,
 * and agent protocol (A2A / WebMCP / MCP) toggles.
 */
import { pageLifecycle } from "@lib/page-lifecycle"
import { showToast } from "@lib/toast"
import { saveSettings, showSettingsSaveError } from "@lib/settings-utils"

export function initAISettings(): void {
  // AI provider custom URL toggle
  const aiProviderEl = document.getElementById("ai-provider")
  if (aiProviderEl) {
    pageLifecycle.on(aiProviderEl, "change", () => {
      const group = document.getElementById("ai-custom-url-group")
      if (group) {
        group.style.display = ["custom", "ollama"].includes((aiProviderEl as HTMLSelectElement).value) ? "" : "none"
      }
    })
  }

  // Save AI settings
  const saveAiBtn = document.getElementById("save-ai") as HTMLButtonElement | null
  if (saveAiBtn) {
    pageLifecycle.on(saveAiBtn, "click", withAsyncButton(saveAiBtn, async () => {
      const provider = (document.getElementById("ai-provider") as HTMLSelectElement).value
      const customUrl = (document.getElementById("ai-custom-url") as HTMLInputElement).value.trim()
      const usesUrl = provider === "custom" || provider === "ollama"
      const url = usesUrl ? parseAiHandoffUrl(customUrl || (provider === "ollama" ? "http://localhost:11434" : "")) : null
      if (usesUrl && !url) {
        showToast("settings.ext_ai_invalid_url", "error")
        return
      }

      await saveSettings(url ? { "ai-custom-url": url.href, "ai-provider": provider } : { "ai-provider": provider })
      localStorage.setItem("meitheal-ai-provider", provider)
      if (url) localStorage.setItem("meitheal-ai-custom-url", url.href)

      showToast("settings.ai_saved")
    }, { loadingText: "Saving…", onError: showSettingsSaveError }))
  }

  // Save agent protocols
  const saveProtocolsBtn = document.getElementById("save-agent-protocols") as HTMLButtonElement | null
  if (saveProtocolsBtn) {
    pageLifecycle.on(saveProtocolsBtn, "click", withAsyncButton(saveProtocolsBtn, async () => {
    const a2a = (document.getElementById("agent-a2a-enabled") as HTMLInputElement)?.checked ?? true
    const webmcp = (document.getElementById("agent-webmcp-enabled") as HTMLInputElement)?.checked ?? false
    const mcp = (document.getElementById("agent-mcp-enabled") as HTMLInputElement)?.checked ?? true


    await saveSettings({
      "agent-protocols-a2a-enabled": a2a,
      "agent-protocols-webmcp-enabled": webmcp,
      "agent-protocols-mcp-enabled": mcp,
    })

    // Update status badge
    const statusEl = document.getElementById("agent-protocols-status")
    if (statusEl) {
      const anyEnabled = a2a || webmcp || mcp
      statusEl.textContent = anyEnabled ? "Active" : "Disabled"
      statusEl.className = anyEnabled ? "badge badge-active" : "badge badge-pending"
    }

    showToast("settings.agent_protocols_saved")
    }, { loadingText: "Saving…", onError: showSettingsSaveError }))
  }
}

/** Restore AI & agent protocol settings from loaded settings object */
export function restoreAISettings(s: Record<string, unknown>): void {
  // AI provider
  if (s["ai-provider"]) {
    const el = document.getElementById("ai-provider") as HTMLSelectElement | null
    if (el) el.value = String(s["ai-provider"])
    const group = document.getElementById("ai-custom-url-group")
    if (group) group.style.display = s["ai-provider"] === "custom" || s["ai-provider"] === "ollama" ? "" : "none"
  }
  if (s["ai-custom-url"]) {
    const el = document.getElementById("ai-custom-url") as HTMLInputElement | null
    if (el) el.value = String(s["ai-custom-url"])
  }

  // Agent Protocols
  const a2aEnabled = s["agent-protocols-a2a-enabled"]
  const webmcpEnabled = s["agent-protocols-webmcp-enabled"]
  const mcpEnabled = s["agent-protocols-mcp-enabled"]
  if (a2aEnabled !== undefined)
    (document.getElementById("agent-a2a-enabled") as HTMLInputElement).checked =
      a2aEnabled === true || a2aEnabled === "true"
  if (webmcpEnabled !== undefined)
    (document.getElementById("agent-webmcp-enabled") as HTMLInputElement).checked =
      webmcpEnabled === true || webmcpEnabled === "true"
  if (mcpEnabled !== undefined)
    (document.getElementById("agent-mcp-enabled") as HTMLInputElement).checked =
      mcpEnabled === true || mcpEnabled === "true"

  const anyConfigured = a2aEnabled !== undefined || webmcpEnabled !== undefined || mcpEnabled !== undefined
  const anyActive =
    a2aEnabled === true || a2aEnabled === "true" ||
    webmcpEnabled === true || webmcpEnabled === "true" ||
    mcpEnabled === true || mcpEnabled === "true"
  const statusEl = document.getElementById("agent-protocols-status")
  if (statusEl && anyConfigured) {
    statusEl.textContent = anyActive ? "Active" : "Disabled"
    statusEl.className = anyActive ? "badge badge-active" : "badge badge-pending"
  }
}
