import { isTaskVisible } from "./filter-state"
import { KANBAN_PAGE_SIZE, readKanbanFilters, readKanbanPage } from "./kanban-query"
import { isDueOverdue } from "./date"
import { isClosedStatus } from "./status-config"

export interface NamedKanbanIndex {
  id: string
  laneId: string
  title: string
  search: string
  status: string
  assignedTo: string
  areaId: string
  dueDate: string | null
  routine: boolean
}

/** Filter the authorized index before paging; detailed descriptions are read only for visible cards. */
export function namedKanbanPages(index: NamedKanbanIndex[], params: URLSearchParams, laneIds: Array<{ id: string; key: string }>, timezone = "Europe/Dublin") {
  const filters = readKanbanFilters(params)
  // Area/Project selection is enforced by the repository against Board-owned placement.
  const criteria = { ...filters, area: "" }
  return laneIds.map(lane => {
    const candidates = index.filter(task => task.laneId === lane.id)
    const matches = candidates.filter(task => !filters.promoted && isTaskVisible({ dataset: {
      title: task.title, search: task.search.toLowerCase(), status: task.status,
      priority: "3", taskType: "task", taskKind: task.routine ? "routine_instance" : "standard_action",
      assigned: task.assignedTo, area: task.areaId, labels: "[]",
      overdue: !isClosedStatus(task.status) && task.dueDate && isDueOverdue(task.dueDate, timezone) ? "true" : undefined,
    } }, criteria))
    const pageCount = Math.max(1, Math.ceil(matches.length / KANBAN_PAGE_SIZE))
    const page = Math.min(readKanbanPage(params, lane.key), pageCount)
    const offset = (page - 1) * KANBAN_PAGE_SIZE
    return { key: lane.key, laneId: lane.id, total: candidates.length, matches: matches.length, pageCount, page, offset,
      ids: matches.slice(offset, offset + KANBAN_PAGE_SIZE).map(task => task.id) }
  })
}
