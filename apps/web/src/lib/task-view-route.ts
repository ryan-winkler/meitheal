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

export function readTaskAreaParam(params: URLSearchParams): string | null {
  return params.get("area_id") ?? params.get("area") ?? params.get("board")
}

export function taskViewUrl(current: URL, view: TaskView): URL {
  const url = new URL(current)
  const previousView = parseTaskView(url.searchParams.get("view")) ?? parseTaskView(url.hash.slice(1))
  if (previousView !== view && (previousView === "calendar" || previousView === "table")) {
    const area = readTaskAreaParam(url.searchParams)
    if (area !== null) url.searchParams.set("area", area)
    url.searchParams.delete("area_id")
    url.searchParams.delete("board")
  }
  if (view === "kanban") url.searchParams.delete("view")
  else url.searchParams.set("view", view)
  if (view !== "table") url.searchParams.delete("tp")
  url.hash = view
  return url
}
