import type { FilterGroup } from "./filter-engine"
import { effectiveCalendarKinds, readFilterLabels, readTableTaskKindFilter, readTableTaskTypeParam, readTaskAreaParam, readTaskKindFilter, readTaskScalarParam, TASK_SCALAR_FILTER_KEYS } from "./filter-state"
import { readKanbanSearch } from "./kanban-query"
import { normalizeStatus } from "./status-config"
import { appliedTaskRules, parseTaskView, type TaskView } from "./task-view-route"

export type TaskNavTypeId = "standard" | "shopping_item" | "checklist" | "calendar_event"

export type TaskNavDisplayMode = "all" | "none" | "custom"

export interface TaskNavTypeEntry {
  id: TaskNavTypeId
  kind: "standard_action" | "shopping_item" | "checklist" | "calendar_event"
  label: string
  icon: "checkbox" | "shopping-cart" | "list-check" | "calendar-event"
}

export interface TaskNavPrefs {
  mode: TaskNavDisplayMode
  visible: Record<TaskNavTypeId, boolean>
  pinned: TaskNavTypeId[]
  pinnedViews: TaskView[]
}

export const TASK_NAV_PREFS_KEY = "meitheal-task-nav-prefs"
export const TASK_NAV_PREFS_EVENT = "meitheal:task-nav-prefs-changed"

export const TASK_NAV_TYPES: readonly TaskNavTypeEntry[] = [
  {
    id: "standard",
    kind: "standard_action",
    label: "Task",
    icon: "checkbox",
  },
  {
    id: "shopping_item",
    kind: "shopping_item",
    label: "Shopping list",
    icon: "shopping-cart",
  },
  {
    id: "checklist",
    kind: "checklist",
    label: "Checklist",
    icon: "list-check",
  },
  {
    id: "calendar_event",
    kind: "calendar_event",
    label: "Event",
    icon: "calendar-event",
  },
] as const

const VALID_TYPE_IDS = new Set<TaskNavTypeId>(TASK_NAV_TYPES.map((item) => item.id))

export function defaultTaskNavPrefs(): TaskNavPrefs {
  return {
    mode: "all",
    visible: {
      standard: true,
      shopping_item: true,
      checklist: true,
      calendar_event: true,
    },
    pinned: [],
    pinnedViews: [],
  }
}

function taskKinds(params: URLSearchParams, view: TaskView): string[] {
  const raw = readTaskScalarParam(params, "types", view)
  const kinds = view === "table" ? readTableTaskKindFilter(raw) : readTaskKindFilter(raw)
  return [...new Set(kinds)]
}

function sameFilterValues(expected: string[], active: string[]): boolean {
  if (expected.length !== active.length) return false
  active.sort()
  return expected.sort().every((value, index) => value === active[index])
}

function effectiveRules(group: FilterGroup): unknown[] {
  return group.conditions.map((node, index) => [
    index === 0 ? null : node.logic ?? group.logic,
    "conditions" in node ? effectiveRules(node) : [node.field, node.operator, node.value],
  ])
}

function ruleSignature(params: URLSearchParams, view: TaskView): string | undefined {
  const rules = appliedTaskRules(params, view)?.rules
  if (rules?.conditions.length) return JSON.stringify(effectiveRules(rules))
}

export function matchingTaskShortcutCriteria(target: URLSearchParams, current: URLSearchParams, view: TaskView): number {
  const keys = new Set(target.keys())
  let matchedKinds = false
  if (keys.delete("types")) {
    const explicit = taskKinds(target, view)
    if (!explicit.length) return -1
    const kinds = view === "calendar" ? effectiveCalendarKinds(explicit) : explicit
    matchedKinds = kinds.length > 0
    if (matchedKinds && !sameFilterValues(kinds, taskKinds(current, view))) return -1
  }
  const matchedTaskType = keys.delete("task_type")
  if (matchedTaskType) {
    if (view !== "table" && view !== "calendar") return -1
    const type = readTableTaskTypeParam(target)
    if (!type || type !== readTableTaskTypeParam(current)) return -1
  }
  keys.delete("view")
  const matchedLabels = keys.has("label") || keys.has("labels")
  if (matchedLabels) {
    const labels = (params: URLSearchParams) => readFilterLabels(params).map(label => label.toLowerCase())
    if (!sameFilterValues(labels(target), labels(current))) return -1
    keys.delete("label")
    keys.delete("labels")
  }
  const matchedRules = view !== "timeline" && keys.delete("advancedFilter")
  if (matchedRules) {
    const expected = ruleSignature(target, view)
    if (!expected || expected !== ruleSignature(current, view)) return -1
  }
  let matchedArea = false
  if (view === "calendar" || view === "table") {
    const area = readTaskAreaParam(target)
    if (area !== null && area !== readTaskAreaParam(current)) return -1
    matchedArea = area !== null
    for (const alias of ["area", "area_id", "board"]) keys.delete(alias)
  }
  for (const key of keys) {
    const read = (params: URLSearchParams) => {
      if (!TASK_SCALAR_FILTER_KEYS.some(filter => filter === key)) return params.getAll(key)
      const value = readTaskScalarParam(params, key, view)
      if (key === "promoted" && (view === "calendar" || view === "kanban")) return [String(value === "1")]
      if (key === "search") {
        return [(view === "calendar" || view === "kanban" ? readKanbanSearch(value) : value ?? "").toLowerCase()]
      }
      return value === null ? [] : [key === "status" ? normalizeStatus(value) : value]
    }
    if (!sameFilterValues(read(target), read(current))) return -1
  }
  return keys.size + Number(matchedKinds) + Number(matchedTaskType) + Number(matchedArea) + Number(matchedLabels) + Number(matchedRules)
}

