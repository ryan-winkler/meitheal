import { normalizeTableRules, readTableTaskTypeParam, readTaskAreaParam, readTaskScalarParam, TASK_PERSISTED_FILTER_KEYS, TASK_SCALAR_FILTER_KEYS } from "./filter-state"
import { readKanbanRules } from "./kanban-query"

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

export function requestedTaskView(params: URLSearchParams, hash = ""): TaskView | undefined {
  return parseTaskView(params.get("view")) ?? parseTaskView(hash.slice(1)) ??
    (readTableTaskTypeParam(params) ? "table" : undefined)
}

export function appliedTaskRules(params: URLSearchParams, view: TaskView) {
  if (view === "timeline") return
  const values = params.getAll("advancedFilter")
  if (view !== "kanban") {
    const raw = values.at(-1)
    const rules = normalizeTableRules(raw)
    if (raw && rules) return { raw, rules }
  }
  if (view !== "table") {
    const raw = values[0]
    const rules = readKanbanRules(raw ?? null)
    if (raw && rules) return { raw, rules }
  }
}

export function taskViewUrl(current: URL, view: TaskView, explicitFilters = false): URL {
  const url = new URL(current)
  const previousView = requestedTaskView(url.searchParams, url.hash) ?? "kanban"
  if (previousView !== view) {
    const area = previousView === "calendar" || previousView === "table"
      ? readTaskAreaParam(url.searchParams)
      : url.searchParams.get("area")
    if (area !== null) url.searchParams.set("area", area)
    url.searchParams.delete("area_id")
    url.searchParams.delete("board")
    for (const key of [...TASK_SCALAR_FILTER_KEYS, "types", "task_type"]) {
      if (key !== "area" && url.searchParams.getAll(key).length > 1) {
        url.searchParams.set(key, readTaskScalarParam(url.searchParams, key, previousView)!)
      }
    }
    if (url.searchParams.getAll("advancedFilter").length > 1) {
      const applied = appliedTaskRules(url.searchParams, previousView)
      if (applied?.rules.conditions.length) url.searchParams.set("advancedFilter", applied.raw)
      else url.searchParams.delete("advancedFilter")
    }
  }
  if (view === "kanban" && url.searchParams.get("view") !== "kanban" &&
    !readTableTaskTypeParam(url.searchParams)) {
    url.searchParams.delete("view")
  } else {
    url.searchParams.set("view", view)
  }
  if (view !== "table") {
    const params = url.searchParams
    const groupBy = params.get("groupBy")
    const subGroupBy = params.get("subGroupBy")
    if (groupBy === "epic" || groupBy === "workflow") {
      params.delete("groupBy")
      params.delete("subGroupBy")
    } else if (subGroupBy === "epic" || subGroupBy === "workflow") {
      params.delete("subGroupBy")
    }
    params.delete("tp")
  }
  // An explicit empty search skips legacy stored filters without overriding the remembered Area.
  if (explicitFilters && (view === "table" || view === "timeline") &&
    !TASK_PERSISTED_FILTER_KEYS.some(key => url.searchParams.has(key))) {
    url.searchParams.set("search", "")
  }
  url.hash = view
  return url
}
