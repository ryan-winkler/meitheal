import { matchesRiceFilter, matchesStatusFilter } from "./filter-state"
import type { TaskViewItem } from "./task-queries"

const PAGE_SIZE = 50
const PAGE_PARAM = "unscheduledPage"

export interface TodayFilters {
  search: string
  status: string
  priority: string
  rice: string
  sort: string
}

type Row = Pick<HTMLElement, "dataset">

export function matchesTodayFilters({ dataset }: Row, filters: TodayFilters): boolean {
  return (!filters.search || (dataset.search ?? dataset.title ?? "").includes(filters.search))
    && matchesStatusFilter({ dataset }, filters.status)
    && (!filters.priority || dataset.priority === filters.priority)
    && matchesRiceFilter({ dataset }, filters.rice)
}

export function compareTodayRows(left: Row, right: Row, sort: string): number {
  const [field, direction] = sort.split("-")
  function value({ dataset }: Row): string | number {
    switch (field) {
      case "priority": return Number(dataset.priority ?? "3")
      case "rice": return Number(dataset.rice ?? "0")
      case "title": return dataset.title ?? ""
      case "due_date": return dataset.due ?? "9999"
      default: return 0
    }
  }
  const a = value(left)
  const b = value(right)
  const order = a < b ? -1 : a > b ? 1 : 0
  return direction === "asc" ? order : -order
}

export function requestedUnscheduledPage(params: URLSearchParams): number | null {
  const requested = Number(params.get(PAGE_PARAM))
  return Number.isSafeInteger(requested) && requested >= 1 ? requested : null
}

export function getUnscheduledPage(tasks: TaskViewItem[], params: URLSearchParams) {
  const requested = requestedUnscheduledPage(params)
  if (requested === null) return null
  const filters: TodayFilters = {
    search: params.get("search")?.toLowerCase() ?? "",
    status: params.get("status") ?? "",
    priority: params.get("priority") ?? "",
    rice: params.get("rice") ?? "",
    sort: params.get("sort") ?? "priority-asc",
  }
  const matching = tasks.map(task => ({
    task,
    dataset: {
      search: [task.title, task.description ?? "", ...task.labels].join(" ").toLowerCase(),
      status: task.status,
      priority: String(task.priority),
      rice: task.rice === null ? "" : String(task.rice),
      overdue: String(task.is_overdue),
      title: task.title.toLowerCase(),
      due: task.due_date ?? "",
    },
  })).filter(row => matchesTodayFilters(row, filters))
    .sort((a, b) => compareTodayRows(a, b, filters.sort))
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE))
  const number = Math.min(requested, pages)
  const start = (number - 1) * PAGE_SIZE
  const items = matching.slice(start, start + PAGE_SIZE).map(row => row.task)
  return { number, pages, items, first: start + 1, last: start + items.length, total: matching.length }
}

export function setUnscheduledPage(url: URL, page: number): URL {
  if (page > 0) url.searchParams.set(PAGE_PARAM, String(page))
  else url.searchParams.delete(PAGE_PARAM)
  return url
}
