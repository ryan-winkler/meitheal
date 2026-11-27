import { isOrganizationFeatureAvailable } from "../../lib/organization-request-context"
import {
  BoardAccessService,
  BoardRepository,
  scopePermits,
  type BoardScope,
  AreaRepository,
  getPersistenceClient,
  SettingsRepository,
  TaskRepository,
  TemplateRepository,
  type TaskCatalogRow
} from "@domains/tasks"
import type { OrganizationTerm } from "@lib/organization-labels"
import { normalizeSavedFilter, writeTableFilterParams } from "@lib/filter-state"
import { SETTINGS_SECTIONS, searchSettingsRegistry } from "@lib/settings-registry"
import type {
  SearchQueryOptions,
  SearchResponse,
  SearchResultItem,
  SearchResultSection
} from "./search-types"

const TASK_KIND_SEARCH_LABEL: Record<string, string> = {
  calendar_event: "Event",
  shopping_item: "Shopping list",
  routine_instance: "Routine",
  checklist: "Checklist",
  quick_capture: "Quick capture",
}

function buildTaskSearchItem(row: TaskCatalogRow, scope: BoardScope): SearchResultItem {
  const taskId = String(row.id ?? "")
  const ticketKey = row.ticket_ref ?? taskId.slice(0, 8)
  const status = String(row.status ?? "pending")
  const priority = Number(row.priority ?? 3)
  const taskKind = typeof row.task_kind === "string" && row.task_kind ? row.task_kind : "standard_action"
  const kindBadge = TASK_KIND_SEARCH_LABEL[taskKind]
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
    href: `/tasks?board_id=${encodeURIComponent(scope.boardId)}&task=${encodeURIComponent(taskId)}`,
    title: String(row.title ?? "Untitled task"),
    subtitle: kindBadge ? `${ticketKey} · ${kindBadge} · ${status} · P${priority}` : `${ticketKey} · ${status} · P${priority}`,
    ...(row.excerpt ? { description: row.excerpt } : {}),
    meta: {
      matched_fields: matchedFields,
      score: row.score,
      status,
      priority,
      task_kind: taskKind,
      deferred: row.deferred_at != null
    }
  }
}

function filterByQuery<T extends SearchResultItem>(items: T[], query: string): T[] {
  if (!query) return items
  const needle = query.toLowerCase()
  return items.filter((item) =>
    [item.title, item.subtitle, item.description]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(needle)
  )
}

