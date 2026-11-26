/**
 * Settings -> Plugins Controller
 *
 * Drives Plugin Health, External Connectors, Installed Custom
 * Plugins, 2-step "Build one with AI" modal, and Reference/Get Listed dialogs.
 */
import { createSpriteIconElement } from "../generated/icon-registry"
import { copyToClipboard } from "@lib/clipboard"
import { pageLifecycle } from "@lib/page-lifecycle"
import { byId, domEl as el, whenSectionVisible } from "@lib/settings-utils"
import { showToast } from "@lib/toast"

type Tone = "healthy" | "warning" | "critical" | "inactive"

interface HealthCheck {
  id: string
  label: string
  status: "pass" | "warn" | "fail"
  detail: string
}

interface HealthReport {
  pluginId: string
  overall: Tone
  operationalState: string
  operationalLabel: string
  securityTone: Tone
  securityLabel: string
  passedChecks: number
  totalChecks: number
  checks: HealthCheck[]
  remediation?: string
}

interface ConnectorField {
  key: string
  label: string
  type: "text" | "url" | "secret" | "number" | "boolean"
  secretKey?: string
  placeholder?: string
  help?: string
}

interface PluginView {
  id: string
  source: "builtin" | "uploaded"
  enabled: boolean
  needsReconsent: boolean
  iconSvg: string | null
  config: Record<string, unknown>
  secrets: Array<{ key: string; configured: boolean }>
  health: HealthReport
  manifest: {
    id: string
    name: string
    version: string
    description: string
    author: string
    sidePanel?: boolean
    permissions: string[]
    allowedHosts: string[]
    dataSharing: { outbound: boolean; summary: string }
    connector?: { configFields: ConnectorField[] }
  }
}

const SVG_TAGS = new Set(["svg", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "g", "title"])
const SVG_ATTRS = new Set([
  "xmlns", "viewbox", "width", "height", "fill", "stroke", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "d", "cx", "cy", "r", "rx", "ry",
  "x", "y", "x1", "y1", "x2", "y2", "points", "transform",
])
const JSON_HDR = { "Content-Type": "application/json" }

const apiReq = (url: string, method: string, body?: unknown) =>
  window.fetch(url, { method, ...(body !== undefined ? { headers: JSON_HDR, body: JSON.stringify(body) } : {}) })

async function copyText(text: string, okMsg: string): Promise<void> {
  const ok = await copyToClipboard(text)
  showToast(ok ? okMsg : "Could not copy to clipboard.", ok ? "success" : "error")
}

function makeBadge(tone: Tone, label: string): HTMLElement {
  const b = el("span", "plg-badge")
  b.dataset.tone = tone
  const d = el("span", "plg-dot")
  d.setAttribute("aria-hidden", "true")
  b.append(d, el("span", "", label))
  return b
}

function buildAiPrompt(idea: string, template: string): string {
  const goal = idea.trim() || "A local-only Meitheal task helper with a side panel."
  return template.replace("__GOAL__", goal)
}

function getRuntimeErrors(): Record<string, string> {
  const errs = (window as unknown as { __meithealPluginErrors?: Record<string, string> }).__meithealPluginErrors
  return errs && typeof errs === "object" ? errs : {}
}

function effectiveHealth(p: PluginView, err?: string): HealthReport {
  if (!err || !p.enabled || p.health.operationalState === "paused_safe_mode") return p.health
  return { ...p.health, overall: "critical", operationalState: "error", operationalLabel: "Runtime Error", remediation: err }
}

function parseAiBundle(raw: string): { ok: true; bundle: Record<string, unknown> } | { ok: false; error: string } {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
  if (!cleaned) return { ok: false, error: "Paste the JSON bundle returned by your AI." }
  try {
    const obj = JSON.parse(cleaned) as Record<string, unknown> | null
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || !obj.manifest || typeof obj.manifest !== "object" || Array.isArray(obj.manifest)) {
      return { ok: false, error: 'Expected a JSON object containing a "manifest" object.' }
    }
    return { ok: true, bundle: obj }
  } catch {
    return { ok: false, error: "Invalid JSON syntax. Paste only the JSON block from your AI." }
  }
}

