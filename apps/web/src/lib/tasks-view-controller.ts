/**
 * Resolve legacy Tasks hashes and keep keyboard view switching on the SSR routes.
 * @domain navigation
 */
import { singleKeyShortcutsEnabled } from "@lib/single-key-shortcuts"
import { hasPriorityOverlay } from "@lib/layout-shortcuts-controller"
import { getLegacyTaskId, openTaskDetailHandoff } from "@lib/task-detail-handoff"
import { parseTaskView, TASK_VIEWS, taskViewUrl, type TaskView } from "@lib/task-view-route"
import { taskBackgroundUrl, ticketIdFromPath } from "@lib/task-page-url"

const STORAGE_KEY = "meitheal:tasks-last-view"

export function initTasksViewSwitcher(rendered: TaskView, signal: AbortSignal): void {
  const navigation = document.querySelector<HTMLElement>("[data-view-tabs]")
  if (!navigation || navigation.dataset.switcherReady === "true") return
  navigation.dataset.switcherReady = "true"
  signal.addEventListener("abort", () => { delete navigation.dataset.switcherReady }, { once: true })

  function syncLegacyLocation(initial = false) {
    const url = new URL(location.href)
    if (ticketIdFromPath(url.pathname, window.__ingress_path) !== null) return true
    const legacyTask = getLegacyTaskId(url.hash)
    let requested = parseTaskView(url.hash.slice(1))
    if (initial && !url.hash && !url.searchParams.has("view") && !url.searchParams.has("open")) {
      try { requested = parseTaskView(localStorage.getItem(STORAGE_KEY)) } catch { /* storage unavailable */ }
    }
    if (requested && requested !== rendered) {
      location.replace(taskViewUrl(url, requested))
      return false
    }
    if (legacyTask) url.searchParams.set("open", legacyTask)
    if (url.hash !== `#${rendered}`) {
      history.replaceState(history.state, "", taskViewUrl(url, rendered))
    }
    return true
  }

  if (!syncLegacyLocation(true)) return
  try { localStorage.setItem(STORAGE_KEY, rendered) } catch { /* storage unavailable */ }

  navigation.querySelectorAll<HTMLAnchorElement>("[data-view-tab]").forEach(link => {
    const view = parseTaskView(link.dataset.viewTab ?? null)
    if (!view) return
    link.addEventListener("click", () => {
      // Other views can update query filters without re-rendering the links.
      const url = taskViewUrl(taskBackgroundUrl(new URL(location.href)), view)
      link.href = url.href
    }, { signal })
  })

  window.addEventListener("hashchange", () => { syncLegacyLocation() }, { signal })
  window.addEventListener("keydown", e => {
    const target = e.target as HTMLElement | null
    if (e.defaultPrevented || hasPriorityOverlay() || target?.isContentEditable || target?.closest("input, textarea, select, [role='dialog']") ||
        e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.isComposing) return
    if (!/^[1-4]$/.test(e.key) || !singleKeyShortcutsEnabled()) return
    const view = TASK_VIEWS[Number(e.key) - 1]
    if (view && view !== rendered) {
      e.preventDefault()
      location.assign(taskViewUrl(taskBackgroundUrl(new URL(location.href)), view))
    }
  }, { signal })
  window.addEventListener("meitheal:open-task", event => {
    const id = (event as CustomEvent).detail?.taskId
    if (typeof id === "string") openTaskDetailHandoff(id)
  }, { signal })
}
