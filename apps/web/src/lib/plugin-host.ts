/**
 * Sandboxed Browser Plugin Runtime Host (Lazy-Loaded)
 *
 * Executes enabled Meitheal plugins inside two opaque-origin browser sandboxes:
 *   1. Hidden `<iframe sandbox="allow-scripts">` (`origin: null`, `connect-src 'none'`)
 *      for `plugin.js` — zero DOM, cookie, localStorage, or direct `/api/*` access.
 *   2. Visible `<iframe sandbox="allow-scripts allow-forms">` (`origin: null`, `connect-src 'none'`)
 *      for `index.html` side panels with injected Meitheal CSS theme variables.
 *
 * All host interactions pass through a per-mount token-verified `postMessage`
 * RPC bridge that enforces declared manifest permissions.
 */
import { pageLifecycle } from "@lib/page-lifecycle"
import { safeFetch } from "@lib/safe-fetch"
import { showToast } from "@lib/toast"

export interface ClientPluginBundle {
  id: string
  name: string
  version: string
  type: "extension" | "connector"
  permissions: string[]
  hooks: string[]
  sidePanel: boolean
  entryJs: string | null
  iframeHtml: string | null
  iconSvg: string | null
  config: Record<string, unknown>
}

interface ActivePluginInstance {
  bundle: ClientPluginBundle
  runnerFrame: HTMLIFrameElement | null
  runnerToken: string
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
  nextReqId: number
  headerButtons: Array<{ id: string; label: string }>
}

const instances = new Map<string, ActivePluginInstance>()
const inspectorSections = new Map<string, { pluginId: string; pluginName: string; id: string; title: string; body: string }>()
let hostAbort: AbortController | null = null
let activePanelPluginId: string | null = null
let activeIframeToken = ""
let activeIframeEl: HTMLIFrameElement | null = null
let bootInFlight = false

function getErrorRegistry(): Record<string, string> {
  const win = window as unknown as { __meithealPluginErrors?: Record<string, string> }
  if (!win.__meithealPluginErrors || typeof win.__meithealPluginErrors !== "object") {
    win.__meithealPluginErrors = {}
  }
  return win.__meithealPluginErrors
}

const lastErrorAt = new Map<string, number>()

function recordRuntimeError(pluginId: string, rawMessage: unknown): void {
  const message = String(rawMessage ?? "Plugin runtime error")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 180)
  if (!message) return
  const reg = getErrorRegistry()
  const now = Date.now()
  if (reg[pluginId] === message || now - (lastErrorAt.get(pluginId) ?? 0) < 500) return
  lastErrorAt.set(pluginId, now)
  reg[pluginId] = message
  window.dispatchEvent(new CustomEvent("meitheal:plugin-runtime-error", { detail: { pluginId, message } }))
}

export function getPluginRuntimeErrors(): Record<string, string> {
  return { ...getErrorRegistry() }
}

const THEME_TOKENS = [
  "--bg-primary", "--bg-secondary", "--bg-card", "--bg-hover",
  "--text-primary", "--text-secondary", "--border", "--accent",
  "--success", "--warning", "--danger", "--info", "--radius", "--font-sans",
]

const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"
const RUNNER_CSP = "default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'"

function escapeInlineScript(source: string): string {
  // Prevent `</script>` or `<!--` sequences from closing the runner script block without corrupting `/<\/div>/` regex literals.
  return source.replace(/<\/(?=script)/gi, "<\\/").replace(/<!--/g, "<\\!--")
}

