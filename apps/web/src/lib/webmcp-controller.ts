import { WEBMCP_SETTING, webMcpEnabled } from "@domains/agents/webmcp-protocol"
import type { SearchResponse } from "@domains/search"
import { buildIngressPagePath } from "@lib/page-shell-links"
import { pageLifecycle } from "@lib/page-lifecycle"
import { parseTaskView, TASK_VIEWS, taskViewUrl } from "@lib/task-view-route"

interface BrowserTool {
  name: string
  title: string
  description: string
  inputSchema: object
  annotations: { readOnlyHint: true; untrustedContentHint?: true }
  execute(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>
}
interface BrowserModelContext {
  registerTool(tool: BrowserTool, options: { signal: AbortSignal }): Promise<void> | void
}

type Status = "disabled" | "unavailable" | "starting" | "registered" | "failed"
interface WebMcpRuntime {
  registration?: AbortController | undefined
  lifecycle?: AbortController
  revision: number
  status: Status
  observedPage?: AbortSignal
  onPageLoad?: (signal: AbortSignal) => void
  configure?: (enabled: boolean) => Promise<void>
  refresh?: () => Promise<void>
}
const SYNC_KEY = "meitheal:webmcp-setting-changed"
const host = window as Window & {
  __meithealWebMcpRuntime?: WebMcpRuntime
  __meithealWebMcpLifecycleInstalled?: boolean
}
const modelContext = () => (document as Document & { modelContext?: BrowserModelContext }).modelContext

// Retire the previous module before HMR installs a new runtime. The current
// browser API unregisters tools through the registration AbortSignal.
host.__meithealWebMcpRuntime?.registration?.abort()
host.__meithealWebMcpRuntime?.lifecycle?.abort()
const runtime: WebMcpRuntime = { revision: 0, status: "disabled" }
host.__meithealWebMcpRuntime = runtime

function setStatus(status: Status) {
  runtime.status = status
  const el = document.getElementById("webmcp-runtime-status")
  if (el) {
    el.dataset.state = status
    el.textContent = el.dataset[status] ?? ""
  }
}

async function readPreference(signal: AbortSignal): Promise<boolean> {
  const response = await fetch(`/api/settings?key=${WEBMCP_SETTING}`, { signal, cache: "no-store" })
  if (response.status === 403) return false
  if (!response.ok) throw new Error("Could not read browser tool settings")
  return webMcpEnabled((await response.json()).value)
}

export function refreshWebMcpPreference(): void {
  void host.__meithealWebMcpRuntime?.refresh?.()
}

export function notifyWebMcpPreferenceChanged(): void {
  refreshWebMcpPreference()
  try { localStorage.setItem(SYNC_KEY, crypto.randomUUID()) } catch { /* Every execution also rechecks the saved preference. */ }
}

export async function configureWebMcp(enabled: boolean): Promise<void> {
  if (host.__meithealWebMcpRuntime !== runtime) {
    await host.__meithealWebMcpRuntime?.configure?.(enabled)
    return
  }
  runtime.revision++
  if (enabled && runtime.registration && !runtime.registration.signal.aborted) {
    setStatus(runtime.status)
    return
  }
  runtime.registration?.abort()
  runtime.registration = undefined
  const context = modelContext()
  if (!enabled || typeof context?.registerTool !== "function") {
    setStatus(enabled ? "unavailable" : "disabled")
    return
  }
  const controller = new AbortController()
  runtime.registration = controller
  const { signal } = controller
  setStatus("starting")
  const requestSignal = (toolSignal?: AbortSignal) => toolSignal ? AbortSignal.any([signal, toolSignal]) : signal
  async function canExecute(callSignal: AbortSignal): Promise<boolean> {
    if (callSignal.aborted) return false
    try {
      const enabled = await readPreference(callSignal)
      if (!enabled && !signal.aborted) await configureWebMcp(false)
      return enabled && !callSignal.aborted
    } catch {
      if (callSignal.aborted) return false
      if (!signal.aborted) {
        await configureWebMcp(false)
        setStatus("failed")
      }
      return false
    }
  }
  try {
    await context.registerTool({
      name: "meitheal_search_tasks",
      title: "Search Meitheal tasks",
      description: "Find up to eight Meitheal tasks by title and return matching titles and links.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", minLength: 1, maxLength: 160 } },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input, options) {
        const query = typeof input?.query === "string" ? input.query.trim() : ""
        if (!query || query.length > 160) return { error: "Enter a task title up to 160 characters." }
        try {
          const callSignal = requestSignal(options?.signal)
          if (!await canExecute(callSignal)) return { error: "Browser tools are unavailable." }
          const params = new URLSearchParams({ q: query, scope: "tasks", task_fields: "title", limit: "8" })
          const response = await fetch(`/api/search?${params}`, {
            signal: callSignal,
            cache: "no-store",
            headers: { "X-Automation-Source": "webmcp" },
          })
          if (!response.ok) return { error: "Meitheal task search is unavailable." }
          const data = await response.json() as SearchResponse
          if (!Array.isArray(data.sections) || data.sections.some(section => !Array.isArray(section?.items))) throw new Error("Invalid search response")
          const items = data.sections.flatMap(section => section.items).filter(item => item?.kind === "task")
          if (items.some(item => typeof item.taskId !== "string" || !item.taskId || typeof item.title !== "string")) throw new Error("Invalid task result")
          if (callSignal.aborted) return { error: "Browser tools are unavailable." }
          return { tasks: items.slice(0, 8).map(item => ({
            title: item.title,
            url: `${buildIngressPagePath("/tasks")}?open=${encodeURIComponent(item.taskId!)}`,
          })) }
        } catch {
          return { error: "Meitheal task search did not complete." }
        }
      },
    }, { signal })
    if (signal.aborted) return
    await context.registerTool({
      name: "meitheal_open_tasks",
      title: "Open a Tasks view",
      description: "Open a Meitheal Tasks view in the current tab without changing tasks.",
      inputSchema: {
        type: "object",
        properties: { view: { type: "string", enum: TASK_VIEWS } },
        required: ["view"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      async execute(input, options) {
        const view = typeof input?.view === "string" ? parseTaskView(input.view) : undefined
        if (!view) return { error: "Choose Kanban, Table, Calendar, or Timeline." }
        try {
          if (!await canExecute(requestSignal(options?.signal))) return { error: "Browser tools are unavailable." }
          window.location.href = taskViewUrl(new URL(buildIngressPagePath("/tasks"), location.origin), view).href
          return { opened: view }
        } catch {
          return { error: "Could not open the Tasks view." }
        }
      },
    }, { signal })
    if (!signal.aborted) setStatus("registered")
  } catch {
    if (!signal.aborted) {
      controller.abort()
      setStatus("failed")
    }
  }
}