function renderSvg(svgText: string | null): HTMLElement {
  const wrap = el("span", "plg-card__icon")
  wrap.setAttribute("aria-hidden", "true")
  if (svgText?.trim().startsWith("<svg")) {
    const svg = new DOMParser().parseFromString(svgText, "image/svg+xml").documentElement
    if (svg.tagName.toLowerCase() === "svg" && !svg.querySelector("parsererror")) {
      for (const n of [svg, ...Array.from(svg.querySelectorAll("*"))]) {
        if (!SVG_TAGS.has(n.tagName.toLowerCase())) { n.remove(); continue }
        for (const a of Array.from(n.attributes)) {
          if (!SVG_ATTRS.has(a.name.toLowerCase()) || /(?:javascript|data):/i.test(a.value)) n.removeAttribute(a.name)
        }
      }
      wrap.append(document.importNode(svg, true))
      return wrap
    }
  }
  wrap.textContent = "P"
  return wrap
}

export function initPluginsSettings(): void {
  const root = byId("plugins-settings")
  if (!root || root.dataset.pluginsBound === "true") return
  root.dataset.pluginsBound = "true"

  const safeModeInput = byId<HTMLInputElement>("plugins-safe-mode")
  const healthShowAll = byId<HTMLInputElement>("plugins-health-show-all")
  const healthSummaryEl = byId("plugins-health-summary")
  const healthListEl = byId("plugins-health-list")
  const connectorsGrid = byId("plugins-connectors-grid")
  const uploadedGrid = byId("plugins-uploaded-grid")
  const uploadedEmpty = byId("plugins-uploaded-empty")
  const uploadInput = byId<HTMLInputElement>("plugins-zip-input")
  const uploadFeedback = byId("plugins-upload-feedback")
  const removeAllBtn = byId<HTMLButtonElement>("plugins-remove-all-btn")
  const aiDialog = byId<HTMLDialogElement>("plugins-ai-dialog")
  const submitDialog = byId<HTMLDialogElement>("plugins-submit-dialog")
  const guideDialog = byId<HTMLDialogElement>("plugins-guide-dialog")
  const aiStep1 = byId("plugins-ai-step-1")
  const aiStep2 = byId("plugins-ai-step-2")
  const aiIdeaInput = byId<HTMLTextAreaElement>("plugins-ai-idea")
  const aiJsonInput = byId<HTMLTextAreaElement>("plugins-ai-json")
  const aiPreviewEl = byId("plugins-ai-preview")
  const aiErrorEl = byId("plugins-ai-error")
  const aiInstallBtn = byId<HTMLButtonElement>("plugins-ai-install-btn")

  let plugins: PluginView[] = []
  let catalogLoaded = false
  let safeMode = false
  let aiBundle: Record<string, unknown> | null = null
  const openDetails = new Set<string>()
  const openAudits = new Set<string>()

  const setFeedback = (msg: string, isErr = false) => {
    if (!uploadFeedback) return
    uploadFeedback.hidden = !msg
    uploadFeedback.textContent = msg
    uploadFeedback.dataset.tone = isErr ? "error" : "ok"
  }

  function renderHealth(): void {
    if (!catalogLoaded || !healthSummaryEl || !healthListEl) return
    const errs = getRuntimeErrors()
    const list = plugins.map((p) => ({ p, h: effectiveHealth(p, errs[p.id]) }))
    const enabled = plugins.filter(p => p.enabled).length
    const attention = list.filter(({ p, h }) => h.overall === "critical" ||
      (p.enabled && h.overall === "warning" && h.operationalState !== "paused_safe_mode")).length
    const text = enabled === 0 ? "No plugins are enabled." : safeMode ? `Safe Mode is on. ${enabled} paused.` : `${enabled} enabled.`
    const overview = attention ? `${text} ${attention} need attention.` : text
    if (healthSummaryEl.textContent !== overview) healthSummaryEl.textContent = overview
    if (healthShowAll) healthShowAll.disabled = !list.some(({ h }) => h.operationalState === "disabled")

    const focused = healthListEl.contains(document.activeElement)
      ? document.activeElement?.closest<HTMLElement>("[data-plugin-health-id]")?.dataset.pluginHealthId
      : undefined
    for (const article of healthListEl.querySelectorAll<HTMLElement>("[data-plugin-health-id]")) {
      const id = article.dataset.pluginHealthId!
      if (article.querySelector("details")?.open) openAudits.add(id)
      else openAudits.delete(id)
    }
    healthListEl.replaceChildren()

    for (const { p, h } of list) {
      if (!healthShowAll?.checked && h.operationalState === "disabled" && h.overall !== "critical") continue
      const row = el("article", "plg-health-row")
      row.dataset.pluginHealthId = p.id
      const name = el("div", "plg-health-row__name")
      name.append(el("h4", "plg-card__title", p.manifest.name), el("span", "plg-card__sub", `v${p.manifest.version} · ${p.source === "builtin" ? "Built-in" : "Uploaded"}`))
      const top = el("div", "plg-health-row__top")
      top.append(name, makeBadge(h.operationalState === "operational" || h.operationalState === "disabled" ? "inactive" : h.overall, h.operationalLabel))
      row.append(top)
      if (h.remediation) row.append(el("p", "plg-health-row__rem", h.remediation))

      const det = el("details", "plg-audit")
      det.open = openAudits.has(p.id)
      const summary = el("summary", "plg-audit-toggle")
      const label = el("span", "", "Security checks")
      const count = el("span", "plg-card__sub", `${h.passedChecks} of ${h.totalChecks} passed`)
      const icon = createSpriteIconElement("chevron-down", { size: 16 })
      icon.setAttribute("aria-hidden", "true")
      summary.append(label, count, icon)
      const checks = el("ul", "plg-checks")
      checks.setAttribute("role", "list")
      for (const check of h.checks) {
        const item = el("li", "plg-check")
        item.dataset.checkStatus = check.status
        const outcome = check.status === "pass" ? "Passed" : check.status === "warn" ? "Review" : "Failed"
        const mark = createSpriteIconElement(check.status === "pass" ? "check" : check.status === "warn" ? "alert-triangle" : "x", { size: 17 })
        mark.setAttribute("aria-hidden", "true")
        const copy = el("div")
        copy.append(el("strong", "plg-check__title", check.label), el("span", check.status === "pass" ? "sr-only" : "plg-check__outcome", outcome), el("p", "plg-check__detail", check.detail))
        item.append(mark, copy)
        checks.append(item)
      }
      det.append(summary, checks)
      row.append(det)
      healthListEl.append(row)
      if (focused === p.id) summary.focus({ preventScroll: true })
    }
  }

  function buildCard(p: PluginView): HTMLElement {
    const h = effectiveHealth(p, getRuntimeErrors()[p.id])
    const pid = encodeURIComponent(p.id)
    const card = el("article", "plg-card")
    card.dataset.pluginId = p.id

    const head = el("div", "plg-card__head")
    const idBox = el("div", "plg-card__id")
    const meta = el("div", "plg-card__meta")
    meta.append(el("h4", "plg-card__title", p.manifest.name), el("div", "plg-card__sub", `v${p.manifest.version} by ${p.manifest.author}`))
    idBox.append(renderSvg(p.iconSvg), meta)

    const sw = el("label", "toggle-switch")
    const tog = el("input")
    tog.type = "checkbox"
    tog.checked = p.enabled
    tog.disabled = p.needsReconsent
    tog.setAttribute("aria-label", `Enable ${p.manifest.name}`)
    const sl = el("span", "toggle-slider")
    sl.setAttribute("aria-hidden", "true")
    sw.append(tog, sl)
    tog.addEventListener("change", async () => {
      tog.disabled = true
      try {
        const res = await apiReq(`/api/plugins/${pid}`, "PATCH", { enabled: tog.checked })
        const d = (await res.json().catch(() => ({}))) as { detail?: string }
        if (!res.ok) { tog.checked = !tog.checked; showToast(d.detail || "Could not update plugin.", "error"); return }
        showToast(`${p.manifest.name} ${tog.checked ? "enabled" : "disabled"}.`, "success")
        await loadCatalog(true)
      } finally { tog.disabled = p.needsReconsent }
    })
    head.append(idBox, sw)
    card.append(head, el("p", "plg-card__desc", p.manifest.description))

    if (p.enabled || p.needsReconsent || h.overall === "critical") {
      const line = el("div", "plg-card__health-line")
      line.append(makeBadge(h.overall, h.operationalLabel), makeBadge(h.securityTone, h.securityLabel))
      card.append(line)
    }

    const det = el("details", "plg-details")
    if (openDetails.has(p.id)) det.open = true
    det.addEventListener("toggle", () => (det.open ? openDetails.add(p.id) : openDetails.delete(p.id)))
    const body = el("div", "plg-details__body")

    if (p.needsReconsent) {
      const w = el("div", "plg-alert--warn")
      const btn = el("button", "btn btn-primary btn-sm", "Approve permissions")
      btn.type = "button"
      btn.addEventListener("click", async () => {
        if ((await apiReq(`/api/plugins/${pid}`, "PATCH", { approveReconsent: true })).ok) {
          showToast("Permissions approved.", "success")
          await loadCatalog(false)
        }
      })
      w.append(el("p", "", "This upgraded plugin requests new permissions or external hosts."), btn)
      body.append(w)
    }

    const permRow = el("div", "plg-meta-block")
    const chips = el("div", "plg-chip-list")
    p.manifest.permissions.forEach((perm) => chips.append(el("span", "plg-chip", perm)))
    permRow.append(el("div", "plg-meta-label", `Permissions (${p.manifest.permissions.length})`), chips)
    const ds = el("div", "plg-meta-block")
    ds.append(el("div", "plg-meta-label", p.manifest.dataSharing.outbound ? "External data sharing" : "Local-only isolation"), el("p", "plg-meta-text", p.manifest.dataSharing.summary))
    if (p.manifest.allowedHosts.length) ds.append(el("div", "plg-meta-hosts", `Allowed hosts: ${p.manifest.allowedHosts.join(", ")}`))
    body.append(permRow, ds)

    if (p.manifest.connector?.configFields?.length) {
      const form = el("div", "plg-connector-form")
      const inputs = new Map<string, HTMLInputElement>()
      for (const f of p.manifest.connector.configFields) {
        const row = el("div", "plg-field")
        const fid = `plg-${p.id}-${f.key}`
        const lbl = el("label", "form-label", f.label)
        lbl.htmlFor = fid
        row.append(lbl)
        if (f.type === "secret" && f.secretKey) {
          const st = p.secrets.find((s) => s.key === f.secretKey)
          const wrap = el("div", "plg-inline")
          const inp = el("input", "form-input")
          inp.id = fid
          inp.type = "password"
          inp.autocomplete = "off"
          inp.placeholder = st?.configured ? "Configured (enter new value to rotate)" : (f.placeholder || "Enter secret...")
          const saveBtn = el("button", "btn btn-secondary btn-sm", "Save secret")
          saveBtn.type = "button"
          saveBtn.addEventListener("click", async () => {
            const val = inp.value.trim()
            if (!val) return
            const r = await apiReq(`/api/plugins/${pid}/secrets`, "PUT", { key: f.secretKey, value: val })
            if (r.ok) { inp.value = ""; showToast(`Secret "${f.secretKey}" saved write-only.`, "success"); await loadCatalog(false) }
            else showToast("Could not save secret.", "error")
          })
          wrap.append(inp, saveBtn)
          if (st?.configured) {
            const clr = el("button", "btn btn-secondary btn-sm", "Clear")
            clr.type = "button"
            clr.addEventListener("click", async () => {
              if ((await apiReq(`/api/plugins/${pid}/secrets?key=${encodeURIComponent(f.secretKey!)}`, "DELETE")).ok) {
                showToast(`Secret "${f.secretKey}" removed.`, "info")
                await loadCatalog(false)
              }
            })
            wrap.append(clr)
          }
          row.append(wrap, el("small", "plg-help", st?.configured ? "Status: Configured (write-only)" : "Status: Not configured"))
        } else {
          const inp = el("input", "form-input")
          inp.id = fid
          inp.type = f.type === "url" ? "url" : "text"
          inp.placeholder = f.placeholder || ""
          inp.value = typeof p.config[f.key] === "string" ? String(p.config[f.key]) : ""
          inputs.set(f.key, inp)
          row.append(inp)
          if (f.help) row.append(el("small", "plg-help", f.help))
        }
        form.append(row)
      }
      const acts = el("div", "plg-actions")
      const saveCfg = el("button", "btn btn-primary btn-sm", "Save settings")
      saveCfg.type = "button"
      saveCfg.addEventListener("click", async () => {
        const config: Record<string, string> = {}
        inputs.forEach((inp, k) => { config[k] = inp.value.trim() })
        const r = await apiReq(`/api/plugins/${pid}`, "PATCH", { config })
        if (r.ok) { showToast(`${p.manifest.name} settings saved.`, "success"); await loadCatalog(false) }
        else { const d = (await r.json().catch(() => ({}))) as { detail?: string }; showToast(d.detail || "Could not save settings.", "error") }
      })
      const testBtn = el("button", "btn btn-secondary btn-sm", "Test connection")
      testBtn.type = "button"
      testBtn.addEventListener("click", async () => {
        const d = (await (await apiReq(`/api/plugins/${pid}/connector`, "POST", { action: "test" })).json().catch(() => ({}))) as { connected?: boolean; message?: string; detail?: string }
        showToast(d.message || d.detail || "Connection check finished.", d.connected ? "success" : "warning")
      })
      const syncBtn = el("button", "btn btn-secondary btn-sm", "Sync now")
      syncBtn.type = "button"
      syncBtn.addEventListener("click", async () => {
        const r = await apiReq(`/api/plugins/${pid}/connector`, "POST", { action: "sync" })
        const d = (await r.json().catch(() => ({}))) as { createdCount?: number; skippedCount?: number; detail?: string }
        showToast(r.ok ? `Imported ${d.createdCount ?? 0} tasks (${d.skippedCount ?? 0} already synced).` : (d.detail || "Connector sync failed."), r.ok ? "success" : "error")
      })
      acts.append(saveCfg, testBtn, syncBtn)
      form.append(acts)
      body.append(form)
    }

    const foot = el("div", "plg-actions")
    if (p.enabled && !safeMode && p.manifest.sidePanel) {
      const openBtn = el("button", "btn btn-secondary btn-sm", "Open panel")
      openBtn.type = "button"
      openBtn.addEventListener("click", async () => {
        const mod = await import("@lib/plugin-host")
        await mod.bootPluginHost()
        mod.openPluginSidePanel(p.id)
      })
      foot.append(openBtn)
    }
    if (p.source === "uploaded") {
      const rem = el("button", "btn btn-secondary btn-sm", "Remove")
      rem.type = "button"
      rem.addEventListener("click", async () => {
        if ((await apiReq(`/api/plugins/${pid}`, "DELETE")).ok) {
          showToast(`Removed ${p.manifest.name}.`, "info")
          await loadCatalog(true)
        }
      })
      foot.append(rem)
    }
    if (foot.childElementCount) body.append(foot)
    det.append(el("summary", "plg-details__summary", "Details"), body)
    card.append(det)
    return card
  }

  function render(): void {
    if (safeModeInput) safeModeInput.checked = safeMode
    renderHealth()
    const connectors = plugins.filter((p) => p.source === "builtin")
    const uploaded = plugins.filter((p) => p.source === "uploaded")
    if (connectorsGrid) { connectorsGrid.textContent = ""; connectors.forEach((p) => connectorsGrid.append(buildCard(p))) }
    if (uploadedGrid) { uploadedGrid.textContent = ""; uploaded.forEach((p) => uploadedGrid.append(buildCard(p))) }
    if (uploadedEmpty) uploadedEmpty.hidden = uploaded.length > 0
    if (removeAllBtn) removeAllBtn.disabled = uploaded.length === 0
  }

  async function loadCatalog(syncRuntime: boolean): Promise<void> {
    try {
      const res = await fetch("/api/plugins")
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { detail?: string; title?: string }
        throw new Error(res.status === 403 ? "Only administrators can view plugin status." : err.detail || err.title || "Could not load plugin status. Try Refresh.")
      }
      const data = (await res.json()) as { safeMode?: boolean; plugins?: PluginView[] }
      safeMode = Boolean(data.safeMode)
      plugins = Array.isArray(data.plugins) ? data.plugins : []
      catalogLoaded = true
      render()
      if (syncRuntime) {
        const hasActive = !safeMode && plugins.some((p) => p.enabled && !p.needsReconsent)
        document.documentElement.dataset.pluginsActive = hasActive ? "1" : "0"
        window.dispatchEvent(new CustomEvent("meitheal:plugins-changed"))
      }
    } catch (error) {
      catalogLoaded = false
      plugins = []
      const message = error instanceof Error ? error.message : "Could not load plugin status. Try Refresh."
      if (healthSummaryEl) healthSummaryEl.textContent = message
      if (healthShowAll) healthShowAll.disabled = true
      healthListEl?.replaceChildren()
      connectorsGrid?.replaceChildren()
      uploadedGrid?.replaceChildren()
      if (removeAllBtn) removeAllBtn.disabled = true
      setFeedback(message, true)
    }
  }

  const setAiStep = (step: 1 | 2) => {
    if (aiStep1) aiStep1.hidden = step !== 1
    if (aiStep2) aiStep2.hidden = step !== 2
    ;(step === 2 ? aiJsonInput : aiIdeaInput)?.focus()
  }

  function updateAiPreview(): void {
    if (!aiJsonInput || !aiPreviewEl || !aiErrorEl || !aiInstallBtn) return
    const res = parseAiBundle(aiJsonInput.value)
    if (!res.ok) {
      aiBundle = null
      aiPreviewEl.hidden = true
      aiErrorEl.hidden = !aiJsonInput.value.trim()
      aiErrorEl.textContent = res.error
      aiInstallBtn.disabled = true
      return
    }
    aiBundle = res.bundle
    aiErrorEl.hidden = true
    aiInstallBtn.disabled = false
    const m = res.bundle.manifest as Record<string, unknown>
    const perms = Array.isArray(m.permissions) ? m.permissions.map(String) : []
    const hosts = Array.isArray(m.allowedHosts) ? m.allowedHosts.map(String) : []
    aiPreviewEl.textContent = ""
    aiPreviewEl.append(
      el("strong", "", `${String(m.name ?? "Unnamed")} (${String(m.id ?? "no-id")}) v${String(m.version ?? "?")}`),
      el("div", "", `Permissions (${perms.length}): ${perms.join(", ") || "none"}`),
      el("div", "", hosts.length ? `Outbound hosts: ${hosts.join(", ")}` : "Isolation: Local-only (zero outbound hosts)"),
    )
    aiPreviewEl.hidden = false
  }

  if (safeModeInput) {
    pageLifecycle.on(safeModeInput, "change", async () => {
      const next = safeModeInput.checked
      if ((await apiReq("/api/plugins", "POST", { action: "set_safe_mode", safeMode: next })).ok) {
        await loadCatalog(true)
        showToast(next ? "Safe Mode enabled. All plugins paused." : "Safe Mode disabled.", next ? "warning" : "success")
      } else {
        safeModeInput.checked = !next
        showToast("Could not update Safe Mode.", "error")
      }
    })
  }
  if (healthShowAll) pageLifecycle.on(healthShowAll, "change", () => renderHealth())
  if (uploadInput) {
    pageLifecycle.on(uploadInput, "change", async () => {
      const file = uploadInput.files?.[0]
      if (!file) return
      setFeedback("Validating ZIP archive...")
      const form = new FormData()
      form.append("file", file)
      try {
        const res = await fetch("/api/plugins", { method: "POST", body: form })
        const d = (await res.json().catch(() => ({}))) as { plugin?: PluginView; detail?: string }
        if (!res.ok) { setFeedback(d.detail || "Plugin upload failed.", true); showToast(d.detail || "Plugin upload rejected.", "error") }
        else { setFeedback(`Installed ${d.plugin?.manifest.name ?? "plugin"}. Review permissions and toggle to enable.`); showToast(`Installed ${d.plugin?.manifest.name ?? "plugin"}.`, "success"); await loadCatalog(false) }
      } finally { uploadInput.value = "" }
    })
  }
  if (removeAllBtn) {
    pageLifecycle.on(removeAllBtn, "click", async () => {
      const res = await apiReq("/api/plugins", "POST", { action: "remove_all_uploaded" })
      if (res.ok) {
        const d = (await res.json()) as { removedCount?: number }
        setFeedback(`Removed ${d.removedCount ?? 0} uploaded plugin(s).`)
        showToast("Removed all uploaded plugins.", "info")
        await loadCatalog(true)
      }
    })
  }
  const onClick = (id: string, fn: () => void) => { const n = byId(id); if (n) pageLifecycle.on(n, "click", fn) }
  onClick("plugins-refresh-btn", () => { void loadCatalog(false) })
  onClick("plugins-ai-open-btn", () => { setAiStep(1); if (aiDialog && !aiDialog.open) aiDialog.showModal() })
  onClick("plugins-ai-next-btn", () => setAiStep(2))
  onClick("plugins-ai-back-btn", () => setAiStep(1))
  onClick("plugins-ai-copy-btn", () => {
    const tpl = byId("plugins-ai-copy-btn")?.dataset.promptTemplate ?? ""
    if (tpl) void copyText(buildAiPrompt(aiIdeaInput?.value ?? "", tpl), "Copied Meitheal plugin prompt for your AI.")
  })
  onClick("plugins-guide-open-btn", () => { if (guideDialog && !guideDialog.open) guideDialog.showModal() })
  onClick("plugins-ai-guide-btn", () => { if (guideDialog && !guideDialog.open) guideDialog.showModal() })
  onClick("plugins-get-listed-btn", () => { if (submitDialog && !submitDialog.open) submitDialog.showModal() })
  onClick("plugins-copy-submit-btn", () => {
    const tpl = byId("plugins-copy-submit-btn")?.dataset.submitTemplate ?? ""
    if (tpl) void copyText(tpl, "Copied community plugin submission template.")
  })
  if (aiJsonInput) pageLifecycle.on(aiJsonInput, "input", () => updateAiPreview())
  if (aiInstallBtn) {
    pageLifecycle.on(aiInstallBtn, "click", async () => {
      if (!aiBundle || !aiErrorEl) return
      aiInstallBtn.disabled = true
      try {
        const res = await apiReq("/api/plugins", "POST", { action: "install_bundle", bundle: aiBundle })
        const d = (await res.json().catch(() => ({}))) as { plugin?: PluginView; detail?: string }
        if (!res.ok) { aiErrorEl.hidden = false; aiErrorEl.textContent = d.detail || "Plugin bundle failed validation."; return }
        aiDialog?.close()
        if (aiJsonInput) aiJsonInput.value = ""
        aiBundle = null
        setFeedback(`Installed ${d.plugin?.manifest.name ?? "plugin"} from AI bundle. Inspect permissions and enable when ready.`)
        showToast(`Installed ${d.plugin?.manifest.name ?? "plugin"}.`, "success")
        await loadCatalog(false)
      } finally { aiInstallBtn.disabled = !aiBundle }
    })
  }
  root.querySelectorAll<HTMLButtonElement>("[data-copy-cmd]").forEach((b) =>
    pageLifecycle.on(b, "click", () => { if (b.dataset.copyCmd) void copyText(b.dataset.copyCmd, "Copied pack command.") }),
  )
  root.querySelectorAll<HTMLButtonElement>("[data-close-dialog]").forEach((b) =>
    pageLifecycle.on(b, "click", () => byId<HTMLDialogElement>(b.dataset.closeDialog ?? "")?.close()),
  )
  for (const d of [aiDialog, submitDialog, guideDialog]) {
    if (d) pageLifecycle.on(d, "click", (ev) => { if (ev.target === d) d.close() })
  }
  pageLifecycle.on(window, "meitheal:plugin-runtime-error", () => render())
  whenSectionVisible(root, () => { void loadCatalog(false) })
}
