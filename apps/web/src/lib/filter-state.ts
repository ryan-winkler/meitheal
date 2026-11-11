/**
 * Shared Filter State — Client-side filter persistence utilities
 *
 * Centralizes filter state saving/loading across tasks, table, kanban,
 * and any future view pages. URL params take priority over localStorage
 * for deep-linking support.
 *
 * Extended for list view overhaul: adds board, types, groupBy, subGroupBy,
 * labels dimensions + unified visibility helper.
 *
 * Bounded Context: Tasks (view-layer utility)
 */

import { VALID_TASK_KINDS, VALID_TASK_TYPES } from "@meitheal/domain-tasks"

import { evaluateFilterGroup, extractDataFromElement, type FilterGroup, type FilterOperator } from "./filter-engine"
import { normalizeStatus } from "./status-config"
import { TABLE_COLUMNS } from "./table-registry"

// =============================================================================
// Types
// =============================================================================

export interface FilterState {
  search: string
  status: string
  priority: string
  rice: string
  sort: string
  user: string
  /** Area filter — show only tasks from this board (empty = all) */
  area: string
  /** Active type filters — multi-select (empty = all types visible) */
  types: string[]
  task_type?: string
  /** Primary group-by dimension */
  groupBy: string
  /** Secondary group-by (nested grouping within primary groups) */
  subGroupBy: string
  /** Table workflow columns, selected by their stable IDs. */
  laneIds?: string[]
  /** Active label filters — multi-select (empty = all labels visible) */
  labels: string[]
  /** Advanced compound AND/OR filter conditions */
  advancedFilter?: FilterGroup | null
  /** Visible column IDs in the table view */
  columns?: string[]
}

// =============================================================================
// Constants
// =============================================================================

/** Shared localStorage key — so switching between tasks/table preserves filters */
export const FILTER_STORAGE_KEY = "meitheal-task-view-filters"

/** Default sort order for task lists */
export const DEFAULT_SORT = "created_at-desc"

/** Valid status filter values including the computed 'overdue' pseudo-status */
export const STATUS_VALUES = ["pending", "active", "complete", "overdue"] as const

/** Valid group-by dimensions */
export const GROUP_BY_OPTIONS = [
  "none",
  "type",
  "priority",
  "area",
  "assignee",
  "status",
  "rice",
] as const

/** RICE score bands for grouping */
export const RICE_BANDS = {
  high: { label: "High", min: 15, max: Infinity },
  medium: { label: "Medium", min: 8, max: 14 },
  low: { label: "Low", min: 0, max: 7 },
  none: { label: "Not Scored", min: -Infinity, max: -Infinity },
} as const

// =============================================================================
// Array/Type Field Serialization
// =============================================================================

/** Serialize array values to comma-separated URL param strings */
function serializeArray(arr: string[]): string {
  return arr.length > 0 ? arr.join(",") : ""
}

/** Deserialize comma-separated URL param strings to arrays */
function deserializeArray(val: string | null | undefined): string[] {
  if (!val) return []
  return val.split(",").filter(Boolean)
}

/** Deserialize URL param string back to an object */
function parseJsonParam(val: string | null | undefined): any | null {
  if (!val) return null
  try {
    return JSON.parse(decodeURIComponent(val))
  } catch {
    return null
  }
}

// =============================================================================
// Persistence
// =============================================================================

/** All persisted filter keys (scalar + array) */
const SCALAR_KEYS = ["search", "status", "priority", "rice", "sort", "user", "area", "groupBy", "subGroupBy"] as const
const ARRAY_KEYS = ["types", "labels"] as const
const JSON_KEYS = ["advancedFilter", "columns"] as const
const ALL_KEYS = [...SCALAR_KEYS, ...ARRAY_KEYS, ...JSON_KEYS] as const

const TABLE_KEYS = [...ALL_KEYS, "task_type", "label", "area_id", "board", "lane"] as const
const SORT_COLUMNS = ["key", "title", "type", "status", "priority", "due_date", "rice"]
const LEGACY_SORTS = new Map([
  ["due_asc", "due_date-asc"],
  ["due_desc", "due_date-desc"],
  ["priority_desc", "priority-asc"],
  ["rice_desc", "rice-desc"],
])
const RULE_FIELDS = new Set(["title", "status", "priority", "rice", "type", "assigned", "labels", "area"])
const RULE_OPERATORS = new Set([
  "equals", "notEquals", "contains", "notContains", "greaterThan", "lessThan", "between", "isEmpty", "isNotEmpty",
])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function decodeFilterJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  if (!value || value.length > 8000) return undefined
  try {
    return JSON.parse(value)
  } catch {
    try {
      return JSON.parse(decodeURIComponent(value))
    } catch {
      return undefined
    }
  }
}

