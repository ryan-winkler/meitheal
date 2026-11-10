import { AreaRepository } from "@domains/tasks/persistence/area-repository"
import { SettingsRepository } from "@domains/tasks/persistence/settings-repository"
import { TaskRepository, type TaskRow } from "@domains/tasks/persistence/task-repository"
import { getPersistenceClient } from "@domains/tasks/persistence/store"
import {
  SETTINGS_SECTIONS,
  searchSettingsRegistry,
} from "@lib/settings-registry"
import type {
  SearchQueryOptions,
  SearchResponse,
  SearchResultItem,
  SearchResultSection,
  TaskSearchField,
} from "./search-types"

function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((value) => String(value))
  }

  if (typeof raw !== "string" || raw.trim().length === 0) {
    return []
  }

  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.map((value) => String(value))
    }
  } catch {
    // Fall through to a simple split for malformed legacy values.
  }

  return raw.split(",").map((value) => value.trim()).filter(Boolean)
}

function stringifyCustomFields(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return ""
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Object.entries(parsed)
      .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" • ")
  } catch {
    return raw
  }
}

function createSnippet(source: string, query: string): string | undefined {
  const text = source.trim()
  if (!text) return undefined
  if (!query) return text.slice(0, 120)

  const index = text.toLowerCase().indexOf(query.toLowerCase())
  if (index === -1) return text.slice(0, 120)

  const start = Math.max(0, index - 32)
  const end = Math.min(text.length, index + query.length + 64)
  const prefix = start > 0 ? "..." : ""
  const suffix = end < text.length ? "..." : ""
  return `${prefix}${text.slice(start, end)}${suffix}`
}

function hasMatch(value: string, query: string): boolean {
  return Boolean(query) && value.toLowerCase().includes(query.toLowerCase())
}

function buildTaskSearchItem(row: TaskRow, query: string, taskFields: TaskSearchField[]): SearchResultItem {
  const taskId = String(row.id ?? "")
  const title = String(row.title ?? "Untitled task")
  const ticketNumber = row.ticket_number == null ? null : Number(row.ticket_number)
  const ticketKey = ticketNumber ? `MTH-${ticketNumber}` : taskId.slice(0, 8)
  const status = String(row.status ?? "pending")
  const priority = Number(row.priority ?? 3)
  const labels = parseStringArray(row.labels).join(" • ")
  const customFields = stringifyCustomFields(row.custom_fields)
  const comments = String(row.comment_blob ?? "")
  const description = String(row.description ?? "")

  const matchedFields: string[] = []
  if (query) {
    const idHaystack = `${taskId} ${ticketKey} ${ticketNumber ?? ""}`
    if (taskFields.includes("id") && hasMatch(idHaystack, query)) matchedFields.push("ID")
    if (taskFields.includes("title") && hasMatch(title, query)) matchedFields.push("Title")
    if (taskFields.includes("description") && hasMatch(description, query)) matchedFields.push("Description")
    if (taskFields.includes("labels") && hasMatch(labels, query)) matchedFields.push("Labels")
    if (taskFields.includes("custom_fields") && hasMatch(customFields, query)) matchedFields.push("Custom fields")
    if (taskFields.includes("comments") && hasMatch(comments, query)) matchedFields.push("Comments")
  }

  let score = 0
  if (query) {
    const queryLower = query.toLowerCase()
    if (`${ticketKey}`.toLowerCase() === queryLower || taskId.toLowerCase() === queryLower) score += 120
    if (title.toLowerCase() === queryLower) score += 110
    if (title.toLowerCase().startsWith(queryLower)) score += 90
    if (title.toLowerCase().includes(queryLower)) score += 60
    if (description.toLowerCase().includes(queryLower)) score += 25
    if (labels.toLowerCase().includes(queryLower)) score += 18
    if (customFields.toLowerCase().includes(queryLower)) score += 15
    if (comments.toLowerCase().includes(queryLower)) score += 12
  }
  if (status !== "complete" && status !== "archived") score += 6

  const snippet =
    createSnippet(description, query) ??
    createSnippet(comments, query) ??
    createSnippet(customFields, query) ??
    createSnippet(labels, query)

  const item: SearchResultItem = {
    id: taskId,
    kind: "task",
    taskId,
    title,
    subtitle: `${ticketKey} · ${status} · P${priority}`,
    meta: {
      matched_fields: matchedFields,
      score,
      status,
      priority,
      deferred: row.deferred_at != null,
    },
  }

  if (snippet) {
    item.description = snippet
  }

  return item
}

