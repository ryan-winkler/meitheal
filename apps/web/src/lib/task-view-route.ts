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

export const TASK_SCALAR_FILTER_KEYS = ["search", "status", "priority", "rice", "sort", "user", "area", "groupBy", "subGroupBy"] as const
export const TASK_ARRAY_FILTER_KEYS = ["types", "labels"] as const
export const TASK_JSON_FILTER_KEYS = ["advancedFilter", "columns"] as const
export const TASK_PERSISTED_FILTER_KEYS = [...TASK_SCALAR_FILTER_KEYS, ...TASK_ARRAY_FILTER_KEYS, ...TASK_JSON_FILTER_KEYS] as const

export function parseTaskView(value: string | null): TaskView | undefined {
  return TASK_VIEWS.find(view => view === value)
}

export function readTaskAreaParam(params: URLSearchParams): string | null {
  return params.get("area_id") ?? params.get("area") ?? params.get("board")
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