function buildRunnerSrcdoc(entryJs: string, token: string): string {
  const safeCode = escapeInlineScript(entryJs)
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${RUNNER_CSP}"><script>"use strict";
(function(){
  const T=${JSON.stringify(token)};
  let n=1,onInit=null,onMsg=null;
  const pend=new Map(),btns=new Map(),hooks=new Map();
  const send=(msg)=>window.parent.postMessage(Object.assign({token:T},msg),"*");
  const rpc=(method,args)=>new Promise((res,rej)=>{const id=n++;pend.set(id,{res,rej});send({kind:"rpc_req",id,method,args});});
  const api=Object.freeze({
    getTasks:(f)=>rpc("tasks.list",[f||{}]),
    getTask:(id)=>rpc("tasks.get",[id]),
    createTask:(i)=>rpc("tasks.create",[i]),
    updateTask:(id,p)=>rpc("tasks.update",[id,p]),
    completeTask:(id)=>rpc("tasks.complete",[id]),
    getBoards:()=>rpc("boards.list",[]),
    registerHeaderButton:(c)=>{if(c&&typeof c.id==="string"&&typeof c.onClick==="function")btns.set(c.id,c.onClick);return rpc("ui.registerHeaderButton",[{id:c?.id||"btn",label:c?.label||"Plugin",icon:c?.icon||"package"}]);},
    openCreateTask:(o)=>rpc("ui.openCreateTask",[o||{}]),
    registerTaskInspectorSection:(c)=>rpc("ui.registerTaskInspectorSection",[c||{}]),
    openSidePanel:()=>rpc("ui.openSidePanel",[]),
    closeSidePanel:()=>rpc("ui.closeSidePanel",[]),
    showToast:(o)=>rpc("ui.showToast",[o]),
    registerHook:(e,fn)=>{if(typeof fn==="function")hooks.set(e,fn);},
    storage:Object.freeze({get:(k)=>rpc("storage.get",[k]),set:(k,v)=>rpc("storage.set",[k,v]),remove:(k)=>rpc("storage.remove",[k])}),
    http:Object.freeze({request:(o)=>rpc("http.request",[o])}),
  });
  window.MeithealPlugin=Object.freeze({
    onInit(fn){onInit=fn;},
    onMessage(fn){onMsg=fn;},
    registerConnector(){},
  });
  window.addEventListener("message",async(ev)=>{
    const m=ev.data;
    if(!m||m.token!==T)return;
    if(m.kind==="rpc_res"){const r=pend.get(m.id);if(!r)return;pend.delete(m.id);m.ok?r.res(m.result):r.rej(new Error(m.error||"Host call failed"));return;}
    if(m.kind==="init"){try{if(onInit)await onInit(api);}catch(e){send({kind:"error",message:String(e)});}return;}
    if(m.kind==="button_click"){const fn=btns.get(m.buttonId);if(fn){try{await fn();}catch(e){send({kind:"error",message:String(e)});}}return;}
    if(m.kind==="ui_msg"){try{const result=onMsg?await onMsg(m.payload,api):{ok:false};send({kind:"ui_res",id:m.id,ok:true,result});}catch(e){send({kind:"ui_res",id:m.id,ok:false,error:String(e)});}return;}
    if(m.kind==="hook"){const fn=hooks.get(m.eventName);if(fn){try{await fn(m.payload);}catch{}}}
  });
  try{
${safeCode}
  }catch(e){send({kind:"error",message:String(e)});}
  send({kind:"runner_ready"});
})();
</script></head><body></body></html>`
}

function safeInlineJson(value: unknown): string {
  return JSON.stringify(value).split("<").join("\\u003c")
}

function buildSandboxedSrcdoc(rawHtml: string, token: string): string {
  const computed = getComputedStyle(document.documentElement)
  const themeMap: Record<string, string> = {}
  for (const name of THEME_TOKENS) {
    const val = computed.getPropertyValue(name).trim()
    if (val) themeMap[name] = val
  }

  // Parse into an isolated DOM so plugin-supplied CSP <meta> tags can be removed without regexes.
  const doc = new DOMParser().parseFromString(rawHtml, "text/html")
  for (const meta of Array.from(doc.querySelectorAll("meta[http-equiv]"))) {
    if (meta.getAttribute("http-equiv")?.trim().toLowerCase() === "content-security-policy") {
      meta.remove()
    }
  }
  const head = doc.head ?? doc.createElement("head")
  if (!head.parentElement) doc.documentElement.prepend(head)

  const cspMeta = doc.createElement("meta")
  cspMeta.setAttribute("http-equiv", "Content-Security-Policy")
  cspMeta.setAttribute("content", SANDBOX_CSP)

  const bridgeScript = doc.createElement("script")
  bridgeScript.textContent =
    `(function(){const T=${safeInlineJson(token)};const V=${safeInlineJson(themeMap)};` +
    `const r=document.documentElement;for(const[k,v]of Object.entries(V))r.style.setProperty(k,v);` +
    `let n=1;const p=new Map();` +
    `window.addEventListener("message",function(e){const d=e.data;if(!d||d.token!==T||d.kind!=="meitheal_ui_res")return;const q=p.get(d.id);if(!q)return;p.delete(d.id);d.ok?q.resolve(d.result):q.reject(new Error(d.error||"Plugin call failed"));});` +
    `window.MeithealUI=Object.freeze({send:function(payload){return new Promise(function(resolve,reject){const id=n++;p.set(id,{resolve:resolve,reject:reject});window.parent.postMessage({token:T,kind:"meitheal_ui_req",id:id,payload:payload},"*");});}});})();`

  head.prepend(cspMeta, bridgeScript)
  return `<!DOCTYPE html>${doc.documentElement.outerHTML}`
}

function getBoardHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const boardId = document.querySelector<HTMLMetaElement>('meta[name="meitheal-work-board"]')?.content
  const session = document.querySelector<HTMLMetaElement>('meta[name="meitheal-work-session"]')?.content
  if (boardId) headers["x-meitheal-board-id"] = boardId
  if (session) headers["x-meitheal-board-session"] = session
  return headers
}

function requirePerm(inst: ActivePluginInstance, perm: string): void {
  if (!inst.bundle.permissions.includes(perm)) throw new Error(`PERMISSION_DENIED: ${perm}`)
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  if (!url.startsWith("/api/") || url.startsWith("//")) throw new Error("Invalid API path")
  const res = await safeFetch(url, { ...init, signal: init?.signal ?? hostAbort?.signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function postToRunner(inst: ActivePluginInstance, msg: Record<string, unknown>): void {
  inst.runnerFrame?.contentWindow?.postMessage({ token: inst.runnerToken, ...msg }, "*")
}

async function handleRunnerRpc(inst: ActivePluginInstance, method: string, args: unknown[]): Promise<unknown> {
  const id = encodeURIComponent(inst.bundle.id)
  if (method === "tasks.list") {
    requirePerm(inst, "tasks:read")
    const filter = (args[0] ?? {}) as Record<string, unknown>
    const payload = await fetchJson("/api/tasks", { headers: getBoardHeaders() })
    const rawTasks = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as Record<string, unknown>)?.tasks)
        ? ((payload as Record<string, unknown>).tasks as Record<string, unknown>[])
        : []
    const limit = typeof filter.limit === "number" ? Math.min(200, Math.max(1, filter.limit)) : 50
    return rawTasks.slice(0, limit).map((t) => ({
      id: String(t.id ?? ""),
      title: String(t.title ?? ""),
      status: String(t.status ?? "pending"),
      priority: typeof t.priority === "number" && Number.isFinite(t.priority) ? t.priority : 3,
      dueDate: typeof t.due_date === "string" ? t.due_date : typeof t.dueDate === "string" ? t.dueDate : null,
    }))
  }

  if (method === "tasks.get") {
    requirePerm(inst, "tasks:read")
    const rawId = String(args[0] ?? "").trim()
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(rawId)) throw new Error("Invalid task id")
    const res = await safeFetch(`/api/tasks/${encodeURIComponent(rawId)}`, { headers: getBoardHeaders(), signal: hostAbort?.signal })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }

  if (method === "tasks.create") {
    requirePerm(inst, "tasks:write")
    const input = (args[0] ?? {}) as Record<string, unknown>
    return fetchJson("/api/tasks", {
      method: "POST",
      headers: getBoardHeaders(),
      body: JSON.stringify({
        title: String(input.title ?? "").slice(0, 180),
        description: typeof input.description === "string" ? input.description.slice(0, 2000) : undefined,
        due_date: typeof input.dueDate === "string" ? input.dueDate : undefined,
      }),
    })
  }

  if (method === "tasks.update" || method === "tasks.complete") {
    requirePerm(inst, "tasks:write")
    const rawId = String(args[0] ?? "").trim()
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(rawId)) throw new Error("Invalid task id")
    const taskId = encodeURIComponent(rawId)
    const patch = method === "tasks.complete" ? { status: "complete" } : ((args[1] ?? {}) as Record<string, unknown>)
    const body: Record<string, unknown> = {}
    if (typeof patch.title === "string") body.title = patch.title.slice(0, 180)
    if (typeof patch.description === "string") body.description = patch.description.slice(0, 2000)
    if (typeof patch.status === "string") body.status = patch.status
    if (typeof patch.priority === "number" && Number.isFinite(patch.priority)) {
      body.priority = Math.min(5, Math.max(1, Math.round(patch.priority)))
    } else if (typeof patch.priority === "string") {
      const mappedPriority = ({ critical: 1, urgent: 1, high: 2, normal: 3, medium: 3, low: 4, minimal: 5, none: 5 } as Record<string, number>)[patch.priority.trim().toLowerCase()]
      if (mappedPriority !== undefined) body.priority = mappedPriority
    }
    if (patch.dueDate !== undefined) body.due_date = patch.dueDate
    return fetchJson(`/api/tasks/${taskId}`, { method: "PATCH", headers: getBoardHeaders(), body: JSON.stringify(body) })
  }

  if (method === "boards.list") {
    requirePerm(inst, "boards:read")
    return fetchJson("/api/boards")
  }

  if (method === "ui.registerHeaderButton") {
    requirePerm(inst, "ui:header-button")
    const cfg = (args[0] ?? {}) as Record<string, unknown>
    const btnId = String(cfg.id ?? "btn").slice(0, 40)
    const label = String(cfg.label ?? inst.bundle.name).slice(0, 32)
    if (inst.headerButtons.length < 2 && !inst.headerButtons.some((b) => b.id === btnId)) {
      inst.headerButtons.push({ id: btnId, label })
      renderPluginBar()
    }
    return { ok: true }
  }

  if (method === "ui.openSidePanel") {
    requirePerm(inst, "ui:side-panel")
    openPluginSidePanel(inst.bundle.id)
    return { ok: true }
  }

  if (method === "ui.openCreateTask") {
    if (!inst.bundle.permissions.includes("ui:task-editor") && !inst.bundle.permissions.includes("ui:side-panel")) {
      throw new Error("PERMISSION_DENIED: ui:task-editor")
    }
    const opts = (args[0] ?? {}) as Record<string, unknown>
    const rawPriority = typeof opts.priority === "number" ? opts.priority : Number(opts.priority)
    const openOpts: Record<string, unknown> = {
      ...(typeof opts.title === "string" ? { title: opts.title.slice(0, 500) } : {}),
      ...(typeof opts.description === "string" ? { description: opts.description.slice(0, 2000) } : {}),
      ...(Number.isInteger(rawPriority) && rawPriority >= 1 && rawPriority <= 5 ? { priority: rawPriority } : {}),
    }
    window.openNewTaskModal?.("standard_action", openOpts)
    return { ok: true }
  }

  if (method === "ui.registerTaskInspectorSection") {
    if (!inst.bundle.permissions.includes("ui:task-editor") && !inst.bundle.permissions.includes("ui:side-panel")) {
      throw new Error("PERMISSION_DENIED: ui:task-editor")
    }
    const cfg = (args[0] ?? {}) as Record<string, unknown>
    const secId = String(cfg.id ?? "section").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "section"
    const key = `${inst.bundle.id}:${secId}`
    inspectorSections.set(key, {
      pluginId: inst.bundle.id,
      pluginName: inst.bundle.name.slice(0, 40),
      id: secId,
      title: String(cfg.title ?? inst.bundle.name).slice(0, 80),
      body: String(cfg.body ?? "").slice(0, 500),
    })
    renderPluginInspectorSections()
    return { ok: true }
  }

  if (method === "ui.closeSidePanel") {
    closePluginSidePanel()
    return { ok: true }
  }

  if (method === "ui.showToast") {
    requirePerm(inst, "ui:toast")
    const opts = (args[0] ?? {}) as Record<string, unknown>
    const type = ["info", "success", "warning", "error"].includes(String(opts.type))
      ? (opts.type as "info" | "success" | "warning" | "error")
      : "info"
    const message = String(opts.message ?? "").slice(0, 160)
    if (message) showToast(message, type)
    return { ok: true }
  }

  if (method === "storage.get") {
    requirePerm(inst, "storage:local")
    const data = (await fetchJson(`/api/plugins/${id}/storage?key=${encodeURIComponent(String(args[0] ?? ""))}`)) as { value?: unknown }
    return data.value ?? null
  }

  if (method === "storage.set") {
    requirePerm(inst, "storage:local")
    await fetchJson(`/api/plugins/${id}/storage`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: String(args[0] ?? ""), value: args[1] ?? null }),
    })
    return { ok: true }
  }

  if (method === "storage.remove") {
    requirePerm(inst, "storage:local")
    const res = await safeFetch(`/api/plugins/${id}/storage?key=${encodeURIComponent(String(args[0] ?? ""))}`, { method: "DELETE", signal: hostAbort?.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return { ok: true }
  }

  if (method === "http.request") {
    requirePerm(inst, "http:outbound")
    const res = await safeFetch(`/api/plugins/${id}/http`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args[0] ?? {}),
      signal: hostAbort?.signal,
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(String((body as Record<string, unknown>).detail ?? `HTTP ${res.status}`))
    return body
  }

  throw new Error(`Unsupported plugin method: ${method}`)
}

function renderPluginBar(): void {
  let bar = document.getElementById("meitheal-plugin-bar")
  const allButtons: Array<{ pluginId: string; buttonId: string; label: string }> = []
  for (const inst of instances.values()) {
    for (const btn of inst.headerButtons) {
      allButtons.push({ pluginId: inst.bundle.id, buttonId: btn.id, label: btn.label })
    }
  }
  if (allButtons.length === 0) {
    bar?.remove()
    return
  }
  if (!bar) {
    bar = document.createElement("div")
    bar.id = "meitheal-plugin-bar"
    bar.setAttribute("role", "region")
    bar.setAttribute("aria-label", "Active plugins")
    bar.style.cssText = "position:fixed;right:16px;bottom:74px;z-index:45;display:flex;flex-wrap:wrap;gap:6px"
    document.body.append(bar)
  }
  bar.textContent = ""
  for (const item of allButtons) {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "btn btn-secondary btn-sm"
    btn.dataset.pluginTrigger = `${item.pluginId}:${item.buttonId}`
    btn.style.cssText = "min-height:38px;padding:6px 12px;border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,.28);font-weight:600"
    btn.textContent = item.label
    btn.addEventListener("click", () => {
      const inst = instances.get(item.pluginId)
      if (inst) postToRunner(inst, { kind: "button_click", buttonId: item.buttonId })
    })
    bar.append(btn)
  }
}

export function closePluginSidePanel(): void {
  document.getElementById("meitheal-plugin-drawer")?.remove()
  activePanelPluginId = null
  activeIframeEl = null
  activeIframeToken = ""
}

export function openPluginSidePanel(pluginId: string): void {
  const inst = instances.get(pluginId)
  if (!inst || !inst.bundle.sidePanel || !inst.bundle.iframeHtml || !inst.bundle.permissions.includes("ui:side-panel")) return

  closePluginSidePanel()
  activePanelPluginId = pluginId
  activeIframeToken = crypto.randomUUID()

  const drawer = document.createElement("aside")
  drawer.id = "meitheal-plugin-drawer"
  drawer.setAttribute("role", "complementary")
  drawer.setAttribute("aria-label", `${inst.bundle.name} plugin panel`)
  drawer.style.cssText = "position:fixed;top:0;right:0;bottom:0;width:min(420px,100vw);z-index:1200;display:flex;flex-direction:column;background:var(--bg-primary,#101210);border-left:1px solid var(--border,#28332c);box-shadow:-12px 0 32px rgba(0,0,0,.42)"

  const header = document.createElement("div")
  header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border,#28332c);background:var(--bg-card,#171c19)"

  const titleWrap = document.createElement("div")
  const title = document.createElement("strong")
  title.textContent = inst.bundle.name
  const badge = document.createElement("span")
  badge.textContent = " Sandboxed"
  badge.style.cssText = "margin-left:8px;font-size:.75rem;color:var(--text-secondary,#a3b2aa)"
  titleWrap.append(title, badge)

  const closeBtn = document.createElement("button")
  closeBtn.type = "button"
  closeBtn.className = "btn btn-secondary btn-sm"
  closeBtn.setAttribute("aria-label", `Close ${inst.bundle.name} panel`)
  closeBtn.style.cssText = "min-width:44px;min-height:44px"
  closeBtn.textContent = "Close"
  closeBtn.addEventListener("click", () => closePluginSidePanel())

  header.append(titleWrap, closeBtn)

  const iframe = document.createElement("iframe")
  iframe.title = `${inst.bundle.name} sandboxed view`
  // Opaque origin ONLY — NEVER allow-same-origin or allow-top-navigation
  iframe.setAttribute("sandbox", "allow-scripts allow-forms")
  iframe.style.cssText = "flex:1;width:100%;border:0;background:var(--bg-primary,#101210)"
  iframe.srcdoc = buildSandboxedSrcdoc(inst.bundle.iframeHtml, activeIframeToken)

  activeIframeEl = iframe
  drawer.append(header, iframe)
  document.body.append(drawer)
  closeBtn.focus()
}

function renderPluginInspectorSections(): void {
  const container = document.getElementById("td-sections")
  if (!container) return
  container.querySelectorAll("[data-plugin-inspector-section]").forEach(el => el.remove())
  for (const [key, item] of inspectorSections) {
    const section = document.createElement("section")
    section.className = "td-field td-plugin-section"
    section.dataset.pluginInspectorSection = key
    const header = document.createElement("div")
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px"
    const title = document.createElement("strong")
    title.style.fontSize = "12px"
    title.textContent = item.title
    const badge = document.createElement("span")
    badge.className = "badge"
    badge.textContent = `Plugin · ${item.pluginName}`
    header.append(title, badge)
    const body = document.createElement("p")
    body.className = "text-xs text-text-secondary"
    body.textContent = item.body
    section.append(header, body)
    container.append(section)
  }
}

export function teardownPluginHost(): void {
  closePluginSidePanel()
  inspectorSections.clear()
  document.querySelectorAll("[data-plugin-inspector-section]").forEach(el => el.remove())
  for (const inst of instances.values()) {
    inst.runnerFrame?.remove()
  }
  instances.clear()
  const reg = getErrorRegistry()
  for (const key of Object.keys(reg)) delete reg[key]
  document.getElementById("meitheal-plugin-bar")?.remove()
  hostAbort?.abort()
  hostAbort = null
}

function mountPluginInstance(bundle: ClientPluginBundle): void {
  const runnerToken = crypto.randomUUID()
  const inst: ActivePluginInstance = {
    bundle,
    runnerFrame: null,
    runnerToken,
    pending: new Map(),
    nextReqId: 1,
    headerButtons: [],
  }

  if (bundle.entryJs) {
    const runner = document.createElement("iframe")
    runner.hidden = true
    runner.setAttribute("aria-hidden", "true")
    runner.dataset.pluginRunner = bundle.id
    // Opaque origin (`null`) + connect-src 'none' prevents direct fetch/cookie/storage access
    runner.setAttribute("sandbox", "allow-scripts")
    runner.srcdoc = buildRunnerSrcdoc(bundle.entryJs, runnerToken)
    document.body.append(runner)
    inst.runnerFrame = runner
  }

  instances.set(bundle.id, inst)
}

export async function bootPluginHost(): Promise<void> {
  if (bootInFlight) return
  bootInFlight = true
  try {
    teardownPluginHost()
    hostAbort = new AbortController()
    const signal = hostAbort.signal
    const res = await safeFetch("/api/plugins?runtime=1", { signal })
    if (!res.ok) return
    const data = (await res.json()) as { safeMode?: boolean; bundles?: ClientPluginBundle[] }
    if (data.safeMode || !Array.isArray(data.bundles) || data.bundles.length === 0) return

    window.addEventListener(
      "message",
      (event: MessageEvent) => {
        const msg = event.data as Record<string, unknown> | null
        if (!msg || typeof msg !== "object") return

        // 1. Messages from the visible side-panel iframe
        if (activeIframeEl && event.source === activeIframeEl.contentWindow && event.origin === "null") {
          if (msg.token !== activeIframeToken || msg.kind !== "meitheal_ui_req" || !activePanelPluginId) return
          const inst = instances.get(activePanelPluginId)
          if (!inst?.runnerFrame) return
          const workerMsgId = inst.nextReqId++
          const uiReqId = msg.id
          inst.pending.set(workerMsgId, {
            resolve: (result) => {
              activeIframeEl?.contentWindow?.postMessage(
                { token: activeIframeToken, kind: "meitheal_ui_res", id: uiReqId, ok: true, result },
                "*",
              )
            },
            reject: (err) => {
              activeIframeEl?.contentWindow?.postMessage(
                { token: activeIframeToken, kind: "meitheal_ui_res", id: uiReqId, ok: false, error: err.message },
                "*",
              )
            },
          })
          postToRunner(inst, { kind: "ui_msg", id: workerMsgId, payload: msg.payload })
          return
        }

        // 2. Messages from hidden opaque-origin plugin runners
        for (const inst of instances.values()) {
          if (!inst.runnerFrame || event.source !== inst.runnerFrame.contentWindow || event.origin !== "null") continue
          if (msg.token !== inst.runnerToken) return

          if (msg.kind === "runner_ready") {
            delete getErrorRegistry()[inst.bundle.id]
            postToRunner(inst, { kind: "init" })
            return
          }

          if (msg.kind === "error") {
            recordRuntimeError(inst.bundle.id, msg.message)
            return
          }

          if (msg.kind === "rpc_req") {
            const reqId = Number(msg.id)
            void handleRunnerRpc(inst, String(msg.method ?? ""), Array.isArray(msg.args) ? msg.args : [])
              .then((result) => postToRunner(inst, { kind: "rpc_res", id: reqId, ok: true, result }))
              .catch((err) =>
                postToRunner(inst, {
                  kind: "rpc_res",
                  id: reqId,
                  ok: false,
                  error: err instanceof Error ? err.message : String(err),
                }),
              )
            return
          }

          if (msg.kind === "ui_res") {
            const pending = inst.pending.get(Number(msg.id))
            if (!pending) return
            inst.pending.delete(Number(msg.id))
            if (msg.ok) pending.resolve(msg.result)
            else pending.reject(new Error(String(msg.error ?? "Plugin error")))
            return
          }
          return
        }
      },
      { signal },
    )

    window.addEventListener(
      "keydown",
      (event: KeyboardEvent) => {
        if (event.key === "Escape" && activePanelPluginId) closePluginSidePanel()
      },
      { signal },
    )

    for (const bundle of data.bundles) {
      mountPluginInstance(bundle)
    }

    pageLifecycle.signal.addEventListener("abort", () => teardownPluginHost(), { once: true })
  } finally {
    bootInFlight = false
  }
}

const hostWin = window as unknown as Record<string, unknown>
if (!hostWin.__meithealPluginHostOpenBound) {
  hostWin.__meithealPluginHostOpenBound = true
  window.addEventListener("meitheal:plugins-open-panel", (event: Event) => {
    const detail = (event as CustomEvent<{ pluginId?: string }>).detail
    if (detail?.pluginId) openPluginSidePanel(detail.pluginId)
  })
}