export const FILTER_LIST_LIMIT = 50

function stringList(value: unknown): string[] {
  const decoded = typeof value === "string" && value.startsWith("[") ? decodeFilterJson(value) : value
  const list = Array.isArray(decoded) ? decoded : typeof value === "string" ? value.split(",") : []
  return [...new Set(list.filter((item): item is string =>
    typeof item === "string" && item.length > 0 && item.length <= 500,
  ))].slice(0, FILTER_LIST_LIMIT)
}

export function readFilterLabels(params: URLSearchParams): string[] {
  return stringList(params.has("label") ? params.getAll("label") : params.get("labels"))
}

export function writeFilterLabels(params: URLSearchParams, labels: readonly string[]): void {
  params.delete("label")
  params.delete("labels")
  if (!labels.length) return
  if (labels.some(label => /[,\[\]]/.test(label))) {
    for (const label of labels) params.append("label", label)
  } else {
    params.set("labels", labels.join(","))
  }
}

function ruleValue(value: unknown): value is string | number | boolean {
  return typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= 500)
}

function normalizeTableRules(raw: unknown): FilterGroup | undefined {
  const root = decodeFilterJson(raw)
  let count = 0
  function group(node: unknown, depth: number): FilterGroup | undefined {
    if (++count > 40 || depth > 4 || !isPlainRecord(node) || !Array.isArray(node.conditions)) return
    const conditions: FilterGroup["conditions"] = []
    const logic = node.logic === "OR" ? "OR" : "AND"
    for (const item of node.conditions) {
      if (!isPlainRecord(item)) return
      if ("conditions" in item) {
        const nested = group(item, depth + 1)
        if (!nested) return
        conditions.push(nested)
        continue
      }
      if (++count > 40 || typeof item.field !== "string" || !RULE_FIELDS.has(item.field) ||
          typeof item.operator !== "string" || !RULE_OPERATORS.has(item.operator)) return
      const { field, operator, value } = item
      const validValue = operator === "between"
        ? Array.isArray(value) && value.length === 2 && value.every(ruleValue)
        : ruleValue(value) || ((operator === "isEmpty" || operator === "isNotEmpty") && value == null)
      if (!validValue) return
      conditions.push({
        id: typeof item.id === "string" && item.id.length <= 100 ? item.id : String(count),
        field,
        operator: operator as FilterOperator,
        value: field === "status" && typeof value === "string" && (operator === "equals" || operator === "notEquals")
          ? normalizeStatus(value)
          : value ?? "",
        ...(item.logic === "OR" || item.logic === "AND" ? { logic: item.logic } : {}),
      })
    }
    return {
      id: typeof node.id === "string" && node.id.length <= 100 ? node.id : depth === 1 ? "root" : String(count),
      logic,
      conditions,
    }
  }

  const rules = group(root, 1)
  return rules?.conditions.length && encodeURIComponent(JSON.stringify(rules)).length <= 8000 ? rules : undefined
}

export function normalizeTableColumns(value: unknown): string[] | undefined {
  const decoded = decodeFilterJson(value)
  if (!Array.isArray(decoded)) return
  return TABLE_COLUMNS.filter(column => column.id === "title" || decoded.includes(column.id)).map(column => column.id)
}

function tableGroup(value: unknown): string | undefined {
  const group = value === "board" ? "area" : value
  return GROUP_BY_OPTIONS.find(option => option !== "none" && option === group)
}

