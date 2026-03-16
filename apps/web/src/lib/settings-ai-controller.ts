/**
 * AI & Agent settings controller.
 *
 * Handles AI provider selection, custom URL toggle, save,
 * and agent protocol (A2A / WebMCP / MCP) toggles.
 */
import { showToast } from "@lib/toast"
import { saveSetting } from "@lib/settings-utils"

export function initAISettings(): void {
  // AI provider custom URL toggle
  document.getElementById("ai-provider")?.addEventListener("change", function () {
    const group = document.getElementById("ai-custom-url-group")
    if (group) {
      group.style.display = (this as HTMLSelectElement).value === "custom" ? "block" : "none"
    }
  })

  // Save AI settings
  document.getElementById("save-ai")?.addEventListener("click", async () => {
    const provider = (document.getElementById("ai-provider") as HTMLSelectElement).value
    const customUrl = (document.getElementById("ai-custom-url") as HTMLInputElement).value

    const saveBtn = document.getElementById("save-ai") as HTMLButtonElement
    if (!saveBtn) return
    const origText = saveBtn.innerHTML
    saveBtn.innerHTML = "💾 Saving..."
    saveBtn.disabled = true

    await saveSetting("ai-provider", provider)
    localStorage.setItem("meitheal-ai-provider", provider)
    if (provider === "custom" || provider === "ollama") {
      await saveSetting("ai-custom-url", customUrl)
      localStorage.setItem("meitheal-ai-custom-url", customUrl)
    }

    saveBtn.innerHTML = origText
    saveBtn.disabled = false
    showToast("settings.ai_saved")
  })

  // Save agent protocols
  document.getElementById("save-agent-protocols")?.addEventListener("click", async () => {
    const a2a = (document.getElementById("agent-a2a-enabled") as HTMLInputElement)?.checked ?? true
    const webmcp = (document.getElementById("agent-webmcp-enabled") as HTMLInputElement)?.checked ?? false
    const mcp = (document.getElementById("agent-mcp-enabled") as HTMLInputElement)?.checked ?? true

    const saveBtn = document.getElementById("save-agent-protocols") as HTMLButtonElement
    if (!saveBtn) return
    const origText = saveBtn.innerHTML
    saveBtn.innerHTML = "💾 Saving..."
    saveBtn.disabled = true

    await saveSetting("agent-protocols-a2a-enabled", a2a)
    await saveSetting("agent-protocols-webmcp-enabled", webmcp)
    await saveSetting("agent-protocols-mcp-enabled", mcp)

    // Update status badge
    const statusEl = document.getElementById("agent-protocols-status")
    if (statusEl) {
      const anyEnabled = a2a || webmcp || mcp
      statusEl.textContent = anyEnabled ? "Active" : "Disabled"
      statusEl.className = anyEnabled ? "badge badge-active" : "badge badge-pending"
    }

    saveBtn.innerHTML = origText
    saveBtn.disabled = false
    showToast("settings.agent_protocols_saved")
  })
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
