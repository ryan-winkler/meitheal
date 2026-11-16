import { matchesRiceFilter, matchesStatusFilter } from "./filter-state"
import { isActiveStatus, isDoneStatus, normalizeStatus, STATUS_LABELS } from "./status-config"
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

const pendingStatusWrites = new WeakMap<HTMLElement, Set<string>>()

export function lockTodayTaskStatus(container: HTMLElement, id: string): (() => void) | null {
  const pending = pendingStatusWrites.get(container) ?? new Set<string>()
  if (pending.has(id)) return null
  pendingStatusWrites.set(container, pending)
  pending.add(id)
  const focused = document.activeElement
  const taskId = CSS.escape(id)
  const controls = [...container.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
    `.tli__checkbox[data-id="${taskId}"], .focus-card__complete[data-id="${taskId}"]`,
  )].filter(control => !control.disabled && !control.hasAttribute("aria-disabled"))
  controls.forEach(control => control.setAttribute("aria-disabled", "true"))
  const section = focused?.closest(".today-section, .focus-stack")
  return () => {
    pending.delete(id)
    controls.forEach(control => control.removeAttribute("aria-disabled"))
    if (!controls.includes(focused as HTMLInputElement) ||
        (document.activeElement !== focused && document.activeElement !== document.body)) return
    if (focused instanceof HTMLElement && focused.isConnected && !focused.closest(".filtered-out, .focus-card--completing")) {
      if (document.activeElement !== focused) focused.focus({ preventScroll: true })
      return
    }
    const next = section?.querySelector<HTMLElement>(
      ".tli:not(.filtered-out) .tli__checkbox, .focus-card:not(.focus-card--completing) .focus-card__complete",
    ) ?? section?.querySelector<HTMLElement>(".today-section__header")
    const fallback = container.querySelector<HTMLElement>("#today-filter-status")
    if (next) next.focus()
    else fallback?.focus()
  }
}

/** Keep status, controls and filters consistent across visible copies of a Today task. */
export function syncTodayTaskStatus(container: HTMLElement, id: string, value: string): void {
  const status = normalizeStatus(value)
  const done = isDoneStatus(status)
  const active = isActiveStatus(status)
  const taskId = CSS.escape(id)
  for (const item of container.querySelectorAll<HTMLElement>(`.tli[data-id="${taskId}"], .focus-card[data-id="${taskId}"]`)) {
    item.dataset.status = status
    item.toggleAttribute("data-work-active", active)
    const badge = item.querySelector<HTMLElement>("[data-badge-status]")
    if (badge) {
      badge.dataset.badgeStatus = status
      badge.textContent = STATUS_LABELS[status] ?? status
    }
    const checkbox = item.querySelector<HTMLInputElement>(".tli__checkbox")
    if (checkbox) {
      checkbox.checked = done
      item.classList.toggle("tli--done", done)
      item.querySelector(".tli__title")?.classList.toggle("done", done)
    }
    if (done && item.matches(".focus-card:not(.focus-card--completing)")) item.remove()
  }
  const remaining = container.querySelectorAll(".focus-card:not(.focus-card--completing)").length
  const count = container.querySelector(".focus-stack__subtitle")
  if (count) count.textContent = `${remaining} to focus on`
  container.dispatchEvent(new CustomEvent("meitheal:today-status-committed", { detail: { id } }))
}
