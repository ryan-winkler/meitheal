import { getGroupKey, isTaskVisible, type FilterState } from "./filter-state"
import { CANONICAL_STATUSES, normalizeStatus, STATUS } from "./status-config"
import type { TaskViewItem } from "./task-queries"
import { formatTicketKey } from "./ticket-key"

export const TABLE_PAGE_SIZE = 50

export interface TableGroupStats {
  count: number
  riceSum: number
  riceCount: number
}

export interface TablePageStats {
  total: TableGroupStats
  groups: [string, TableGroupStats][]
  subgroups: [string, TableGroupStats][]
}

interface TableRow {
  task: TaskViewItem
  depth: number
  parentId?: string | undefined
  hasChildren: boolean
  parentOutsidePage?: TaskViewItem
}

const groupOrders: Record<string, readonly string[]> = {
  rice: ["high", "medium", "low", "none"],
  status: CANONICAL_STATUSES,
  type: ["epic", "story", "task"],
}

function compareGroups(dimension: string, a: string, b: string): number {
  if (dimension === "priority") return Number(a) - Number(b)
  const order = groupOrders[dimension]
  const rank = (key: string) => {
    const index = order?.indexOf(key) ?? -1
    return index < 0 ? order?.length ?? 0 : index
  }
  return rank(a) - rank(b) || a.localeCompare(b)
}

function sortValue(task: TaskViewItem, column: string): string | number | null {
  switch (column) {
    case "title": return task.title.toLowerCase()
    case "key": return formatTicketKey(task.ticket_number) ?? "#" + task.id.slice(0, 8)
    case "type": return task.task_type
    case "status": return task.status
    case "priority": return task.priority
    case "due_date": {
      const date = Date.parse(task.due_date ?? "")
      return Number.isFinite(date) ? date : null
    }
    case "rice": return task.rice ?? 0
    default: return 0
  }
}

function recordMatch(stats: TableGroupStats, rice: number | null) {
  stats.count++
  if (rice === null) return
  stats.riceSum += rice
  stats.riceCount++
}

function groupStats(map: Map<string, TableGroupStats>, key: string, rice: number | null) {
  const stats = map.get(key) ?? { count: 0, riceSum: 0, riceCount: 0 }
  recordMatch(stats, rice)
  map.set(key, stats)
}

