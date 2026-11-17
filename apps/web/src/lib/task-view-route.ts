import { normalizeTableRules, readTaskAreaParam, TASK_PERSISTED_FILTER_KEYS } from "./filter-state"

export const TASK_VIEWS = ["kanban", "table", "calendar", "timeline"] as const
export type TaskView = (typeof TASK_VIEWS)[number]

export const TASK_VIEW_LABELS = {
  kanban: "Kanban",
  table: "Table",
  calendar: "Calendar",
  timeline: "Timeline (Gantt)",
} as const

export const TASK_VIEW_ICONS = {
  kanban: "kanban",
  table: "table",
  calendar: "calendar",
  timeline: "chart-bar",
} as const

export function parseTaskView(value: string | null): TaskView | undefined {
  return TASK_VIEWS.find(view => view === value)
}

export function taskViewUrl(current: URL, view: TaskView, explicitFilters = false): URL {
  const url = new URL(current)
  const previousView = parseTaskView(url.searchParams.get("view")) ?? parseTaskView(url.hash.slice(1))
  if (previousView !== view) {
    const area = previousView === "calendar" || previousView === "table"
      ? readTaskAreaParam(url.searchParams)
      : url.searchParams.get("area")
    if (area !== null) url.searchParams.set("area", area)
    url.searchParams.delete("area_id")
    url.searchParams.delete("board")
    const rules = url.searchParams.getAll("advancedFilter")
    if (rules.length > 1 && previousView && previousView !== "timeline") {
      const last = rules.at(-1)!
      const usesLast = previousView === "table" || (previousView === "calendar" && normalizeTableRules(last))
      url.searchParams.set("advancedFilter", usesLast ? last : rules[0]!)
    }
  }
  if (view === "kanban") url.searchParams.delete("view")
  else url.searchParams.set("view", view)
  if (view !== "table") url.searchParams.delete("tp")
  // An explicit empty search skips legacy stored filters without overriding the remembered Area.
  if (explicitFilters && (view === "table" || view === "timeline") &&
    !TASK_PERSISTED_FILTER_KEYS.some(key => url.searchParams.has(key))) {
    url.searchParams.set("search", "")
  }
  url.hash = view
  return url
}
