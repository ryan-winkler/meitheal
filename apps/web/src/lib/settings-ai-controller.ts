/**
 * AI & Agent settings controller.
 *
 * Handles AI provider selection, custom URL toggle, save,
 * agent protocol (A2A / WebMCP / MCP) toggles, and agent token management.
 */
import { WEBMCP_SETTING } from "@domains/agents/webmcp-protocol"
import { parseAiHandoffUrl } from "@lib/ai-handoff-url"
import { withAsyncButton } from "@lib/async-button"
import { safeIngressHref } from "@lib/ingress-navigation"
import { fetchHaAgents, renderHaAgentOptions } from "@lib/ha-agent-picker"
import { pageLifecycle } from "@lib/page-lifecycle"
import { initAgentTokensSettings } from "@lib/settings-agent-tokens-controller"
import { settingsStore } from "@lib/settings-store"
import { saveSetting, saveSettings, showSettingsSaveError } from "@lib/settings-utils"
import { showToast } from "@lib/toast"
import { notifyWebMcpPreferenceChanged, refreshWebMcpPreference } from "@lib/webmcp-controller"
import { getClientLocale, t } from "../i18n/client"

let discoveryProbe: AbortController | undefined
let savedAiProvider: string | null = null
let savedAiUrl: string | null = null
let savedAiUrlShared = false
let aiHandoffEditable = false

/** Count checked discovery documents, never saved preferences or token tools. */
async function refreshProtocolDiscovery(): Promise<void> {
  const badge = document.getElementById("agent-protocols-status")
  if (!badge) return
  discoveryProbe?.abort()
  const controller = new AbortController()
  discoveryProbe = controller
  const pageSignal = pageLifecycle.signal
  const signal = AbortSignal.any([pageSignal, controller.signal, AbortSignal.timeout(8_000)])
  const probe = String(Number(badge.dataset.probe || 0) + 1)
  badge.dataset.probe = probe
  const current = () => !pageSignal.aborted && !controller.signal.aborted &&
    document.getElementById("agent-protocols-status") === badge && badge.dataset.probe === probe
  badge.textContent = badge.dataset.checking ?? ""
  badge.className = "badge badge-pending"
  let available = 0
  await Promise.all((["a2a", "mcp"] as const).map(async protocol => {
    const status = document.getElementById(`agent-${protocol}-runtime-status`)
    const link = document.querySelector<HTMLAnchorElement>(`[data-protocol-link="${protocol}"]`)
    if (!status || !link) return
    link.hidden = true
    status.dataset.state = "checking"
    status.textContent = status.dataset.checking ?? ""
    let state = "unavailable"
    try {
      const response = await fetch(link.dataset.path!, { signal, cache: "no-store", redirect: "error" })
      const data = await response.json()
      if (response.status === 404 && data?.detail === `${protocol.toUpperCase()} is disabled.`) state = "disabled"
      else if (response.ok && typeof data?.name === "string" && data.name.trim()) {
        const valid = protocol === "mcp"
          ? data.protocol === "mcp" && data.transport === "streamable-http" &&
            data.endpoint === `${window.__ingress_path || ""}/api/mcp` &&
            data.authentication?.type === "bearer" && data.authentication.requiredScope === "mcp:execute"
          : Array.isArray(data.skills) && data.skills.some((skill: { id?: unknown }) => skill?.id === "task-search") &&
            Array.isArray(data.supportedInterfaces) && data.supportedInterfaces.length === 1 &&
            data.supportedInterfaces[0]?.protocolBinding === "JSONRPC" &&
            data.supportedInterfaces[0]?.protocolVersion === "1.0" &&
            typeof data.supportedInterfaces[0]?.url === "string" &&
            data.supportedInterfaces[0].url.endsWith(`${window.__ingress_path || ""}/api/a2a/message`)
        if (valid) state = "available"
      }
    } catch { /* A failed probe cannot establish discovery availability. */ }
    if (!current()) return
    status.dataset.state = state
    status.textContent = status.dataset[state] ?? ""
    link.hidden = state !== "available"
    const toggle = document.querySelector<HTMLInputElement>(`#agent-${protocol}-enabled`)
    if (toggle?.disabled) toggle.checked = state === "available"
    if (state === "available") available++
  }))
  if (current()) {
    badge.textContent = (badge.dataset.count ?? "").replace("{count}", String(available))
    badge.className = available ? "badge badge-active" : "badge badge-pending"
  }
}