function normalizeTableValues(input: Record<string, unknown>): Partial<FilterState> {
  const result: Partial<FilterState> = {}
  for (const key of ["search", "status", "priority", "rice", "user"] as const) {
    const value = input[key]
    if (typeof value === "string" && value && value.length <= 500) {
      result[key] = key === "status" ? normalizeStatus(value) : value
    }
    else if ((key === "search" || key === "priority") && typeof value === "number" && Number.isFinite(value)) {
      result[key] = String(value)
    } else if (key === "search" && typeof value === "boolean") result.search = String(value)
  }

  const area = [input.area, input.area_id, input.board].find(value => typeof value === "string" && value.length <= 500)
  if (typeof area === "string") result.area = area
  if (Array.isArray(input.laneIds)) {
    const laneIds = stringList(input.laneIds)
    if (laneIds.length) result.laneIds = laneIds
  }
  const kindValues = stringList(input.types)
  const types = kindValues.filter(kind => VALID_TASK_KINDS.some(valid => valid === kind))
  if (types.length) result.types = types
  const labels = stringList(input.labels)
  if (labels.length) result.labels = labels
  if (typeof input.task_type === "string" && VALID_TASK_TYPES.some(type => type === input.task_type)) {
    result.task_type = input.task_type
  }
  const groupBy = tableGroup(input.groupBy)
  const subGroupBy = tableGroup(input.subGroupBy)
  if (groupBy) result.groupBy = groupBy
  if (groupBy && subGroupBy && subGroupBy !== groupBy) result.subGroupBy = subGroupBy

  if (typeof input.sort === "string") {
    const sort = LEGACY_SORTS.get(input.sort) ?? input.sort
    const [column, direction, extra] = sort.split("-")
    if (extra === undefined && SORT_COLUMNS.includes(column ?? "") && (direction === "asc" || direction === "desc")) {
      result.sort = sort
    }
  }

  const rules = normalizeTableRules(input.advancedFilter)
  if (rules) result.advancedFilter = rules
  const columns = normalizeTableColumns(input.columns)
  if (columns) result.columns = columns
  return result
}

export function normalizeSavedFilter(raw: unknown): Partial<FilterState> | null {
  let input = raw
  if (typeof raw === "string") {
    try {
      input = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!isPlainRecord(input)) return null
  const state = normalizeTableValues(input)
  if (input.advancedFilter && !state.advancedFilter) {
    const group = decodeFilterJson(input.advancedFilter)
    if (!isPlainRecord(group) || !Array.isArray(group.conditions) || group.conditions.length > 0) return null
  }
  return { ...state, area: state.area ?? "" }
}

export function readTableFilterParams(params: URLSearchParams): Partial<FilterState> {
  const area = params.get("area_id") ?? params.get("area") ?? params.get("board") ?? undefined
  return normalizeTableValues({
    ...Object.fromEntries(params),
    area,
    area_id: undefined,
    board: undefined,
    labels: readFilterLabels(params),
    laneIds: params.getAll("lane"),
  })
}

export function writeTableFilterParams(params: URLSearchParams, state: Partial<FilterState>): void {
  const normalized = normalizeTableValues({ ...state })
  for (const key of TABLE_KEYS) params.delete(key)
  for (const key of [...SCALAR_KEYS, "task_type"] as const) {
    const value = normalized[key]
    if (value !== undefined) params.set(key, value)
  }
  if (normalized.types?.length) params.set("types", normalized.types.join(","))
  writeFilterLabels(params, normalized.labels ?? [])
  for (const id of normalized.laneIds ?? []) params.append("lane", id)
  for (const key of JSON_KEYS) {
    if (normalized[key]) params.set(key, JSON.stringify(normalized[key]))
  }
}

export function loadTableFilterState(): Partial<FilterState> {
  const params = new URLSearchParams(window.location.search)
  if (TABLE_KEYS.some(key => params.has(key))) return readTableFilterParams(params)
  const state = normalizeTableValues({ ...loadFilterState() })
  delete state.area
  delete state.laneIds
  return state
}

export function saveTableFilterState(state: Partial<FilterState>, page?: number): void {
  try {
    const { laneIds: _laneIds, ...sharedState } = state
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(sharedState))
  } catch { /* storage unavailable */ }
  const url = new URL(window.location.href)
  writeTableFilterParams(url.searchParams, state)
  if (page !== undefined) {
    if (page > 1) url.searchParams.set("tp", String(page))
    else url.searchParams.delete("tp")
  }
  window.history.replaceState(window.history.state, "", url)
}

/**
 * Save filter state to both localStorage and URL search params.
 * Keeps the URL in sync for deep-linking / share support.
 */
export function saveFilterState(state: Partial<FilterState>): void {
  localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(state))

  const url = new URL(window.location.href)
  for (const key of SCALAR_KEYS) {
    const val = state[key]
    if (typeof val === "string" && val && val !== DEFAULT_SORT) {
      url.searchParams.set(key, val)
    } else {
      url.searchParams.delete(key)
    }
  }
  for (const key of ARRAY_KEYS) {
    const arr = state[key]
    if (Array.isArray(arr) && arr.length > 0) {
      url.searchParams.set(key, serializeArray(arr))
    } else {
      url.searchParams.delete(key)
    }
  }
  for (const key of JSON_KEYS) {
    const obj = state[key]
    if (obj) {
      url.searchParams.set(key, encodeURIComponent(JSON.stringify(obj)))
    } else {
      url.searchParams.delete(key)
    }
  }
  window.history.replaceState(null, "", url.toString())
}

