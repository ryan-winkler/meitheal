import type { KanbanIndexRow, KanbanLane, TaskRepository } from "@domains/tasks/persistence/task-repository"
import { isTaskVisible } from "./filter-state"
import { KANBAN_PAGE_SIZE, readKanbanFilters, readKanbanPage } from "./kanban-query"

export async function loadKanbanBoard(repo: TaskRepository, lanes: KanbanLane[], cutoff: number, params: URLSearchParams) {
  const filters = readKanbanFilters(params)
  const candidates = await repo.getKanbanIndex(
    [...new Set(lanes.flatMap(lane => lane.includes))], cutoff,
    {
      matchText: Boolean(filters.search || filters.labels?.length || filters.advancedFilter),
      matchOverdue: filters.status === "overdue",
    },
  )
  const byStatus = new Map<string, { total: number; matches: KanbanIndexRow[] }>()
  for (const task of candidates) {
    let group = byStatus.get(task.status)
    if (!group) {
      group = { total: 0, matches: [] }
      byStatus.set(task.status, group)
    }
    group.total++
    if (filters.promoted && task.is_promoted !== 1) continue
    const dataset = {
      title: task.title ?? "",
      search: task.title?.toLowerCase() ?? "",
      status: task.status,
      overdue: task.overdue === 1 ? "true" : undefined,
      priority: String(task.priority ?? 3),
      taskType: task.task_type ?? "task",
      taskKind: task.task_kind ?? "standard_action",
      area: task.area_id ?? "default",
      assigned: task.assigned_to ?? "",
      labels: task.labels ?? "[]",
    }
    if (isTaskVisible({ dataset }, filters)) group.matches.push(task)
  }

  const rank = new Map(candidates.map((task, index) => [task.id, index]))
  const pages = lanes.map(lane => {
    const groups = [...new Set(lane.includes)].flatMap(status => byStatus.get(status) ?? [])
    const matches = groups.flatMap(group => group.matches)
    if (groups.length > 1) matches.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
    const total = groups.reduce((sum, group) => sum + group.total, 0)
    const pageCount = Math.max(1, Math.ceil(matches.length / KANBAN_PAGE_SIZE))
    const page = Math.min(readKanbanPage(params, lane.key), pageCount)
    const offset = (page - 1) * KANBAN_PAGE_SIZE
    return { key: lane.key, total, matches: matches.length, pageCount, page, offset, ids: matches.slice(offset, offset + KANBAN_PAGE_SIZE).map(task => task.id) }
  })
  const cards = new Map((await repo.getKanbanCards([...new Set(pages.flatMap(page => page.ids))], cutoff)).map(task => [task.id, task]))
  return new Map(pages.map(page => [page.key, {
    ...page,
    cards: page.ids.flatMap(id => cards.get(id) ?? []),
  }]))
}
