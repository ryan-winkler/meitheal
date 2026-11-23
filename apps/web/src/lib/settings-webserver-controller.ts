/**
 * Webserver Settings Client Controller
 *
 * Progressive-enhancement controller for #webserver-settings and the unified
 * MCP endpoint readout inside #ai-agents-settings -> Agent Protocols.
 * Uses pure domain validators (`parsePortSpec`, `validateWebserverUrl`)
 * so server-only SQLite or Supervisor modules never enter client bundles.
 *
 * @domain webserver
 * @bounded-context configuration
 */
import {
  parsePortSpec,
  validateWebserverUrl,
  type WebserverActiveRuntime,
  type WebserverCheckItem,
  type WebserverConfig,
  type WebserverConfigProvenance,
  type WebserverFieldProvenance,
  type WebserverRuntimeEnv,
  type WebserverSecurityNotice,
} from "@domains/webserver/webserver-config"
import { pageLifecycle } from "@lib/page-lifecycle"
import { openSettingsHelpModal } from "@lib/settings-help-controller"
import { showToast } from "@lib/toast"

interface SupervisorView {
  mode: "ha-addon" | "standalone"
  supervisorAvailable: boolean
  haConnected: boolean
  haVersion: string | null
  ingressUrl: string | null
  detectedHaUrl: string | null
  interfaces: Array<{ address: string; label: string }>
  supervisorServices: Array<{ name: string; available: boolean }>
}

interface WebserverApiPayload {
  config: WebserverConfig
  securityNotices: WebserverSecurityNotice[]
  supervisor: SupervisorView
  runtimeEnv?: WebserverRuntimeEnv
  provenance?: WebserverConfigProvenance
  activeRuntime?: WebserverActiveRuntime
  checks?: WebserverCheckItem[]
  supervisorSync?: { synced: boolean; detail: string }
}

type ProvenanceField = keyof WebserverConfigProvenance
type WebserverHelpEntry = { title: string; paragraphs: string[]; envKey?: keyof WebserverRuntimeEnv; provKey?: ProvenanceField }

function readWebserverHelpDocs(): Record<string, WebserverHelpEntry> {
  const node = document.getElementById("ws-help-topics")
  if (!node) return {}
  try {
    return JSON.parse(node.textContent || "{}") as Record<string, WebserverHelpEntry>
  } catch {
    return {}
  }
}

function formatProvenance(p: WebserverFieldProvenance): { label: string; cls: string } {
  if (p.source === "database") return { label: "Saved", cls: "ws-source ws-source--db" }
  if (p.source === "supervisor") return { label: "HA Auto", cls: "ws-source ws-source--env" }
  if (p.source === "process_env") return { label: p.envVar ? `env · ${p.envVar}` : "process.env", cls: "ws-source ws-source--env" }
  if (p.source === "dotenv") return { label: p.envVar ? `.env · ${p.envVar}` : ".env", cls: "ws-source ws-source--env" }
  return { label: "Default", cls: "ws-source" }
}

const el = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null

function pill(text: string, tone?: "accent" | "ok" | "warn" | "danger"): HTMLSpanElement {
  const s = document.createElement("span")
  s.className = tone ? `ws-pill ws-pill--${tone}` : "ws-pill"
  s.textContent = text
  return s
}

function safeHttpHref(candidate: string | null): string | null {
  if (!candidate) return null
  try {
    const u = new URL(candidate, window.location.origin)
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null
  } catch {
    return null
  }
}