/**
 * Load filter state from URL search params (priority) or localStorage.
 * Returns a partial state — callers apply only the fields they support.
 */
export function loadFilterState(): Partial<FilterState> {
  const urlParams = new URLSearchParams(window.location.search)
  const hasUrlFilters = ALL_KEYS.some((k) => urlParams.has(k))

  if (hasUrlFilters) {
    return {
      search: urlParams.get("search") ?? "",
      status: urlParams.get("status") ?? "",
      priority: urlParams.get("priority") ?? "",
      rice: urlParams.get("rice") ?? "",
      sort: urlParams.get("sort") ?? DEFAULT_SORT,
      user: urlParams.get("user") ?? "",
      area: urlParams.get("area") ?? "",
      types: deserializeArray(urlParams.get("types")),
      groupBy: urlParams.get("groupBy") ?? "none",
      subGroupBy: urlParams.get("subGroupBy") ?? "none",
      labels: deserializeArray(urlParams.get("labels")),
      advancedFilter: parseJsonParam(urlParams.get("advancedFilter")),
    }
  }

  try {
    const stored = JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) ?? "{}")
    // Ensure array fields are arrays after parse
    if (stored.types && !Array.isArray(stored.types)) stored.types = []
    if (stored.labels && !Array.isArray(stored.labels)) stored.labels = []
    return stored
  } catch {
    return {}
  }
}

/**
 * Clear all filter state from localStorage and URL params.
 */
export function clearFilterState(): void {
  localStorage.removeItem(FILTER_STORAGE_KEY)
  const url = new URL(window.location.href)
  for (const key of ALL_KEYS) {
    url.searchParams.delete(key)
  }
  window.history.replaceState(null, "", url.toString())
}

// =============================================================================
// Status Matching
// =============================================================================

/**
 * Check if a task element matches the current status filter.
 * Handles the 'overdue' pseudo-status by checking data-overdue attribute.
 */
export function matchesStatusFilter(
  el: Pick<HTMLElement, "dataset">,
  statusFilter: string,
): boolean {
  if (!statusFilter) return true
  if (statusFilter === "overdue") {
    return el.dataset.overdue === "true"
  }
  return el.dataset.status === statusFilter
}

/**
 * Check if a task element matches the current RICE filter.
 */
export function matchesRiceFilter(
  el: Pick<HTMLElement, "dataset">,
  riceFilter: string,
): boolean {
  if (!riceFilter) return true
  const riceVal = el.dataset.rice
  if (!riceVal) return false
  const r = Number(riceVal)
  if (riceFilter === "high") return r >= 15
  if (riceFilter === "medium") return r >= 8 && r < 15
  if (riceFilter === "low") return r < 8
  return false
}

// =============================================================================
// Unified Visibility Helper
// =============================================================================

/**
 * Determine if a task row/card element is visible given the current filter state.
 * Checks ALL filter dimensions. Used by both table and kanban controllers
 * to apply consistent filtering.
 *
 * Expects the element to have data attributes:
 * - data-search (lowercased searchable text)
 * - data-status
 * - data-priority
 * - data-rice
 * - data-assigned
 * - data-board
 * - data-task-type
 * - data-labels (JSON stringified array)
 * - data-overdue
 */
export function isTaskVisible(
  el: Pick<HTMLElement, "dataset">,
  state: Partial<FilterState>,
): boolean {
  if (state.advancedFilter && !evaluateFilterGroup(state.advancedFilter, extractDataFromElement(el))) {
    return false
  }

  // Search
  if (state.search) {
    const searchText = el.dataset.search ?? el.dataset.title ?? ""
    if (!searchText.includes(state.search.toLowerCase())) return false
  }

  // Status
  if (state.status) {
    if (!matchesStatusFilter(el, state.status)) return false
  }

  // Priority
  if (state.priority) {
    if (el.dataset.priority !== state.priority) return false
  }

  // RICE
  if (state.rice) {
    if (!matchesRiceFilter(el, state.rice)) return false
  }

  // User / Assignee
  if (state.user) {
    if (state.user === "__unassigned__") {
      if (el.dataset.assigned) return false
    } else {
      if (el.dataset.assigned !== state.user) return false
    }
  }

  // Area
  if (state.area) {
    if (el.dataset.area !== state.area) return false
  }

  if (state.task_type && (el.dataset.taskType ?? el.dataset.task_type ?? "task") !== state.task_type) return false

  // Type filter (multi-select — if types array has values, task must be one of them)
  if (state.types && state.types.length > 0) {
    const taskKind = el.dataset.taskKind ?? el.dataset.task_kind ?? "standard_action"
    if (!state.types.includes(taskKind)) return false
  }

  // Label filter (multi-select — task must have at least one matching label)
  if (state.labels && state.labels.length > 0) {
    try {
      const rowLabels = JSON.parse(el.dataset.labels ?? "[]") as (string | { name: string })[]
      const labelNames = rowLabels.map((l) =>
        (typeof l === "string" ? l : l.name ?? "").toLowerCase()
      )
      const hasMatch = state.labels.some((f) =>
        labelNames.includes(f.toLowerCase())
      )
      if (!hasMatch) return false
    } catch {
      return false
    }
  }

  return true
}