function buildSavedFilterHref(raw: unknown): string {
  const params = new URLSearchParams()

  let parsed: Record<string, unknown> = {}
  if (typeof raw === "string" && raw.trim()) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      parsed = {}
    }
  }

  const mappings: Array<[string, string]> = [
    ["status", "status"],
    ["priority", "priority"],
    ["search", "search"],
    ["rice", "rice"],
    ["sort", "sort"],
    ["groupBy", "groupBy"],
    ["subGroupBy", "subGroupBy"],
  ]

  for (const [source, target] of mappings) {
    const value = parsed[source]
    if (value == null) continue
    params.set(target, String(value))
  }

  if (parsed.area_id) params.set("area", String(parsed.area_id))
  if (parsed.task_type) params.set("types", String(parsed.task_type))
  if (Array.isArray(parsed.labels) && parsed.labels.length > 0) {
    params.set("labels", parsed.labels.map((value) => String(value)).join(","))
  }

  const suffix = params.toString()
  return `/table${suffix ? `?${suffix}` : ""}`
}

function filterByQuery<T extends SearchResultItem>(items: T[], query: string): T[] {
  if (!query) return items
  const needle = query.toLowerCase()
  return items.filter((item) =>
    [item.title, item.subtitle, item.description]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(needle),
  )
}

export async function searchMeithealCatalog(options: SearchQueryOptions): Promise<SearchResponse> {
  const client = getPersistenceClient()
  const taskRepo = new TaskRepository(client)
  const areaRepo = new AreaRepository(client)
  const settingsRepo = new SettingsRepository(client)

  const sections: SearchResultSection[] = []

  if (options.scope === "all" || options.scope === "tasks") {
    const searchOptions: Parameters<typeof taskRepo.searchCatalog>[0] = {
      query: options.query,
      includeCompleted: options.includeCompleted,
      includeArchived: options.includeArchived,
      fields: options.taskFields,
      sort: options.sort,
      limit: options.limit,
    }
    if (options.status) searchOptions.status = options.status
    if (options.priority != null) searchOptions.priority = options.priority
    if (options.assignedTo) searchOptions.assignedTo = options.assignedTo

    const rows = await taskRepo.searchCatalog(searchOptions)

    const taskItems = rows
      .map((row) => buildTaskSearchItem(row, options.query, options.taskFields))
      .sort((left, right) => {
        if (options.sort === "updated") {
          return 0
        }
        return Number(right.meta?.score ?? 0) - Number(left.meta?.score ?? 0)
      })
      .slice(0, options.limit)

    if (taskItems.length > 0) {
      sections.push({
        id: "tasks",
        label: options.query ? "Tasks" : "Recent tasks",
        items: taskItems,
      })
    }
  }

  if (options.scope === "all" || options.scope === "views") {
    const areas = await areaRepo.findAll()
    const areaItems = filterByQuery(
      areas.map((area) => ({
        id: String(area.id),
        kind: "area" as const,
        title: String(area.name ?? "Untitled area"),
        subtitle: "Open in Kanban",
        href: `/tasks?area=${encodeURIComponent(String(area.id))}`,
        icon: typeof area.icon === "string" ? area.icon : "📋",
        color: typeof area.color === "string" ? area.color : null,
      })),
      options.query,
    ).slice(0, Math.min(6, options.limit))

    if (areaItems.length > 0) {
      sections.push({
        id: "areas",
        label: "Areas",
        items: areaItems,
      })
    }

    const filters = await settingsRepo.listFilters()
    const savedFilterItems = filterByQuery(
      filters.map((row) => ({
        id: String((row as Record<string, unknown>).id ?? ""),
        kind: "saved_filter" as const,
        title: String((row as Record<string, unknown>).name ?? "Saved filter"),
        subtitle: "Open smart view",
        description: String((row as Record<string, unknown>).icon ?? "🔍"),
        href: buildSavedFilterHref((row as Record<string, unknown>).query_json),
        icon: typeof (row as Record<string, unknown>).icon === "string"
          ? String((row as Record<string, unknown>).icon)
          : "🔍",
      })),
      options.query,
    ).slice(0, Math.min(6, options.limit))

    if (savedFilterItems.length > 0) {
      sections.push({
        id: "saved_filters",
        label: "Saved filters",
        items: savedFilterItems,
      })
    }
  }

  if (options.scope === "all" || options.scope === "settings") {
    const settingsItems = (options.query
      ? searchSettingsRegistry(options.query)
      : SETTINGS_SECTIONS.slice(0, 4).map((section) => ({
          id: section.id,
          label: section.label,
          description: section.description,
          anchorId: section.id,
          sectionId: section.id,
          type: "section" as const,
        })))
      .map((item) => ({
        id: item.id,
        kind: "setting" as const,
        title: item.label,
        subtitle: item.type === "field" ? "Settings field" : "Settings section",
        description: item.description,
        href: `/settings#${encodeURIComponent(item.anchorId)}`,
        meta: {
          section_id: item.sectionId,
          anchor_id: item.anchorId,
        },
      }))
      .slice(0, options.limit)

    if (settingsItems.length > 0) {
      sections.push({
        id: "settings",
        label: "Settings",
        items: settingsItems,
      })
    }
  }

  return {
    query: options.query,
    sections,
    meta: {
      scope: options.scope,
      limit: options.limit,
      include_completed: options.includeCompleted,
      include_archived: options.includeArchived,
      sort: options.sort,
      task_fields: options.taskFields,
    },
  }
}