function renderAgentBadge(select: HTMLSelectElement, label?: string) {
  const badge = document.getElementById("ha-agent-status")
  if (badge) badge.textContent = label ?? select.selectedOptions[0]?.text ?? select.dataset.default ?? "Default"
}

function initHaAgentSettings() {
  const select = document.querySelector<HTMLSelectElement>("#ha-agent-select-settings")
  if (!select) return

  pageLifecycle.on(select, "change", () => {
    renderAgentBadge(select)
    const status = document.getElementById("ha-agent-discovery-status")
    if (status) status.textContent = select.selectedOptions[0]?.dataset.unavailable === "true"
      ? t("settings.ha_agent_selected_unavailable", getClientLocale())
      : t("settings.ha_agent_save_hint", getClientLocale())
  })
  const refresh = document.getElementById("refresh-ha-agents")
  if (refresh) pageLifecycle.on(refresh, "click", () => {
    if (refresh.getAttribute("aria-busy") !== "true") void restoreHaAgent(select.value)
  })
  const section = select.closest<HTMLElement>("[data-settings-shell-section]")
  if (section) {
    const observer = new MutationObserver(() => {
      if (!section.hidden) void restoreHaAgent(select.value)
    })
    observer.observe(section, { attributes: true, attributeFilter: ["hidden"] })
    pageLifecycle.signal.addEventListener("abort", () => observer.disconnect(), { once: true })
  }
  const save = document.querySelector<HTMLButtonElement>("#save-ha-agent")
  if (save) pageLifecycle.on(save, "click", withAsyncButton(save, async () => {
    await saveSetting("ha-assist-agent", select.value)
    sessionStorage.removeItem("meitheal:assist-agent")
    showToast(save.dataset.textSaved || "Agent setting saved.", "success")
  }, { loadingText: "Saving…", onError: showSettingsSaveError }))

  const test = document.querySelector<HTMLButtonElement>("#test-ha-agent")
  const result = document.getElementById("ha-agent-test-result")
  if (test && result) pageLifecycle.on(test, "click", withAsyncButton(test, async () => {
    const signal = pageLifecycle.signal
    result.textContent = test.dataset.textTesting ?? "Testing…"
    try {
      const response = await fetch("/api/ha/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello", ...(select.value ? { agent_id: select.value } : {}) }),
        signal,
      })
      const data = response.ok ? await response.json() : null
      result.textContent = data?.speech
        ? `${data.response_type === "error" ? "❌" : "✅"} "${data.speech}"`
        : test.dataset.textUnavailable ?? "Agent unavailable"
    } catch {
      if (!signal.aborted) result.textContent = test.dataset.textFailed ?? "Connection failed"
    }
  }, { loadingText: test.dataset.textTesting ?? "Testing…" }))
}

let agentDiscoveryVersion = 0

