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

import { evaluateFilterGroup } from "./filter-engine"

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
  /** Primary group-by dimension */
  groupBy: string
  /** Secondary group-by (nested grouping within primary groups) */
  subGroupBy: string
  /** Active label filters — multi-select (empty = all labels visible) */
  labels: string[]
  /** Advanced compound AND/OR filter conditions */
  advancedFilter?: import("./filter-engine").FilterGroup | null
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
  el: HTMLElement,
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
  el: HTMLElement,
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
  el: HTMLElement,
  state: Partial<FilterState>,
): boolean {
  // Advanced Filter (early exit if it fails)
  if (state.advancedFilter) {
    // Extract data from the element just like the filter engine expects
    const data = { ...el.dataset }
    if (data.labels) {
      try {
        const parsed = JSON.parse(data.labels)
        data.labels = JSON.stringify(parsed.map((l: any) => typeof l === 'string' ? l : l.name || ''))
      } catch {
        data.labels = "[]"
      }
    } else {
      data.labels = "[]"
    }
    data.type = data.taskType || data.task_type || "task"

    if (!evaluateFilterGroup(state.advancedFilter, data)) {
      return false
    }
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
export function getGroupKey(el: HTMLElement, groupBy: string): string {
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
