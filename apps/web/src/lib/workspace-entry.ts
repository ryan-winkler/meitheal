import { readIngressPanelRoute, safeIngressHref, syncIngressDestination } from "./ingress-navigation"
import { stripIngressPrefix } from "./ingress-state-persistence"
import { readWorkspacePreferences } from "./workspace-preferences"

export const DASHBOARD_PATH = "/?view=dashboard"
export const TASKS_START_PATH = "/tasks?view=kanban#kanban"
let initialDocument = true

export function bindWorkspaceEntry(signal: AbortSignal): void {
  const root = document.documentElement
  const scope = root.dataset.workspaceScope
  if (!scope || root.dataset.workspaceBound === "true") return
  const freshLaunch = initialDocument
  initialDocument = false
  root.dataset.workspaceBound = "true"
  signal.addEventListener("abort", () => { delete root.dataset.workspaceBound }, { once: true })

  if (scope !== "browser") {
    window.addEventListener("pagehide", () => { root.dataset.workspaceFrozen = "true" }, { signal })
    window.addEventListener("pageshow", event => {
      if (event.persisted) window.location.reload()
    }, { signal })
  }

  const preferences = readWorkspacePreferences()
  const invite = document.querySelector<HTMLElement>("[data-setup-invite]")
  const dashboard = stripIngressPrefix(location.pathname) === "/"
  const bareLaunch = dashboard && !location.search && !location.hash
  const explicitDashboard = dashboard && location.search === "?view=dashboard" && !location.hash
  const restored = root.dataset.workspaceRestoring === "true" || readIngressPanelRoute() !== null ||
    performance.getEntriesByType("navigation").some(entry => "type" in entry && entry.type === "back_forward")
  if (freshLaunch && bareLaunch && !restored && preferences.firstPage === "tasks") {
    syncIngressDestination(TASKS_START_PATH)
    window.location.replace(safeIngressHref(TASKS_START_PATH))
    return
  }
  if (invite) invite.hidden = !(bareLaunch || explicitDashboard) || Boolean(preferences.acknowledged)
}