export function normalizeTaskNavPrefs(input: unknown): TaskNavPrefs {
  const defaults = defaultTaskNavPrefs()
  if (!input || typeof input !== "object") return defaults
  const raw = input as Record<string, unknown>
  const mode: TaskNavDisplayMode =
    raw.mode === "all" || raw.mode === "none" || raw.mode === "custom" ? raw.mode : "all"
  const visibleRaw = raw.visible && typeof raw.visible === "object" ? (raw.visible as Record<string, unknown>) : {}
  const visible: Record<TaskNavTypeId, boolean> = {
    standard: typeof visibleRaw.standard === "boolean" ? visibleRaw.standard : true,
    shopping_item: typeof visibleRaw.shopping_item === "boolean" ? visibleRaw.shopping_item : true,
    checklist: typeof visibleRaw.checklist === "boolean" ? visibleRaw.checklist : true,
    calendar_event: typeof visibleRaw.calendar_event === "boolean" ? visibleRaw.calendar_event : true,
  }

  const pinned = Array.isArray(raw.pinned)
    ? Array.from(new Set(raw.pinned.filter((id): id is TaskNavTypeId => typeof id === "string" && VALID_TYPE_IDS.has(id as TaskNavTypeId))))
    : []

  const pinnedViews = Array.isArray(raw.pinnedViews)
    ? [...new Set(raw.pinnedViews.flatMap(entry => {
      const view = parseTaskView(typeof entry === "string" ? entry : null)
      return view ? [view] : []
    }))]
    : []

  return { mode, visible, pinned, pinnedViews }
}

export function readTaskNavPrefs(): TaskNavPrefs {
  if (typeof window === "undefined") return defaultTaskNavPrefs()
  try {
    const raw = window.localStorage.getItem(TASK_NAV_PREFS_KEY)
    if (!raw) return defaultTaskNavPrefs()
    return normalizeTaskNavPrefs(JSON.parse(raw))
  } catch {
    return defaultTaskNavPrefs()
  }
}

export function writeTaskNavPrefs(next: TaskNavPrefs, dispatch = true): TaskNavPrefs {
  const normalized = normalizeTaskNavPrefs(next)
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(TASK_NAV_PREFS_KEY, JSON.stringify(normalized))
    } catch {
      // Ignore storage quota/privacy mode failures
    }
    if (dispatch) {
      window.dispatchEvent(new CustomEvent(TASK_NAV_PREFS_EVENT, { detail: normalized }))
    }
  }
  return normalized
}

export function isTaskNavTypeVisible(prefs: TaskNavPrefs, id: TaskNavTypeId): boolean {
  if (prefs.mode === "none") return false
  if (prefs.mode === "all") return true
  return prefs.visible[id] !== false
}

export function setTaskNavMode(prefs: TaskNavPrefs, mode: TaskNavDisplayMode): TaskNavPrefs {
  if (mode === "all") {
    return writeTaskNavPrefs({
      ...prefs,
      mode: "all",
      visible: {
        standard: true,
        shopping_item: true,
        checklist: true,
        calendar_event: true,
      },
    })
  }
  if (mode === "none") {
    return writeTaskNavPrefs({
      ...prefs,
      mode: "none",
      visible: {
        standard: false,
        shopping_item: false,
        checklist: false,
        calendar_event: false,
      },
    })
  }
  return writeTaskNavPrefs({ ...prefs, mode: "custom" })
}

export function toggleTaskNavChild(prefs: TaskNavPrefs, id: TaskNavTypeId): TaskNavPrefs {
  const current = isTaskNavTypeVisible(prefs, id)
  const visible: Record<TaskNavTypeId, boolean> = {
    standard: isTaskNavTypeVisible(prefs, "standard"),
    shopping_item: isTaskNavTypeVisible(prefs, "shopping_item"),
    checklist: isTaskNavTypeVisible(prefs, "checklist"),
    calendar_event: isTaskNavTypeVisible(prefs, "calendar_event"),
    [id]: !current,
  }
  const allOn = TASK_NAV_TYPES.every((item) => visible[item.id])
  const allOff = TASK_NAV_TYPES.every((item) => !visible[item.id])
  const mode: TaskNavDisplayMode = allOn ? "all" : allOff ? "none" : "custom"
  return writeTaskNavPrefs({
    ...prefs,
    mode,
    visible,
  })
}

export function toggleTaskNavPin(prefs: TaskNavPrefs, id: TaskNavTypeId, force?: boolean): TaskNavPrefs {
  const isPinned = prefs.pinned.includes(id)
  const shouldPin = typeof force === "boolean" ? force : !isPinned
  const pinned = shouldPin
    ? isPinned
      ? prefs.pinned
      : [...prefs.pinned, id]
    : prefs.pinned.filter((entry) => entry !== id)
  return writeTaskNavPrefs({ ...prefs, pinned })
}

export function toggleTaskViewPin(prefs: TaskNavPrefs, view: TaskView): TaskNavPrefs {
  const pinnedViews = prefs.pinnedViews.includes(view)
    ? prefs.pinnedViews.filter(entry => entry !== view)
    : [...prefs.pinnedViews, view]
  return writeTaskNavPrefs({ ...prefs, pinnedViews })
}

export function getTaskNavTypeById(id: string): TaskNavTypeEntry | undefined {
  return TASK_NAV_TYPES.find((item) => item.id === id)
}