export function initWebserverSettings(): void {
  const form = el<HTMLFormElement>("ws-settings-form")
  if (!form) return

  const serverName = el<HTMLInputElement>("ws-server-name")
  const internalUrl = el<HTMLInputElement>("ws-internal-url")
  const externalUrl = el<HTMLInputElement>("ws-external-url")
  const haUrl = el<HTMLInputElement>("ws-ha-url")
  const ports = el<HTMLInputElement>("ws-ports")
  const bind = el<HTMLSelectElement>("ws-bind-address")
  const tls = el<HTMLInputElement>("ws-tls-enabled")
  const cert = el<HTMLInputElement>("ws-ssl-cert")
  const key = el<HTMLInputElement>("ws-ssl-key")
  const keyToggle = el<HTMLButtonElement>("ws-ssl-key-toggle")
  const keyBadge = el("ws-ssl-key-badge")
  const syncHa = el<HTMLInputElement>("ws-sync-ha-options")
  const advToggle = el<HTMLInputElement>("ws-advanced-toggle")
  const advPanel = el("ws-advanced-panel")
  const mcpUrlText = el("ws-mcp-url-text")
  const copyMcp = el<HTMLButtonElement>("ws-copy-mcp-btn")
  const haAiRow = el("ws-ha-ai-row")
  const haAiUrlText = el("ws-ha-ai-url-text")
  const haAiLink = el<HTMLAnchorElement>("ws-ha-ai-link")
  const haAiNote = el("ws-ha-ai-note")
  const useHaBtn = el<HTMLButtonElement>("ws-use-detected-ha-btn")
  const portsPreview = el("ws-ports-preview")
  const portsErr = el("ws-ports-error")
  const intErr = el("ws-internal-url-error")
  const extErr = el("ws-external-url-error")
  const haErr = el("ws-ha-url-error")
  const haBadge = el("ws-ha-status-badge")
  const supBadge = el("ws-supervisor-mode-badge")
  const supSummary = el("ws-supervisor-summary")
  const supServices = el("ws-supervisor-services")
  const envSummary = el("ws-env-summary")
  const secMsg = el("ws-security-message")
  const dirtyBadge = el("ws-dirty-badge")
  const verifyBtn = el<HTMLButtonElement>("ws-verify-btn")
  const verifyList = el<HTMLUListElement>("ws-verify-results")
  const saveBtn = el<HTMLButtonElement>("ws-save-btn")
  const saveStatus = el("ws-save-status")
  const refreshBtn = el<HTMLButtonElement>("ws-refresh-btn")
  const restartBanner = el("ws-restart-banner")

  // Unified AI Settings -> Agent Protocols mirrors
  const agentMcpText = el("agent-mcp-url-display")
  const agentMcpCopy = el<HTMLButtonElement>("agent-mcp-copy-btn")
  const agentHaAiLink = el<HTMLAnchorElement>("agent-ha-ai-link")

  let sup: SupervisorView | null = null
  let runtimeEnv: WebserverRuntimeEnv | null = null
  let provenance: WebserverConfigProvenance | null = null
  let activeRuntime: WebserverActiveRuntime | null = null
  let savedKey = ""
  let liveMcpUrl = `${window.location.origin}/api/mcp`

  const draft = () => ({
    serverName: serverName?.value.trim() ?? "",
    internalUrl: internalUrl?.value.trim() ?? "",
    externalUrl: externalUrl?.value.trim() ?? "",
    homeAssistantUrl: haUrl?.value.trim() ?? "",
    portsSpec: ports?.value.trim() ?? "",
    bindAddress: bind?.value ?? "0.0.0.0",
    tlsEnabled: Boolean(tls?.checked),
    sslCertificate: cert?.value.trim() ?? "",
    sslPrivateKey: key?.value.trim() || undefined,
    syncHaOptions: Boolean(syncHa?.checked),
  })

  const snap = () => {
    const d = draft()
    return JSON.stringify({ ...d, sslPrivateKey: d.sslPrivateKey ? "1" : "" })
  }

  const showErr = (node: HTMLElement | null, msg: string) => {
    if (!node) return
    node.textContent = msg
    node.hidden = !msg
  }

  async function copyCurrentMcpUrl(): Promise<void> {
    try {
      await navigator.clipboard.writeText(liveMcpUrl)
      showToast("MCP Server URL copied", "success")
    } catch {
      showToast("Could not copy MCP Server URL", "error")
    }
  }

  function openHelp(keyName: string, trigger?: HTMLElement): void {
    const doc = readWebserverHelpDocs()[keyName]
    if (!doc) return
    const parts: string[] = []
    if (doc.provKey && provenance) parts.push(`Active source: ${formatProvenance(provenance[doc.provKey]).label}`)
    const envVal = doc.envKey && runtimeEnv ? runtimeEnv[doc.envKey] : ""
    if (typeof envVal === "string" && envVal) parts.push(`Env default: ${envVal}`)
    openSettingsHelpModal({
      title: doc.title,
      paragraphs: doc.paragraphs,
      env: parts.join(" · "),
      trigger,
    })
  }

  function refreshPreview(): boolean {
    const d = draft()
    const iRes = validateWebserverUrl(d.internalUrl, "Internal URL")
    const eRes = validateWebserverUrl(d.externalUrl, "External URL")
    const hRes = validateWebserverUrl(d.homeAssistantUrl, "Home Assistant URL")
    showErr(intErr, iRes.ok ? "" : iRes.error)
    showErr(extErr, eRes.ok ? "" : eRes.error)
    showErr(haErr, hRes.ok ? "" : hRes.error)
    let ok = iRes.ok && eRes.ok && hRes.ok

    const pRes = parsePortSpec(d.portsSpec)
    if (portsPreview) {
      if (pRes.ok) {
        showErr(portsErr, "")
        const chips = [pill(`${pRes.ports.length} ${pRes.ports.length === 1 ? "port" : "ports"} (${pRes.mode})`, "accent")]
        for (const p of pRes.ports.slice(0, 8)) chips.push(pill(String(p)))
        if (pRes.ports.length > 8) chips.push(pill(`+${pRes.ports.length - 8} more`))
        if (pRes.hasPrivilegedPorts) chips.push(pill("Privileged < 1024", "warn"))
        portsPreview.replaceChildren(...chips)
      } else {
        portsPreview.replaceChildren()
        showErr(portsErr, pRes.error)
        ok = false
      }
    }

    const base = (eRes.ok && eRes.value)
      || (iRes.ok && iRes.value)
      || window.location.origin
    liveMcpUrl = `${base}/api/mcp`
    if (mcpUrlText) mcpUrlText.textContent = liveMcpUrl
    if (agentMcpText) agentMcpText.textContent = liveMcpUrl

    const resolvedHa = (hRes.ok && hRes.value) || sup?.detectedHaUrl || null
    const haAiHref = resolvedHa ? safeHttpHref(`${resolvedHa}/config/ai`) : null

    if (haAiRow && haAiLink) {
      if (haAiHref) {
        haAiLink.href = haAiHref
        if (haAiUrlText) haAiUrlText.textContent = `${resolvedHa}/config/ai`
        haAiRow.hidden = false
      } else {
        haAiLink.removeAttribute("href")
        haAiRow.hidden = true
      }
    }
    if (agentHaAiLink) {
      if (haAiHref) {
        agentHaAiLink.href = haAiHref
        agentHaAiLink.hidden = false
      } else {
        agentHaAiLink.removeAttribute("href")
        agentHaAiLink.hidden = true
      }
    }
    if (haAiNote) {
      haAiNote.textContent = resolvedHa
        ? ""
        : "Attach Home Assistant or enter your Home Assistant URL above to show a direct link to {Domain}/config/ai."
      haAiNote.hidden = Boolean(resolvedHa)
    }

    if (saveBtn) saveBtn.disabled = !ok
    if (dirtyBadge) dirtyBadge.hidden = !savedKey || snap() === savedKey
    return ok
  }

  function renderChecks(checks: WebserverCheckItem[]): void {
    if (!verifyList) return
    verifyList.replaceChildren(...checks.map((c) => {
      const li = document.createElement("li")
      const tone = c.status === "pass" ? "ok" : c.status === "warn" ? "warn" : "danger"
      const b = pill(c.status === "pass" ? "OK" : c.status === "warn" ? "Note" : "Fix", tone)
      const div = document.createElement("div")
      const strong = document.createElement("strong")
      strong.textContent = `${c.label}: `
      div.append(strong, document.createTextNode(c.detail))
      li.append(b, div)
      return li
    }))
    verifyList.hidden = checks.length === 0
  }

  function apply(data: WebserverApiPayload): void {
    sup = data.supervisor
    runtimeEnv = data.runtimeEnv ?? null
    provenance = data.provenance ?? null
    activeRuntime = data.activeRuntime ?? null
    const c = data.config
    if (serverName) serverName.value = c.serverName
    if (internalUrl) internalUrl.value = c.internalUrl
    if (externalUrl) externalUrl.value = c.externalUrl
    if (haUrl) haUrl.value = c.homeAssistantUrl
    if (ports) ports.value = c.portsSpec
    if (tls) tls.checked = c.tlsEnabled
    if (cert) cert.value = c.sslCertificate
    if (key) {
      key.value = ""
      key.placeholder = c.sslPrivateKeyConfigured ? "Stored securely — enter a new key to replace" : "/ssl/privkey.pem"
    }
    if (keyBadge) keyBadge.hidden = !c.sslPrivateKeyConfigured
    if (syncHa) syncHa.checked = c.syncHaOptions

    if (provenance) {
      for (const node of form?.querySelectorAll<HTMLElement>("[data-ws-source]") ?? []) {
        const keyName = node.dataset.wsSource as ProvenanceField | undefined
        if (!keyName || !provenance[keyName]) continue
        const fmt = formatProvenance(provenance[keyName])
        node.className = fmt.cls
        node.textContent = fmt.label
        node.hidden = false
      }
    }

    if (restartBanner) {
      if (activeRuntime?.restartRequired) {
        restartBanner.textContent = `Restart required: live server is bound to ${activeRuntime.listeningHost}:${activeRuntime.listeningPortsSpec}, while saved config is ${c.bindAddress}:${c.portsSpec}.`
        restartBanner.hidden = false
      } else {
        restartBanner.hidden = true
      }
    }

    if (bind && sup.interfaces.length > 0) {
      const opts = sup.interfaces.map((i) => {
        const o = document.createElement("option")
        o.value = i.address
        o.textContent = i.label
        return o
      })
      if (!sup.interfaces.some((i) => i.address === c.bindAddress)) {
        const o = document.createElement("option")
        o.value = c.bindAddress
        o.textContent = c.bindAddress
        opts.push(o)
      }
      bind.replaceChildren(...opts)
      bind.value = c.bindAddress
    }

    if (haBadge) {
      haBadge.className = sup.haConnected ? "ws-pill ws-pill--ok" : "ws-pill"
      haBadge.textContent = sup.haConnected
        ? `HA connected${sup.haVersion ? ` · ${sup.haVersion}` : ""}`
        : (sup.mode === "ha-addon" ? "HA Add-on" : "Standalone mode")
    }
    if (supBadge) {
      supBadge.className = sup.supervisorAvailable ? "ws-pill ws-pill--ok" : "ws-pill"
      supBadge.textContent = sup.supervisorAvailable ? "Supervisor API active" : (sup.mode === "ha-addon" ? "Add-on mode" : "Standalone")
    }
    if (supSummary) {
      supSummary.textContent = sup.supervisorAvailable
        ? `Connected to Home Assistant Supervisor${sup.ingressUrl ? ` (Ingress ${sup.ingressUrl})` : ""}. Webserver options sync with Supervisor and appear in /api/ha/services.`
        : "Running standalone. Webserver options remain available via /api/webserver and /api/ha/services; Supervisor sync activates automatically inside Home Assistant OS."
    }
    if (supServices) {
      const svcs = sup.supervisorServices
      supServices.replaceChildren(
        ...(svcs.length > 0
          ? svcs.map((s) => pill(s.name, s.available ? "ok" : undefined))
          : [pill("Exposed via /api/ha/services", "accent")]),
      )
    }
    if (envSummary && runtimeEnv) {
      const items: HTMLSpanElement[] = []
      if (activeRuntime) {
        items.push(pill(
          `Listening: ${activeRuntime.listeningHost}:${activeRuntime.listeningPortsSpec}`,
          activeRuntime.restartRequired ? "warn" : "ok",
        ))
        items.push(pill(
          activeRuntime.dotenvFound
            ? `${activeRuntime.dotenvLabel ?? ".env"} (${activeRuntime.dotenvKeys.length} keys)`
            : "No .env file",
        ))
      }
      items.push(
        pill(`${runtimeEnv.sources.ports}: ${runtimeEnv.ports}`),
        pill(`${runtimeEnv.sources.bindAddress}: ${runtimeEnv.bindAddress}`),
      )
      if (runtimeEnv.externalUrl) items.push(pill(`${runtimeEnv.sources.externalUrl}: ${runtimeEnv.externalUrl}`))
      if (runtimeEnv.homeAssistantUrl) items.push(pill(`${runtimeEnv.sources.homeAssistantUrl}: ${runtimeEnv.homeAssistantUrl}`))
      if (runtimeEnv.timezone) items.push(pill(`TZ: ${runtimeEnv.timezone}`))
      envSummary.replaceChildren(...items)
    }
    if (useHaBtn) useHaBtn.hidden = !sup.detectedHaUrl || sup.detectedHaUrl === c.homeAssistantUrl
    if (secMsg && data.securityNotices[0]) secMsg.textContent = data.securityNotices[0].message

    savedKey = snap()
    refreshPreview()
  }

  async function load(): Promise<void> {
    try {
      const res = await fetch("/api/webserver", { cache: "no-store" })
      if (!res.ok) {
        if (haBadge) {
          haBadge.className = "ws-pill ws-pill--warn"
          haBadge.textContent = res.status === 403 ? "Admin required" : "Local defaults"
        }
        refreshPreview()
        return
      }
      apply((await res.json()) as WebserverApiPayload)
    } catch {
      if (haBadge) haBadge.textContent = "Local defaults"
      refreshPreview()
    }
  }

  // Wire all (?) help buttons to the unified Tabler Help Modal
  document.querySelectorAll<HTMLButtonElement>("[data-ws-help]").forEach((btn) => {
    pageLifecycle.on(btn, "click", () => openHelp(btn.dataset.wsHelp ?? "", btn))
  })

  if (advToggle && advPanel) {
    pageLifecycle.on(advToggle, "change", () => { advPanel.hidden = !advToggle.checked })
  }
  if (keyToggle && key) {
    pageLifecycle.on(keyToggle, "click", () => {
      const reveal = key.type === "password"
      key.type = reveal ? "text" : "password"
      keyToggle.setAttribute("aria-pressed", String(reveal))
      keyToggle.setAttribute("aria-label", reveal ? "Hide SSL private key" : "Show SSL private key")
      const off = keyToggle.querySelector<HTMLElement>("[data-eye-off]")
      const on = keyToggle.querySelector<HTMLElement>("[data-eye-on]")
      if (off) off.hidden = reveal
      if (on) on.hidden = !reveal
    })
  }
  if (useHaBtn && haUrl) {
    pageLifecycle.on(useHaBtn, "click", () => {
      if (!sup?.detectedHaUrl) return
      haUrl.value = sup.detectedHaUrl
      useHaBtn.hidden = true
      refreshPreview()
    })
  }
  if (copyMcp) pageLifecycle.on(copyMcp, "click", () => { void copyCurrentMcpUrl() })
  if (agentMcpCopy) pageLifecycle.on(agentMcpCopy, "click", () => { void copyCurrentMcpUrl() })

  for (const field of [serverName, internalUrl, externalUrl, haUrl, ports, bind, tls, cert, key, syncHa]) {
    if (!field) continue
    pageLifecycle.on(field, field.tagName === "SELECT" || field.type === "checkbox" ? "change" : "input", () => {
      refreshPreview()
    })
  }

  if (refreshBtn) pageLifecycle.on(refreshBtn, "click", () => { void load() })

  if (verifyBtn) {
    pageLifecycle.on(verifyBtn, "click", async () => {
      verifyBtn.disabled = true
      try {
        const res = await fetch("/api/webserver/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft()),
        })
        const data = (await res.json()) as { ok?: boolean; checks?: WebserverCheckItem[]; error?: string }
        if (Array.isArray(data.checks)) renderChecks(data.checks)
        showToast(data.ok ? "Webserver configuration verified" : (data.error ?? "Check failed"), data.ok ? "success" : "error")
      } catch {
        showToast("Could not verify webserver configuration", "error")
      } finally {
        verifyBtn.disabled = false
      }
    })
  }

  pageLifecycle.on(form, "submit", async (e) => {
    e.preventDefault()
    if (!refreshPreview()) return
    if (saveBtn) saveBtn.disabled = true
    try {
      const res = await fetch("/api/webserver", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft()),
      })
      const data = (await res.json()) as WebserverApiPayload & { detail?: string; error?: string }
      if (!res.ok) {
        const msg = data.detail ?? data.error ?? "Could not save webserver settings"
        if (saveStatus) saveStatus.textContent = msg
        showToast(msg, "error")
        return
      }
      apply(data)
      if (Array.isArray(data.checks)) renderChecks(data.checks)
      if (saveStatus) saveStatus.textContent = data.supervisorSync?.detail ?? "Webserver settings saved."
      showToast("Webserver settings saved", "success")
    } catch {
      showToast("Could not save webserver settings", "error")
    } finally {
      if (saveBtn) saveBtn.disabled = false
    }
  })

  refreshPreview()
  void load()
}
