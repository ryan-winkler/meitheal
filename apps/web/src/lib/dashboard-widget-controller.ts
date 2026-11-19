import { DASHBOARD_LAYOUT_PREFIX, workspaceStorageKey } from "./workspace-preferences"
import {
  readDashboardLayout,
  applyDashboardOrder,
} from "./dashboard-layout"
import type { DashboardSectionId } from "./dashboard-registry"

export function initDashboardWidgets(
  shell: HTMLElement, launcher: HTMLButtonElement, key: string, signal: AbortSignal, onChange: () => void,
) {
  const widgets = new Map(Array.from(shell.querySelectorAll<HTMLElement>("[data-dashboard-section]"), item => [item.id, item]))
  const empty = document.getElementById("dashboard-empty")
  const pageHeading = document.getElementById("dashboard-accessible-title")
  const switcher = document.querySelector<HTMLButtonElement>("#dashboard-bar-switcher-btn")
  const navigation = Array.from(document.querySelectorAll<HTMLElement>("#dashboard-bar-tabs, #dashboard-bar-switcher-dropdown"), group => ({
    group,
    entries: new Map(Array.from(group.querySelectorAll<HTMLElement>("[data-section-id]"), item => [item.dataset.sectionId ?? "", item])),
  }))
  const revealed = new Set<DashboardSectionId>()
  let layout = readDashboardLayout(key)

  function applyLayout(): void {
    for (const { id, visible, width, collapsed } of layout) {
      const widget = widgets.get(id)
      if (!widget) continue
      widget.hidden = !visible && !revealed.has(id)
      widget.dataset.dashboardWidth = width
      const folded = collapsed && !revealed.has(id)
      widget.querySelector<HTMLElement>("[data-dashboard-widget-body]")?.toggleAttribute("hidden", folded)
      widget.querySelector<HTMLElement>("[data-dashboard-widget-collapsed]")?.toggleAttribute("hidden", !folded)
    }
    applyDashboardOrder(shell, widgets, layout)
    const hasWidgets = Array.from(widgets.values()).some(widget => !widget.hidden)
    if (empty) {
      empty.hidden = hasWidgets
      if (!hasWidgets) void import("./tabler-styles").then(({ ensureTablerStyles }) => ensureTablerStyles()).catch(() => {})
    }
    const overviewHeading = shell.querySelector("#dashboard-overview h1")
    if (pageHeading) pageHeading.hidden = !hasWidgets || Boolean(overviewHeading && !overviewHeading.closest("[hidden]"))
  }

  function reveal(id: DashboardSectionId): void {
    const widget = widgets.get(id)
    if (!widget || revealed.has(id)) return
    if (!widget.hidden && !widget.querySelector("[data-dashboard-widget-body][hidden]")) return
    revealed.add(id)
    applyLayout()
  }

  function applyNavigation(): void {
    const hasVisible = layout.some(widget => widget.visible)
    if (switcher) switcher.disabled = !hasVisible
    for (const { group, entries } of navigation) {
      group.hidden = !hasVisible
      for (const { id, visible } of layout) entries.get(id)?.toggleAttribute("hidden", !visible)
      applyDashboardOrder(group, entries, layout)
    }
  }

  applyLayout()
  applyNavigation()
  let edit: ((control: HTMLElement) => void) | undefined
  async function openEditor(control: HTMLElement): Promise<void> {
    if (workspaceStorageKey(DASHBOARD_LAYOUT_PREFIX) !== key) return
    if (!edit) {
      const { bindDashboardLayoutEditor } = await import("./dashboard-layout-editor")
      if (signal.aborted) return
      edit ??= bindDashboardLayoutEditor(key, launcher, signal, draft => {
        layout = draft
        revealed.clear()
        applyLayout()
        applyNavigation()
        onChange()
      })
    }
    edit?.(control)
  }

  window.addEventListener("storage", event => {
    if (event.storageArea !== localStorage || (event.key !== key && event.key !== null) || workspaceStorageKey(DASHBOARD_LAYOUT_PREFIX) !== key) return
    layout = readDashboardLayout(key)
    applyLayout()
    applyNavigation()
    onChange()
  }, { signal })

  return { reveal, openEditor }
}
