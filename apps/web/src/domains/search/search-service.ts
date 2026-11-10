import { AreaRepository } from "@domains/tasks/persistence/area-repository"
import { SettingsRepository } from "@domains/tasks/persistence/settings-repository"
import { TaskRepository, type TaskCatalogRow } from "@domains/tasks/persistence/task-repository"
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
} from "./search-types"

function buildTaskSearchItem(row: TaskCatalogRow): SearchResultItem {
  const taskId = String(row.id ?? "")
  const ticketKey = row.ticket_number ? `MTH-${row.ticket_number}` : taskId.slice(0, 8)
  const status = String(row.status ?? "pending")
  const priority = Number(row.priority ?? 3)
  const matchedFields: string[] = []
  if (row.id_hit || row.exact_id) matchedFields.push("ID")
  if (row.title_at) matchedFields.push("Title")
  if (row.description_hit) matchedFields.push("Description")
  if (row.labels_hit) matchedFields.push("Labels")
  if (row.custom_fields_hit) matchedFields.push("Custom fields")
  if (row.comments_hit) matchedFields.push("Comments")

  return {
    id: taskId,
    kind: "task",
    taskId,
    title: String(row.title ?? "Untitled task"),
    subtitle: `${ticketKey} · ${status} · P${priority}`,
    ...(row.excerpt ? { description: row.excerpt } : {}),
    meta: {
      matched_fields: matchedFields,
      score: row.score,
      status,
      priority,
      deferred: row.deferred_at != null,
    },
  }
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

    const taskItems = rows.map(buildTaskSearchItem)

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
