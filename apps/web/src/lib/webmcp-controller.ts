import type { SearchResponse } from "@domains/search/search-types"
import { agentProtocolEnabled, agentProtocolSettingKey } from "@lib/agent-protocol-options"
import { buildIngressPagePath } from "@lib/page-shell-links"
import { pageLifecycle } from "@lib/page-lifecycle"

interface BrowserModelContext {
  registerTool(tool: {
    name: string
    title: string
    description: string
    inputSchema: object
    outputSchema: object
    annotations: { readOnlyHint: true; untrustedContentHint?: true }
    execute(input: Record<string, unknown>, options?: { signal?: AbortSignal }): unknown
  }, options: { signal: AbortSignal }): Promise<void> | void
  unregisterTool(name: string): void
}

const SYNC_KEY = "meitheal:webmcp-setting-changed"
const TASK_VIEWS = ["kanban", "table", "calendar", "timeline"]
const ERROR_RESULT = {
  type: "object",
  properties: { error: { type: "string" } },
  required: ["error"],
  additionalProperties: false,
}

function getModelContext() {
  return (document as Document & { modelContext?: BrowserModelContext }).modelContext
    ?? (navigator as Navigator & { modelContext?: BrowserModelContext }).modelContext
}

async function readWebMcpSetting(signal: AbortSignal): Promise<boolean> {
  const key = agentProtocolSettingKey("webmcp")
  const response = await fetch(`/api/settings?key=${key}`, { signal, cache: "no-store" })
  if (response.status === 403) return false
  if (!response.ok) throw new Error("Could not read WebMCP settings")
  const { value } = await response.json()
  return agentProtocolEnabled("webmcp", value)
}

export function notifyWebMcpPreferenceChanged(): void {
  try { localStorage.setItem(SYNC_KEY, crypto.randomUUID()) } catch { /* Other tabs recheck before use. */ }
}

// Keep one lifecycle observer across HMR and retire the previous module's tools
// and storage listener before installing the replacement runtime.
interface WebMcpRuntime {
  registration?: AbortController | undefined
  lifecycle?: AbortController
  configRevision: number
  observedPage?: AbortSignal
  onPageLoad?: (signal: AbortSignal) => void
  configure?: (enabled: boolean) => Promise<void>
}
const host = window as Window & {
  __meithealWebMcpRuntime?: WebMcpRuntime
  __meithealWebMcpLifecycleInstalled?: boolean
}
host.__meithealWebMcpRuntime?.registration?.abort()
host.__meithealWebMcpRuntime?.lifecycle?.abort()
const runtime: WebMcpRuntime = { configRevision: 0 }
host.__meithealWebMcpRuntime = runtime

function setStatus(status: "disabled" | "unavailable" | "registered" | "failed") {
  const el = document.getElementById("webmcp-runtime-status")
  if (el) el.textContent = el.dataset[status] ?? ""
}

