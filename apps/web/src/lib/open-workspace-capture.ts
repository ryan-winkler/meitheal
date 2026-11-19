import { stripIngressPrefix } from "./ingress-state-persistence"
import { pageLifecycle } from "./page-lifecycle"
import { readWorkspacePreferences } from "./workspace-preferences"

const ordinaryPages = new Set(["/", "/today", "/upcoming", "/tasks"])

export function openWorkspaceQuickAdd(trigger?: HTMLElement): boolean {
  const path = stripIngressPrefix(location.pathname).replace(/\/$/, "") || "/"
  if (!ordinaryPages.has(path) || readWorkspacePreferences().capture !== "quick" ||
    (window.__activeArea && window.__activeArea !== "all" && window.__activeArea !== "default")) return false

  const query = new URLSearchParams(location.search)
  if (["board", "area", "group", "project", "capture", "ticket"].some(key => query.has(key))) return false
  const signal = pageLifecycle.signal
  void import("./preferred-quick-add")
    .then(({ openQuickAdd }) => openQuickAdd(trigger, signal))
    .catch(() => { if (!signal.aborted) window.openNewTaskModal?.() })
  return true
}