/** Filter and order the entire eligible task set before projecting one Table page. */
export function getTablePage(tasks: TaskViewItem[], filters: Partial<FilterState>, requestedPage: string | null) {
  const groupBy = filters.groupBy ?? "none"
  const subgroupBy = filters.subGroupBy ?? "none"
  const [column = "", direction] = (filters.sort ?? "").split("-")
  const compare = (a: TaskViewItem, b: TaskViewItem) => {
    const left = sortValue(a, column)
    const right = sortValue(b, column)
    if (left === null || right === null) return Number(left === null) - Number(right === null)
    const order = typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right))
    return direction === "desc" ? -order : order
  }

  const byId = new Map<string, TaskViewItem>()
  const matching = new Map<string, { task: TaskViewItem; group: string; subgroup: string }>()
  const groups = new Map<string, TableGroupStats>()
  const subgroups = new Map<string, TableGroupStats>()
  const total = { count: 0, riceSum: 0, riceCount: 0 }
  const subgroupOrder = new Map<string, number>()
  let active = 0
  let overdue = 0
  for (const source of tasks) {
    const status = normalizeStatus(source.status)
    const isDone = status === STATUS.COMPLETE
    const task = status === source.status ? source : {
      ...source, status, is_done: isDone, is_overdue: !isDone && source.is_overdue,
    }
    byId.set(task.id, task)
    const row = {
      dataset: {
        title: task.title.toLowerCase(),
        search: filters.search ? [task.title, task.description ?? "", ...task.labels].join(" ").toLowerCase() : "",
        status: task.status,
        priority: String(task.priority),
        rice: task.rice === null ? "" : String(task.rice),
        assigned: task.assigned_to ?? "",
        area: task.area_id,
        taskType: task.task_type,
        taskKind: task.task_kind ?? "standard_action",
        labels: filters.advancedFilter || filters.labels?.length ? JSON.stringify(task.labels) : "[]",
        overdue: String(task.is_overdue),
      },
    }
    if (!isTaskVisible(row, filters)) continue
    const group = groupBy === "none" ? "" : getGroupKey(row, groupBy)
    const subgroup = subgroupBy === "none" ? "" : JSON.stringify([group, getGroupKey(row, subgroupBy)])
    matching.set(task.id, { task, group, subgroup })
    recordMatch(total, task.rice)
    if (task.status === STATUS.ACTIVE && task.deferred_at === null) active++
    if (task.is_overdue) overdue++
    if (groupBy === "none") continue
    groupStats(groups, group, task.rice)
    if (subgroupBy !== "none") {
      if (!subgroupOrder.has(subgroup)) subgroupOrder.set(subgroup, subgroupOrder.size)
      groupStats(subgroups, subgroup, task.rice)
    }
  }

  const ordered: TableRow[] = []
  if (groupBy !== "none") {
    const matches = [...matching.values()]
    matches.sort((a, b) => compareGroups(groupBy, a.group, b.group)
      || (subgroupOrder.get(a.subgroup) ?? 0) - (subgroupOrder.get(b.subgroup) ?? 0)
      || compare(a.task, b.task))
    for (const { task } of matches) ordered.push({ task, depth: 0, hasChildren: false })
  } else {
    const children = new Map<string, TaskViewItem[]>()
    const roots: TaskViewItem[] = []
    for (const task of byId.values()) {
      if (!task.parent_id || !byId.has(task.parent_id)) {
        roots.push(task)
        continue
      }
      const siblings = children.get(task.parent_id)
      if (siblings) siblings.push(task)
      else children.set(task.parent_id, [task])
    }
    if (column) roots.sort(compare)
    const visited = new Set<string>()
    const stack: Array<{ task: TaskViewItem; depth: number; parentId?: string | undefined }> = []
    function append(root: TaskViewItem) {
      stack.push({ task: root, depth: 0 })
      while (stack.length) {
        const { task, depth, parentId } = stack.pop()!
        if (visited.has(task.id)) continue
        visited.add(task.id)
        const included = matching.has(task.id)
        if (included) ordered.push({ task, depth, parentId, hasChildren: false })

        // Push in reverse to keep the original depth-first sibling order.
        const siblings = children.get(task.id) ?? []
        for (let index = siblings.length - 1; index >= 0; index--) {
          stack.push({
            task: siblings[index]!,
            depth: depth + Number(included),
            parentId: included ? task.id : parentId,
          })
        }
      }
    }
    for (const root of roots) append(root)
    for (const task of byId.values()) {
      if (!visited.has(task.id)) append(task)
    }
  }

  const pageCount = Math.max(1, Math.ceil(ordered.length / TABLE_PAGE_SIZE))
  const requested = Number(requestedPage)
  const page = Number.isSafeInteger(requested) ? Math.min(pageCount, Math.max(requested, 1)) : 1
  const offset = (page - 1) * TABLE_PAGE_SIZE
  const rows = ordered.slice(offset, offset + TABLE_PAGE_SIZE)
  const pageIds = new Set(rows.map(row => row.task.id))
  const pageParents = new Set(rows.map(row => row.parentId))
  const pageGroups = new Set<string>()
  const pageSubgroups = new Set<string>()
  for (const row of rows) {
    if (groupBy === "none") {
      row.hasChildren = pageParents.has(row.task.id)
      const parent = row.task.parent_id ? byId.get(row.task.parent_id) : undefined
      if (parent && !pageIds.has(parent.id)) row.parentOutsidePage = parent
    } else {
      const keys = matching.get(row.task.id)!
      pageGroups.add(keys.group)
      if (subgroupBy !== "none") pageSubgroups.add(keys.subgroup)
    }
  }
  const stats: TablePageStats = {
    total,
    groups: [...pageGroups].map(key => [key, groups.get(key)!]),
    subgroups: [...pageSubgroups].map(key => [key, subgroups.get(key)!]),
  }
  return { rows, page, pageCount, offset, stats, active, overdue }
}
