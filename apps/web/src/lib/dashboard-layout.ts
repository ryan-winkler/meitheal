import { DASHBOARD_SECTIONS, type DashboardSectionId } from "./dashboard-registry"

export type DashboardWidgetWidth = "full" | "half"

export interface DashboardWidgetPreference {
  id: DashboardSectionId
  visible: boolean
  width: DashboardWidgetWidth
  collapsed: boolean
}

export const dashboardLayoutKey = "meitheal:dashboard-layout:v1"

export function normalizeDashboardLayout(value: unknown): DashboardWidgetPreference[] {
  const saved = new Map<unknown, Record<string, unknown>>()
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === "object" && "id" in item && !saved.has(item.id)) {
        saved.set(item.id, item as Record<string, unknown>)
      }
    }
  }
  const sections = new Map(DASHBOARD_SECTIONS.map(({ id }) => [id, id]))
  const ids = [...new Set([...saved.keys(), ...sections.keys()])]
  return ids.flatMap(id => {
    const sectionId = sections.get(id as DashboardSectionId)
    if (!sectionId) return []
    const preferences = saved.get(id)
    return [{
      id: sectionId,
      visible: preferences?.visible !== false,
      width: preferences?.width === "half" ? "half" : "full",
      collapsed: preferences?.collapsed === true,
    }]
  })
}

export function dashboardLayoutStorageKey(): string | null {
  const { workspaceScope, workspaceFrozen } = document.documentElement.dataset
  return workspaceScope && !workspaceFrozen ? `${dashboardLayoutKey}:${workspaceScope}` : null
}

export function readDashboardLayout(key: string | null): DashboardWidgetPreference[] {
  try {
    return normalizeDashboardLayout(key ? JSON.parse(localStorage.getItem(key) ?? "null") : null)
  } catch {
    return normalizeDashboardLayout(null)
  }
}

export function applyDashboardOrder(
  container: HTMLElement, nodes: Map<string, HTMLElement>, order: DashboardWidgetPreference[],
): void {
  let next: HTMLElement | null = null
  for (const { id } of [...order].reverse()) {
    const item = nodes.get(id)
    if (!item) continue
    if (item.nextElementSibling !== next) {
      const focused = document.activeElement
      if (typeof container.moveBefore === "function") container.moveBefore(item, next)
      else container.insertBefore(item, next)
      if (focused instanceof HTMLElement && item.contains(focused) && focused !== document.activeElement) {
        focused.focus({ preventScroll: true })
      }
    }
    next = item
  }
}