export async function searchMeithealCatalog(
  options: SearchQueryOptions,
  scope: BoardScope,
  organization?: (term: OrganizationTerm, plural: boolean, fallback: string) => string
): Promise<SearchResponse> {
  const client = getPersistenceClient()
  const taskRepo = new TaskRepository(client, scope)
  // Search-only credentials use the existing title lookup, never the rich catalog
  // or planning/settings sources. Task read remains a separate capability.
  if (!scopePermits(scope, { resource: "task", action: "read" })) {
    const rows =
      options.scope === "all" || options.scope === "tasks"
        ? await taskRepo.searchTaskTitles({ query: options.query, limit: options.limit })
        : []
    return {
      query: options.query,
      sections: rows.length
        ? [
            {
              id: "tasks",
              label: "Tasks",
              items: rows.map((row) => ({
                id: row.id,
                kind: "task",
                taskId: row.id,
                title: row.title,
                href: `/tasks?board_id=${encodeURIComponent(scope.boardId)}&task=${encodeURIComponent(row.id)}`,
                ...(row.ticket_key ? { subtitle: row.ticket_key } : {})
              }))
            }
          ]
        : [],
      meta: {
        scope: "tasks",
        limit: options.limit,
        include_completed: false,
        include_archived: false,
        sort: "relevance",
        task_fields: ["id", "title"]
      }
    }
  }
  const areaRepo = new AreaRepository(client, scope)
  const settingsRepo = new SettingsRepository(client)

  const sections: SearchResultSection[] = []

  const canDirectory =
    scope.principal.kind === "ha_user" || scope.principal.kind === "local_operator"
  let accessibleBoardsPromise: Promise<Awaited<ReturnType<BoardRepository["findDirectory"]>>> | undefined
  const getAccessibleBoards = () => {
    if (!canDirectory) return Promise.resolve([])
    accessibleBoardsPromise ??= new BoardRepository(client).findDirectory(scope.principal)
    return accessibleBoardsPromise
  }

  if (options.scope === "all" || options.scope === "tasks") {
    const searchOptions: Parameters<typeof taskRepo.searchCatalog>[0] = {
      query: options.query,
      includeCompleted: options.includeCompleted,
      includeArchived: options.includeArchived,
      fields: options.taskFields,
      sort: options.sort,
      limit: options.limit
    }
    if (options.status) searchOptions.status = options.status
    if (options.priority != null) searchOptions.priority = options.priority
    if (options.assignedTo) searchOptions.assignedTo = options.assignedTo
    if (options.taskKind) searchOptions.taskKind = options.taskKind

    const rows = await taskRepo.searchCatalog(searchOptions)
    const taskItems = rows.map((row) => buildTaskSearchItem(row, scope))

    // When the query matches another accessible Board's key (e.g. "GRD" or "GRD-1"),
    // search that Board with its own verified BoardScope so ticket-key lookup works globally.
    if (options.query && canDirectory && taskItems.length < options.limit) {
      const normalizedQuery = options.query.trim().toUpperCase()
      const keyPrefix = /^([A-Z][A-Z0-9]{1,9})(?:-\d*)?$/.exec(normalizedQuery)?.[1]
      const accessibleBoards = keyPrefix ? await getAccessibleBoards() : []
      if (keyPrefix && accessibleBoards.length > 0) {
        const otherBoards = accessibleBoards.filter(
          (board) =>
            board.id !== scope.boardId &&
            (board.ticketPrefix.toUpperCase() === keyPrefix ||
              board.ticketPrefix.toUpperCase().startsWith(keyPrefix))
        )
        const accessService = new BoardAccessService(client)
        const seenTaskIds = new Set(taskItems.map((item) => item.id))
        for (const board of otherBoards.slice(0, 3)) {
          if (taskItems.length >= options.limit) break
          const resolved = await accessService.resolve(scope.principal, board.id, {
            resource: "task",
            action: "read"
          })
          if (!resolved.ok) continue
          const crossRepo = new TaskRepository(client, resolved.scope)
          const crossRows = await crossRepo.searchCatalog({
            ...searchOptions,
            limit: Math.max(1, options.limit - taskItems.length)
          })
          for (const row of crossRows) {
            const item = buildTaskSearchItem(row, resolved.scope)
            if (seenTaskIds.has(item.id)) continue
            seenTaskIds.add(item.id)
            item.subtitle = `${item.subtitle} · ${board.name}`
            taskItems.push(item)
          }
        }
      }
    }

    if (taskItems.length > 0) {
      sections.push({
        id: "tasks",
        label:
          organization?.("task", true, options.query ? "Tasks" : "Recent tasks") ??
          (options.query ? "Tasks" : "Recent tasks"),
        items: taskItems
      })
    }
  }

  if (options.scope === "all" || options.scope === "views") {
    const accessibleBoards = canDirectory ? await getAccessibleBoards() : []
    if (accessibleBoards.length > 0) {
      const needle = options.query.trim().toLowerCase()
      const boardItems: SearchResultItem[] = accessibleBoards
        .filter((board) => {
          if (!needle) return true
          return (
            board.name.toLowerCase().includes(needle) ||
            board.ticketPrefix.toLowerCase().includes(needle)
          )
        })
        .slice(0, Math.min(6, options.limit))
        .map((board) => ({
          id: `board-${board.id}`,
          kind: "board" as const,
          title: board.name,
          subtitle: `${board.ticketPrefix} · ${board.state === "archived" ? "Archived Board" : "Board"}`,
          href: `/boards/${encodeURIComponent(board.id)}`,
          meta: {
            board_id: board.id,
            ticket_prefix: board.ticketPrefix,
            matched_fields:
              needle && board.ticketPrefix.toLowerCase().includes(needle) ? ["Key"] : undefined
          }
        }))
      if (boardItems.length > 0) {
        sections.push({
          id: "boards",
          label: organization?.("board", true, "Boards") ?? "Boards",
          items: boardItems
        })
      }
    }
    const areas = isOrganizationFeatureAvailable("groups") ? await areaRepo.findAll() : []
    const areaItems = filterByQuery(
      areas.map((area) => ({
        id: String(area.id),
        kind: "area" as const,
        title: String(area.name ?? "Untitled area"),
        subtitle: "Open in Kanban",
        href: `/tasks?board_id=${encodeURIComponent(scope.boardId)}&area=${encodeURIComponent(String(area.id))}`,
        icon: typeof area.icon === "string" ? area.icon : "📋",
        color: typeof area.color === "string" ? area.color : null
      })),
      options.query
    ).slice(0, Math.min(6, options.limit))

    if (areaItems.length > 0) {
      sections.push({
        id: "areas",
        label: organization?.("group", true, "Areas") ?? "Areas",
        items: areaItems
      })
    }

    if (isOrganizationFeatureAvailable("routines") && scopePermits(scope, { resource: "routine", action: "read" })) {
      const routines = await new TemplateRepository(client, scope).findRoutines()
      const routineLabel = organization?.("routine", false, "Routine") ?? "Routine"
      const { describeRule } = await import("@domains/tasks/recurrence")
      const routineItems = filterByQuery(
        routines.map((routine) => ({
          id: `routine-${routine.id}`,
          kind: "routine" as const,
          title: routine.name,
          subtitle: `${describeRule(routine.cadence) || "Daily"} · ${routineLabel}`,
          href: `/progress?board_id=${encodeURIComponent(scope.boardId)}#routines`,
          icon: routine.icon || "repeat",
        })),
        options.query
      ).slice(0, Math.min(6, options.limit))
      if (routineItems.length > 0) {
        sections.push({
          id: "routines",
          label: organization?.("routine", true, "Routines") ?? "Routines",
          items: routineItems,
        })
      }
    }

    const filters = await settingsRepo.listFilters(scope)
    const savedFilterItems = filterByQuery(
      filters.flatMap((row) => {
        const state = normalizeSavedFilter(row.query_json)
        if (!state) return []
        const params = new URLSearchParams({ board_id: scope.boardId })
        writeTableFilterParams(params, state)
        const icon = typeof row.icon === "string" ? row.icon : "🔍"
        return [
          {
            id: String(row.id ?? ""),
            kind: "saved_filter" as const,
            title: String(row.name ?? "Saved filter"),
            subtitle: "Open smart view",
            description: icon,
            href: `/table?${params}`,
            icon
          }
        ]
      }),
      options.query
    ).slice(0, Math.min(6, options.limit))

    if (savedFilterItems.length > 0) {
      sections.push({
        id: "saved_filters",
        label: "Saved filters",
        items: savedFilterItems
      })
    }
  }

  if (options.scope === "all" || options.scope === "settings") {
    const defaultSections = options.scope === "settings" ? SETTINGS_SECTIONS : SETTINGS_SECTIONS.slice(0, 4)
    const settingsItems = (
      options.query
        ? searchSettingsRegistry(options.query)
        : defaultSections.map((section) => ({
            id: section.id,
            label: section.label,
            description: section.description,
            anchorId: section.id,
            sectionId: section.id,
            type: "section" as const
          }))
    )
      .map((item) => ({
        id: item.id,
        kind: "setting" as const,
        title: item.label,
        subtitle: item.type === "field" ? "Settings field" : "Settings section",
        description: item.description,
        href: `/settings#${encodeURIComponent(item.anchorId)}`,
        meta: {
          section_id: item.sectionId,
          anchor_id: item.anchorId
        }
      }))
      .slice(0, options.limit)

    if (settingsItems.length > 0) {
      sections.push({
        id: "settings",
        label: "Settings",
        items: settingsItems
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
      ...(options.taskKind ? { task_kind: options.taskKind } : {})
    }
  }
}
