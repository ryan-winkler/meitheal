import { resolveTaskEpics } from "@domains/tasks"

import { getEpicGroupLabel } from "./epic-group-labels"
import { parseCalendarDay } from "./calendar-day"
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
  epicLabels: [string, string][]
}

interface TableRow {
  task: TaskViewItem
  depth: number
  parentId?: string | undefined
  workflowColumnId: string
  hasChildren: boolean
  epicGroup: string
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

export interface TableWorkflowColumn {
  id: string
  key: string
  label: string
  includes: readonly unknown[]
}

export function getTableWorkflowColumns(columns: readonly TableWorkflowColumn[], noWorkflowLabel: string) {
  const titles = columns.map(column => column.label.normalize("NFC").replace(/\s+/g, " ").trim() || column.key)
  const counts = new Map<string, number>()
  for (const title of titles) counts.set(title, (counts.get(title) ?? 0) + 1)

  const used = new Set([noWorkflowLabel, ...titles])
  return columns.map((column, index) => {
    const title = titles[index]!
    if (title !== noWorkflowLabel && counts.get(title) === 1) return { ...column, label: title }
    let label = `${title} (${column.key})`
    while (used.has(label)) label += " ·"
    used.add(label)
    return { ...column, label }
  })
}

function indexWorkflowStatuses(columns: readonly TableWorkflowColumn[]) {
  const byStatus = new Map<string, TableWorkflowColumn>()
  for (const column of columns) {
    if (!Array.isArray(column.includes)) continue
    for (const include of column.includes) {
      if (typeof include !== "string") continue
      const status = normalizeStatus(include)
      const current = byStatus.get(status)
      if (!current || (current.key !== status && column.key === status)) byStatus.set(status, column)
    }
  }
  return byStatus
}

function creationDateFormatter(timezone: string | undefined) {
  const format = (timeZone: string) => new Intl.DateTimeFormat("en", {
    timeZone, calendar: "gregory", numberingSystem: "latn", era: "short", year: "numeric", month: "2-digit", day: "2-digit",
  })
  const fallback = "Europe/Dublin"
  try {
    return format(timezone || fallback)
  } catch {
    return format(fallback)
  }
}

function creationCalendarDay(value: string, formatter: Intl.DateTimeFormat) {
  const stored = value.trim()
  const numeric = /^-?\d+$/u.test(stored)
  let timestamp = Number(stored)
  if (!numeric) {
    const legacy = /^(\d{4}-\d{2}-\d{2})(?:(?:[Tt]|\s+)(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)([Zz]|[+-]\d{2}:?\d{2})?)?$/u
    const match = legacy.exec(stored)
    if (!match?.[1] || !parseCalendarDay(match[1])) return
    timestamp = Date.parse(match[2] ? match[1] + "T" + match[2] + (match[3]?.toUpperCase() ?? "Z") : match[1])
  }
  if (!Number.isFinite(new Date(timestamp).getTime())) return
  const parts = formatter.formatToParts(timestamp)
  if (parts.find(part => part.type === "era")?.value !== "AD") return
  const year = parts.find(part => part.type === "year")?.value.padStart(4, "0")
  const month = parts.find(part => part.type === "month")?.value
  const day = parts.find(part => part.type === "day")?.value
  if (year?.length === 4 && month && day) return `${year}-${month}-${day}`
}

/** Filter and order the entire eligible task set before projecting one Table page. */
export function getTablePage(
  tasks: TaskViewItem[],
  filters: Partial<FilterState>,
  requestedPage: string | null,
  workflowColumns: readonly TableWorkflowColumn[] = [],
  timezone?: string,
) {
  const { createdFrom, createdThrough } = filters
  const creationDay = createdFrom || createdThrough ? creationDateFormatter(timezone) : undefined
  const groupBy = filters.groupBy ?? "none"
  const subgroupBy = filters.subGroupBy ?? "none"
  const laneIds = new Set(filters.laneIds)
  const scopedColumns = laneIds.size ? workflowColumns.filter(column => laneIds.has(column.id)) : workflowColumns
  const groupsByWorkflow = groupBy === "workflow" || (groupBy !== "none" && subgroupBy === "workflow")
  const workflowByStatus = groupsByWorkflow || laneIds.size ? indexWorkflowStatuses(scopedColumns) : undefined
  const workflowOrder = groupsByWorkflow ? new Map(scopedColumns.map((column, index) => [column.id, index])) : undefined
  const workflowRank = (key: string) => workflowOrder?.get(key) ?? scopedColumns.length
  const groupsByEpic = groupBy === "epic" || (groupBy !== "none" && subgroupBy === "epic")
  const epicsByTask = resolveTaskEpics(groupsByEpic ? tasks : [])
  const epicLabels = new Map<string, string>()
  for (const epic of epicsByTask.values()) {
    const key = `epic:${epic.id}`
    if (!epicLabels.has(key)) epicLabels.set(key, getEpicGroupLabel(epic))
  }
  const compareEpicGroups = (a: string, b: string) =>
    Number(a === "epic:none") - Number(b === "epic:none") ||
    (epicLabels.get(a) ?? "").localeCompare(epicLabels.get(b) ?? "") || a.localeCompare(b)
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
  const matching = new Map<string, { task: TaskViewItem; group: string; subgroup: string; workflowColumnId: string; epicGroup: string }>()
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
    const workflowColumn = workflowByStatus?.get(status)
    if (laneIds.size > 0 && !workflowColumn) continue
    const workflowColumnId = workflowColumn?.id ?? ""
    const epic = epicsByTask.get(task.id)
    const epicGroup = epic ? `epic:${epic.id}` : "epic:none"
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
        epicGroup,
        taskKind: task.task_kind ?? "standard_action",
        workflowColumnId,
        labels: filters.advancedFilter || filters.labels?.length ? JSON.stringify(task.labels) : "[]",
        overdue: String(task.is_overdue),
      },
    }
    if (!isTaskVisible(row, filters)) continue
    if (creationDay) {
      const day = creationCalendarDay(task.created_at, creationDay)
      if (!day || (createdFrom && day < createdFrom) || (createdThrough && day > createdThrough)) continue
    }
    const group = groupBy === "none" ? "" : getGroupKey(row, groupBy)
    const subgroup = subgroupBy === "none" ? "" : JSON.stringify([group, getGroupKey(row, subgroupBy)])
    matching.set(task.id, { task, group, subgroup, workflowColumnId, epicGroup })
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
    matches.sort((a, b) => {
      const primary = groupBy === "workflow"
        ? workflowRank(a.group) - workflowRank(b.group)
        : groupBy === "epic" ? compareEpicGroups(a.group, b.group) : compareGroups(groupBy, a.group, b.group)
      if (primary) return primary
      const secondary = subgroupBy === "workflow"
        ? workflowRank(a.workflowColumnId) - workflowRank(b.workflowColumnId)
        : subgroupBy === "epic"
          ? compareEpicGroups(a.epicGroup, b.epicGroup)
          : (subgroupOrder.get(a.subgroup) ?? 0) - (subgroupOrder.get(b.subgroup) ?? 0)
      return secondary || compare(a.task, b.task)
    })
    for (const { task, workflowColumnId, epicGroup } of matches) {
      ordered.push({ task, workflowColumnId, epicGroup, depth: 0, hasChildren: false })
    }
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
        const match = matching.get(task.id)
        if (match) ordered.push({ task, workflowColumnId: match.workflowColumnId, epicGroup: match.epicGroup, depth, parentId, hasChildren: false })

        // Push in reverse to keep the original depth-first sibling order.
        const siblings = children.get(task.id) ?? []
        for (let index = siblings.length - 1; index >= 0; index--) {
          stack.push({
            task: siblings[index]!,
            depth: depth + Number(Boolean(match)),
            parentId: match ? task.id : parentId,
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
  const pageEpicLabels = new Map<string, string>()
  for (const row of rows) {
    const epicLabel = epicLabels.get(row.epicGroup)
    if (epicLabel !== undefined) pageEpicLabels.set(row.epicGroup, epicLabel)
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
    epicLabels: [...pageEpicLabels],
    groups: [...pageGroups].map(key => [key, groups.get(key)!]),
    subgroups: [...pageSubgroups].map(key => [key, subgroups.get(key)!]),
  }
  return { rows, page, pageCount, offset, stats, active, overdue }
}