// =============================================================================
// Group-By Helpers
// =============================================================================

/**
 * Get the group key for a task element based on the group-by dimension.
 * Returns a string key used to sort tasks into groups.
 */
export function getGroupKey(el: Pick<HTMLElement, "dataset">, groupBy: string): string {
  switch (groupBy) {
    case "type":
      return el.dataset.taskType ?? el.dataset.task_type ?? "task"
    case "priority":
      return el.dataset.priority ?? "3"
    case "area":
      return el.dataset.area ?? "default"
    case "assignee":
      return el.dataset.assigned || "__unassigned__"
    case "status":
      return el.dataset.status ?? "pending"
    case "rice": {
      const r = Number(el.dataset.rice ?? "")
      if (isNaN(r) || el.dataset.rice === "") return "none"
      if (r >= 15) return "high"
      if (r >= 8) return "medium"
      return "low"
    }
    default:
      return "all"
  }
}

/**
 * Get display configuration for a group key based on the group-by dimension.
 */
export function getGroupDisplay(groupBy: string, key: string): { label: string, icon: string, color: string } {
  switch (groupBy) {
    case "type":
      return {
        epic: { label: "Epic", icon: "🎯", color: "var(--type-epic, #8b5cf6)" },
        story: { label: "Story", icon: "📖", color: "var(--type-story, #3b82f6)" },
        task: { label: "Task", icon: "✅", color: "var(--type-task, #6366F1)" },
      }[key] ?? { label: key, icon: "📋", color: "var(--text-muted, #6b7280)" }
    case "priority":
      return {
        "1": { label: "Critical", icon: "🔴", color: "var(--prio-critical, #ef4444)" },
        "2": { label: "High", icon: "🟠", color: "var(--prio-high, #f97316)" },
        "3": { label: "Medium", icon: "🟡", color: "var(--prio-medium, #eab308)" },
        "4": { label: "Low", icon: "🟢", color: "var(--prio-low, #22c55e)" },
        "5": { label: "Minimal", icon: "⚪", color: "var(--prio-none, #6b7280)" },
      }[key] ?? { label: `P${key}`, icon: "⬜", color: "var(--text-muted, #6b7280)" }
    case "status":
      return {
        backlog: { label: "Backlog", icon: "📥", color: "var(--text-muted, #6b7280)" },
        pending: { label: "Todo", icon: "📋", color: "var(--warning, #eab308)" },
        active: { label: "In Progress", icon: "⚡", color: "var(--info, #3b82f6)" },
        complete: { label: "Done", icon: "✅", color: "var(--success, #22c55e)" },
        cancelled: { label: "Cancelled", icon: "❌", color: "var(--danger, #ef4444)" },
      }[key] ?? { label: key, icon: "📋", color: "var(--text-muted, #6b7280)" }
    case "rice":
      return {
        high: { label: "RICE: High (≥15)", icon: "🔥", color: "#ef4444" },
        medium: { label: "RICE: Medium (8-14)", icon: "📊", color: "#f97316" },
        low: { label: "RICE: Low (<8)", icon: "📉", color: "#6b7280" },
        none: { label: "RICE: Not Scored", icon: "—", color: "#4b5563" },
      }[key] ?? { label: key, icon: "📊", color: "#6b7280" }
    case "assignee":
      if (key === "__unassigned__") return { label: "Unassigned", icon: "∅", color: "#6b7280" }
      return { label: key.replace(/^(ha_|custom_)/, ""), icon: "👤", color: "#6366F1" }
    case "area":
      if (key === "default") return { label: "Default Area", icon: "📋", color: "#6366F1" }
      return { label: key, icon: "📋", color: "#6366F1" }
    default:
      return { label: "All Tasks", icon: "📋", color: "#6b7280" }
  }
}