runtime.onPageLoad = signal => {
  if (host.__meithealWebMcpRuntime !== runtime || runtime.observedPage === signal) return
  runtime.observedPage = signal
  runtime.lifecycle?.abort()
  const lifecycle = new AbortController()
  runtime.lifecycle = lifecycle
  signal.addEventListener("abort", () => {
    runtime.registration?.abort()
    lifecycle.abort()
  }, { once: true, signal: lifecycle.signal })
  async function refresh() {
    const revision = ++runtime.revision
    try {
      const enabled = await readPreference(signal)
      if (!signal.aborted && revision === runtime.revision && host.__meithealWebMcpRuntime === runtime) await configureWebMcp(enabled)
    } catch {
      if (!signal.aborted && revision === runtime.revision && host.__meithealWebMcpRuntime === runtime) {
        await configureWebMcp(false)
        setStatus("failed")
      }
    }
  }
  runtime.refresh = refresh
  window.addEventListener("storage", event => {
    if (event.key === SYNC_KEY) void refresh()
  }, { signal: lifecycle.signal })
  // Unsupported browsers do not add a settings request to ordinary page loads.
  if (modelContext()?.registerTool || document.getElementById("webmcp-runtime-status")) void refresh()
}

runtime.configure = configureWebMcp
if (!host.__meithealWebMcpLifecycleInstalled) {
  host.__meithealWebMcpLifecycleInstalled = true
  pageLifecycle.onPageLoad(signal => host.__meithealWebMcpRuntime?.onPageLoad?.(signal))
}
runtime.onPageLoad(pageLifecycle.signal)
