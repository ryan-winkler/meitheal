import { stripIngressPrefix } from "./ingress-state-persistence"
import { pageLifecycle } from "./page-lifecycle"
import { taskCapturePlacement } from "./task-capture-placement"
import { currentTaskApiContext } from "./task-api"
import { readWorkspacePreferences } from "./workspace-preferences"

const ordinaryPages = new Set(["/", "/today", "/upcoming", "/tasks"])

export function openWorkspaceQuickAdd(trigger: HTMLElement | undefined, openTaskForm: () => void): boolean {
  const path = stripIngressPrefix(location.pathname).replace(/\/$/, "") || "/"
  if ((!ordinaryPages.has(path) && !/^\/boards\/[^/]+$/.test(path)) || readWorkspacePreferences().capture !== "quick") return false
  const context = currentTaskApiContext()
  if (!context) return false
  const placement = taskCapturePlacement()

  const query = new URLSearchParams(location.search)
  if (["capture", "ticket", "open"].some(key => query.has(key))) return false
  const signal = pageLifecycle.signal
  void import("./preferred-quick-add")
    .then(({ openQuickAdd }) => openQuickAdd(trigger, signal, { context, placement }))
    .catch(() => { if (!signal.aborted) openTaskForm() })
  return true
}
