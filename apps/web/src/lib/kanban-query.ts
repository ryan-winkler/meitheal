import type { FilterCondition, FilterGroup } from "./filter-engine"
import { readFilterLabels, writeFilterLabels, type FilterState } from "./filter-state"

export const KANBAN_PAGE_SIZE = 25
const PAGE_PREFIX = "kp."
export const KANBAN_GROUP_KEY = "meitheal-kanban-group-by"
export type KanbanFilters = Partial<FilterState> & { promoted?: boolean }

export function storedKanbanGroup(): string {
  try { return localStorage.getItem(KANBAN_GROUP_KEY) ?? "none" } catch { return "none" }
}
const fields = new Set(["title", "status", "priority", "rice", "type", "assigned", "labels", "area"])
const operators = new Set(["equals", "notEquals", "contains", "notContains", "greaterThan", "lessThan", "isEmpty", "isNotEmpty"])

function readRules(raw: string | null): FilterGroup | undefined {
  if (!raw || raw.length > 8000) return
  try {
    const rules = JSON.parse(raw.startsWith("%") ? decodeURIComponent(raw) : raw) as { conditions?: unknown }
    if (!Array.isArray(rules.conditions) || rules.conditions.length > 40) return
    const conditions: FilterCondition[] = []
    for (const item of rules.conditions) {
      if (!item || !fields.has(item.field) || !operators.has(item.operator) || typeof item.value !== "string") return
      conditions.push({
        id: String(conditions.length),
        field: item.field,
        operator: item.operator,
        value: item.value,
        logic: item.logic === "OR" ? "OR" : "AND",
      })
    }
    return { id: "root", logic: "AND", conditions }
  } catch { /* ignore malformed URL input */ }
}

export function readKanbanFilters(params: URLSearchParams): KanbanFilters {
  return {
    area: params.get("area") ?? "",
    search: (params.get("search") ?? "").trim().slice(0, 500),
    user: params.get("user") ?? "",
    status: params.get("status") ?? "",
    priority: params.get("priority") ?? "",
    promoted: params.get("promoted") === "1",
    rice: params.get("rice") ?? "",
    groupBy: params.get("groupBy") ?? "none",
    types: (params.get("types") ?? "")
      .split(",")
      .filter(Boolean)
      .map(type => (type === "standard" ? "standard_action" : type))
      .slice(0, 50),
    labels: readFilterLabels(params),
    advancedFilter: readRules(params.get("advancedFilter")) ?? null,
  }
}

export function updateKanbanFilters(url: URL, filters: KanbanFilters): void {
  for (const key of ["area", "search", "user", "status", "priority", "rice", "groupBy"] as const) {
    const value = filters[key]
    if (value && (key !== "groupBy" || value !== "none")) url.searchParams.set(key, value)
    else if (key === "area") url.searchParams.set(key, "")
    else url.searchParams.delete(key)
  }
  if (filters.types?.length) url.searchParams.set("types", filters.types.join(","))
  else url.searchParams.delete("types")
  writeFilterLabels(url.searchParams, filters.labels ?? [])
  if (filters.promoted) url.searchParams.set("promoted", "1")
  else url.searchParams.delete("promoted")
  if (filters.advancedFilter?.conditions.length) url.searchParams.set("advancedFilter", encodeURIComponent(JSON.stringify(filters.advancedFilter)))
  else url.searchParams.delete("advancedFilter")
  for (const key of Array.from(url.searchParams.keys())) {
    if (key.startsWith(PAGE_PREFIX)) url.searchParams.delete(key)
  }
}

export function readKanbanPage(params: URLSearchParams, key: string): number {
  const page = Number(params.get(PAGE_PREFIX + key))
  return Number.isSafeInteger(page) && page >= 1 ? page : 1
}

export function setKanbanPage(url: URL, key: string, page: number): void {
  if (page > 1) url.searchParams.set(PAGE_PREFIX + key, String(page))
  else url.searchParams.delete(PAGE_PREFIX + key)
}
