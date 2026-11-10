export const TASK_VIEWS = ["kanban", "table", "calendar", "timeline"] as const
export type TaskView = (typeof TASK_VIEWS)[number]

export function parseTaskView(value: string | null): TaskView | undefined {
  return TASK_VIEWS.find(view => view === value)
}

export function taskViewUrl(current: URL, view: TaskView): URL {
  const url = new URL(current)
  if (view === "kanban") url.searchParams.delete("view")
  else url.searchParams.set("view", view)
  url.hash = view
  return url
}