async function restoreHaAgent(savedAgent: unknown) {
  const select = document.querySelector<HTMLSelectElement>("#ha-agent-select-settings")
  if (!select) return
  const selected = typeof savedAgent === "string" ? savedAgent : select.value
  // Retain the persisted ID even if HA is disconnected on first load.
  if (selected && !Array.from(select.options).some(option => option.value === selected)) {
    select.add(new Option(selected, selected))
  }
  select.value = selected
  if (select.disabled) {
    renderAgentBadge(select)
    return
  }
  const version = ++agentDiscoveryVersion
  const signal = pageLifecycle.signal
  const status = document.getElementById("ha-agent-discovery-status")
  const refresh = document.querySelector<HTMLButtonElement>("#refresh-ha-agents")
  if (status) status.textContent = t("settings.ha_agent_loading", getClientLocale())
  if (refresh) {
    refresh.setAttribute("aria-disabled", "true")
    refresh.setAttribute("aria-busy", "true")
  }
  try {
    const agents = await fetchHaAgents(signal)
    if (signal.aborted || version !== agentDiscoveryVersion) return
    // A selection made while discovery was running wins over the old saved ID.
    const missing = renderHaAgentOptions(select, agents, select.value)
    renderAgentBadge(select)
    if (status) status.textContent = missing
      ? t("settings.ha_agent_selected_unavailable", getClientLocale())
      : agents.length ? t("settings.ha_agent_available_count", getClientLocale(), { count: String(agents.length) }) : t("settings.ha_agent_none", getClientLocale())
  } catch (error) {
    if (signal.aborted || version !== agentDiscoveryVersion) return
    renderAgentBadge(select, t("settings.ha_agent_discovery_unavailable", getClientLocale()))
    // The template adds its own full stop, so drop one that ends the server detail.
    const detail = error instanceof Error && error.message.trim()
      ? error.message.trim().replace(/[.。]+$/u, "")
      : t("settings.ha_agent_discovery_failed", getClientLocale())
    if (status) status.textContent = t("settings.ha_agent_discovery_retry", getClientLocale(), { error: detail })
  } finally {
    if (!signal.aborted && version === agentDiscoveryVersion && refresh) {
      refresh.setAttribute("aria-disabled", "false")
      refresh.setAttribute("aria-busy", "false")
    }
  }
}

function fixProtocolLinks(): void {
  document.querySelectorAll<HTMLAnchorElement>(".protocol-link[data-path]").forEach(el => {
    const path = el.dataset.path
    if (path) el.href = safeIngressHref(path)
  })
}

function updateExtAiBadge(select: HTMLSelectElement | null): void {
  const badge = document.getElementById("ext-ai-badge")
  if (!badge) return
  badge.textContent = aiHandoffEditable ? select?.selectedOptions[0]?.textContent ?? "" : ""
  badge.hidden = !badge.textContent
}

export function initAISettings(): void {
  initHaAgentSettings()
  initAgentTokensSettings()
  fixProtocolLinks()
  const checkDiscovery = document.querySelector<HTMLButtonElement>("#refresh-agent-discovery")
  if (checkDiscovery) pageLifecycle.on(checkDiscovery, "click", withAsyncButton(checkDiscovery, refreshProtocolDiscovery, {
    loadingText: checkDiscovery.dataset.checking ?? "",
  }))
  // AI provider custom URL toggle
  const aiProviderEl = document.querySelector<HTMLSelectElement>("#ai-provider")
  if (aiProviderEl) {
    pageLifecycle.on(aiProviderEl, "change", () => {
      const group = document.getElementById("ai-custom-url-group")
      if (group) {
        group.style.display = ["custom", "ollama"].includes(aiProviderEl.value) ? "" : "none"
      }
      updateExtAiBadge(aiProviderEl)
    })
  }

  const customUrlInput = document.querySelector<HTMLInputElement>("#ai-custom-url")
  const shareUrl = document.querySelector<HTMLInputElement>("#ai-custom-url-share")
  if (customUrlInput && shareUrl) pageLifecycle.on(customUrlInput, "input", () => { shareUrl.checked = false })

  // Save AI settings
  const saveAiBtn = document.querySelector<HTMLButtonElement>("#save-ai")
  if (saveAiBtn && aiProviderEl && customUrlInput && shareUrl) {
    pageLifecycle.on(saveAiBtn, "click", withAsyncButton(saveAiBtn, async () => {
      if (!aiHandoffEditable) return
      const provider = aiProviderEl.value
      const customUrl = customUrlInput.value.trim()
      const usesUrl = provider === "custom" || provider === "ollama"
      const url = usesUrl ? parseAiHandoffUrl(customUrl || (provider === "ollama" ? "http://localhost:11434" : "")) : null
      const share = shareUrl.checked
      if (usesUrl && (!url || (share && !customUrl))) {
        showToast("settings.ext_ai_invalid_url", "error")
        return
      }
      const signal = pageLifecycle.signal
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          key: "ai-provider",
          value: provider,
          ...(url ? { custom_url: url.href, share_custom_url: share } : {}),
          previous_provider: savedAiProvider,
          previous_custom_url: savedAiUrl,
          previously_shared: savedAiUrlShared,
        }),
      })
      if (response.status === 409) {
        settingsStore.invalidate()
        if (!signal.aborted) showToast("settings.ai_custom_url_conflict", "error")
        return
      }
      if (!response.ok) throw new Error(`AI provider settings save failed: ${response.status}`)
      settingsStore.invalidate()
      const saved = await response.json()
      if (saved.key !== "ai-provider" || saved.value !== provider ||
        (url && (saved.custom_url !== url.href || saved.share_custom_url !== share))) {
        throw new Error("Invalid AI provider settings receipt")
      }
      if (signal.aborted) return
      savedAiProvider = provider
      if (url) {
        savedAiUrl = url.href
        savedAiUrlShared = share
        if (customUrlInput.value.trim() === customUrl) customUrlInput.value = url.href
      }
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

    try {
      await saveSettings({
        "agent-protocols-a2a-enabled": a2a,
        [WEBMCP_SETTING]: webmcp,
        "agent-protocols-mcp-enabled": mcp,
      })
    } finally {
      // A later key may fail after WebMCP was saved. Recheck actual persistence
      // rather than granting tools from an unsaved checkbox or stale cache.
      notifyWebMcpPreferenceChanged()
      void refreshProtocolDiscovery()
    }

    showToast("settings.agent_protocols_saved")
    }, { loadingText: "Saving…", onError: showSettingsSaveError }))
  }
}

