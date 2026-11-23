import type { CalendarFilterRow } from "@domains/tasks"
import { calendarToday, isTaskOverdue } from "./date"
import type { FilterGroup } from "./filter-engine"
import { effectiveCalendarKinds, isTaskVisible, readTableTaskTypeParam, readTaskAreaParam } from "./filter-state"
import { readKanbanFilters, type KanbanFilters } from "./kanban-query"
import { frameworkPayloadObject, readRiceInputs, riceLensScore } from "./rice-lens"
import { isClosedStatus, isDoneStatus, normalizeStatus } from "./status-config"
import { appliedTaskRules } from "./task-view-route"

export const CALENDAR_FILTER_STATE_EVENT = "meitheal:calendar-filter-state"

export function readCalendarTaskFilters(params: URLSearchParams): KanbanFilters {
  const filters = readKanbanFilters(params)
  filters.types = effectiveCalendarKinds(filters.types ?? [])
  const area = readTaskAreaParam(params)
  if (area !== null && area.length <= 500) filters.area = area
  else delete filters.area
  const taskType = readTableTaskTypeParam(params)
  if (taskType) filters.task_type = taskType
  filters.advancedFilter = appliedTaskRules(params, "calendar")?.rules ?? null
  return filters
}

function rulesUseRice(group: FilterGroup): boolean {
  return group.conditions.some(condition => "conditions" in condition ? rulesUseRice(condition) : condition.field === "rice")
}

/** Share month and agenda matching. Connected calendar feeds are a separate source. */
export function createCalendarTaskFilter(params: URLSearchParams, timezone: string) {
  const filters = readCalendarTaskFilters(params)
  const projectId = params.get("project") ?? params.get("project_id")
  const includeCompletedInCounts = Boolean(filters.status || filters.advancedFilter?.conditions.length)
  const matchRice = Boolean(filters.rice || (filters.advancedFilter && rulesUseRice(filters.advancedFilter)))
  const today = calendarToday(timezone)
  const matches = (task: CalendarFilterRow): boolean => {
    if (projectId && task.project_id !== projectId) return false
    if (filters.promoted && Number(task.is_promoted) !== 1) return false
    const status = normalizeStatus(task.status)
    if (status === "archived" || (!includeCompletedInCounts && isDoneStatus(status))) return false
    let rice = ""
    if (matchRice) {
      try {
        const inputs = readRiceInputs(frameworkPayloadObject(JSON.parse(task.framework_payload || "{}")))
        const score = inputs && riceLensScore(inputs)
        if (score !== null) rice = String(score)
      } catch { /* Older or malformed payloads have no score. */ }
    }
    return isTaskVisible({ dataset: {
      title: task.title,
      search: task.title.toLowerCase(),
      status: task.status,
      overdue: filters.status === "overdue" && task.deferred_at === null &&
        isTaskOverdue(task, isClosedStatus(status), timezone, today) ? "true" : undefined,
      priority: String(task.priority ?? 3),
      taskType: task.task_type ?? "task",
      taskKind: task.task_kind ?? "standard_action",
      area: task.area_id ?? "default",
      assigned: task.assigned_to ?? "",
      labels: task.labels ?? "[]",
      rice,
    } }, filters)
  }

  const hasFilters = Boolean(projectId) || hasCalendarTaskFilters(filters)
  return {
    matches: hasFilters ? matches : undefined,
    matchesAgenda: hasFilters ? matches : (task: CalendarFilterRow) => normalizeStatus(task.status) !== "archived",
    includeCompletedInCounts,
    showConnectedEvents: !projectId && (!filters.types?.length || filters.types.includes("calendar_event")),
  }
}

export function hasCalendarTaskFilters(filters: KanbanFilters): boolean {
  return Boolean(filters.area || filters.search || filters.user || filters.status || filters.priority || filters.task_type ||
    filters.rice || filters.types?.length || filters.labels?.length || filters.promoted || filters.advancedFilter?.conditions.length)
}