export async function configureWebMcp(enabled: boolean): Promise<void> {
  if (host.__meithealWebMcpRuntime !== runtime) {
    await host.__meithealWebMcpRuntime?.configure?.(enabled)
    return
  }
  runtime.configRevision++
  if (enabled && runtime.registration && !runtime.registration.signal.aborted) return
  runtime.registration?.abort()
  runtime.registration = undefined
  const context = getModelContext()
  if (!enabled || !context?.registerTool || !context.unregisterTool) {
    setStatus(!enabled ? "disabled" : "unavailable")
    return
  }

  const controller = new AbortController()
  runtime.registration = controller
  const { signal } = controller
  const registered = new Set<string>()
  const unregister = () => {
    for (const name of registered) {
      try { context.unregisterTool(name) } catch { /* Already removed by the browser. */ }
      registered.delete(name)
    }
  }
  // Native registerTool implementations may ignore options.signal. Cancellation
  // must also remove each tool from the browser's actual registry.
  signal.addEventListener("abort", unregister, { once: true })
  const requestSignal = (toolSignal?: AbortSignal) => toolSignal ? AbortSignal.any([signal, toolSignal]) : signal
  async function canExecute(callSignal: AbortSignal): Promise<boolean> {
    if (callSignal.aborted) return false
    const enabled = await readWebMcpSetting(callSignal)
    if (!enabled && !signal.aborted) void configureWebMcp(false)
    return enabled && !callSignal.aborted
  }

  try {
    await context.registerTool({
      name: "meitheal_search_tasks",
      title: "Search Meitheal tasks",
      description: "Find Meitheal tasks by title and return matching titles and links.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", minLength: 1, maxLength: 160 } },
        required: ["query"],
      },
      outputSchema: { oneOf: [ERROR_RESULT, {
        type: "object",
        properties: { tasks: { type: "array", items: {
          type: "object",
          properties: { title: { type: "string" }, url: { type: "string" } },
          required: ["title", "url"],
        } } },
        required: ["tasks"],
        additionalProperties: false,
      }] },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input, options) {
        const query = typeof input.query === "string" ? input.query.trim() : ""
        if (!query || query.length > 160) return { error: "Enter a task title up to 160 characters." }
        const params = new URLSearchParams({ q: query, scope: "tasks", task_fields: "title", limit: "8" })
        try {
          const callSignal = requestSignal(options?.signal)
          if (!await canExecute(callSignal)) return { error: "Browser tools are unavailable." }
          const response = await fetch(`/api/search?${params}`, { signal: callSignal })
          if (!response.ok) return { error: "Meitheal task search is unavailable." }
          const { sections } = await response.json() as SearchResponse
          const tasks = sections.flatMap(section => section.items)
            .filter(item => item.kind === "task" && item.taskId)
            .map(item => ({
              title: item.title,
              url: `${buildIngressPagePath("/tasks")}?open=${encodeURIComponent(item.taskId!)}`,
            }))
          return { tasks }
        } catch {
          return { error: "Meitheal task search did not complete." }
        }
      },
    }, { signal })

    registered.add("meitheal_search_tasks")
    if (signal.aborted) {
      unregister()
      return
    }
    await context.registerTool({
      name: "meitheal_open_tasks",
      title: "Open a Tasks view",
      description: "Open the selected Meitheal Tasks view in the current tab.",
      inputSchema: {
        type: "object",
        properties: { view: { type: "string", enum: TASK_VIEWS } },
        required: ["view"],
      },
      outputSchema: { oneOf: [ERROR_RESULT, {
        type: "object",
        properties: { opened: { type: "string", enum: TASK_VIEWS } },
        required: ["opened"],
        additionalProperties: false,
      }] },
      annotations: { readOnlyHint: true },
      async execute({ view }, options) {
        if (typeof view !== "string" || !TASK_VIEWS.includes(view)) {
          return { error: "Choose Kanban, Table, Calendar, or Timeline." }
        }
        try {
          if (!await canExecute(requestSignal(options?.signal))) return { error: "Browser tools are unavailable." }
          window.location.href = buildIngressPagePath("/tasks", view)
          return { opened: view }
        } catch {
          return { error: "Could not open the Tasks view." }
        }
      },
    }, { signal })
    registered.add("meitheal_open_tasks")
    if (signal.aborted) unregister()
    else setStatus("registered")
  } catch {
    if (!signal.aborted) {
      controller.abort()
      setStatus("failed")
    }
  }
}

runtime.onPageLoad = signal => {
  if (host.__meithealWebMcpRuntime !== runtime || (!getModelContext()?.registerTool || !getModelContext()?.unregisterTool) || runtime.observedPage === signal) return
  runtime.observedPage = signal
  runtime.lifecycle?.abort()
  const lifecycle = new AbortController()
  runtime.lifecycle = lifecycle
  signal.addEventListener("abort", () => {
    runtime.registration?.abort()
    lifecycle.abort()
  }, { once: true, signal: lifecycle.signal })

  async function refresh() {
    const revision = runtime.configRevision
    try {
      const enabled = await readWebMcpSetting(signal)
      if (host.__meithealWebMcpRuntime === runtime && !signal.aborted && revision === runtime.configRevision) await configureWebMcp(enabled)
    } catch {
      if (host.__meithealWebMcpRuntime === runtime && !signal.aborted && revision === runtime.configRevision) {
        await configureWebMcp(false)
        setStatus("failed")
      }
    }
  }

  window.addEventListener("storage", event => {
    if (event.key === SYNC_KEY) void refresh()
  }, { signal: lifecycle.signal })
  void refresh()
}

runtime.configure = configureWebMcp
if (!host.__meithealWebMcpLifecycleInstalled) {
  host.__meithealWebMcpLifecycleInstalled = true
  pageLifecycle.onPageLoad(signal => host.__meithealWebMcpRuntime?.onPageLoad?.(signal))
}
runtime.onPageLoad(pageLifecycle.signal)