/** Restore AI & agent protocol settings from loaded settings object */
export function restoreAISettings(s: Record<string, unknown>): void {
  void restoreHaAgent(s["ha-assist-agent"])
  // AI provider
  aiHandoffEditable = s["ai-handoff-editable"] === true
  savedAiProvider = typeof s["ai-provider"] === "string" ? s["ai-provider"] : null
  const provider = document.querySelector<HTMLSelectElement>("#ai-provider")
  if (provider) {
    provider.disabled = !aiHandoffEditable
    provider.value = savedAiProvider ?? "chatgpt"
  }
  const editor = document.getElementById("ai-provider-editor")
  if (editor) editor.hidden = !aiHandoffEditable
  updateExtAiBadge(provider)
  const group = document.getElementById("ai-custom-url-group")
  if (group) group.style.display = savedAiProvider === "custom" || savedAiProvider === "ollama" ? "" : "none"
  savedAiUrl = typeof s["ai-custom-url"] === "string" ? s["ai-custom-url"] : null
  savedAiUrlShared = Boolean(savedAiUrl) && s["ai-custom-url-approved"] === savedAiUrl
  const urlInput = document.querySelector<HTMLInputElement>("#ai-custom-url")
  if (urlInput) {
    urlInput.disabled = !aiHandoffEditable
    urlInput.value = savedAiUrl ?? ""
  }
  const shareUrl = document.querySelector<HTMLInputElement>("#ai-custom-url-share")
  if (shareUrl) {
    shareUrl.disabled = !aiHandoffEditable
    shareUrl.checked = savedAiUrlShared
  }
  const save = document.querySelector<HTMLButtonElement>("#save-ai")
  if (save) save.disabled = !aiHandoffEditable
  const unavailable = document.getElementById("ai-provider-unavailable")
  if (unavailable) unavailable.hidden = aiHandoffEditable

  // Agent Protocols
  const a2aEnabled = s["agent-protocols-a2a-enabled"]
  const webmcpEnabled = s[WEBMCP_SETTING]
  // Bootstrap may predate an opt-out in another tab. Do not grant from its snapshot.
  refreshWebMcpPreference()
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

  void refreshProtocolDiscovery()
}
