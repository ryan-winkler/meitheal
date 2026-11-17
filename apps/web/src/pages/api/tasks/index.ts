import { organizationPlacementAvailable } from "@lib/organization-placement-access"
import { readHomeAssistantAreaPolicyRevision, setTaskHomeAssistantArea } from "@domains/tasks/persistence/home-assistant-task-area"
import { readHomeAssistantAreaFilter, resolveHomeAssistantAreaSelection } from "@lib/home-assistant-area-access"
import { HierarchyRepository } from "@domains/tasks/persistence/hierarchy-repository"
import { parseBoardPlacement } from "@lib/board-workspace"
import type { APIRoute } from "astro"
import type { ResultSet } from "@libsql/client"
import { deriveEisenhowerQuadrant, VALID_TASK_TYPES, type TaskType } from "@meitheal/domain-tasks"
import { normalizeLabelTitle, taskLabelInsert } from "@domains/labels"
import {
  dispatchTaskCreation,
  ensureSchema,
  getPersistenceClient,
  hasBoardSelection,
  prepareTaskCreation,
  rejectBoardSelectionInJson,
  taskAddedActivity,
  taskCreationPayload,
  taskInsertStatement,
  TaskRepository,
  unavailableBoardResponse,
} from "@domains/tasks"
import { runWriteTransaction } from "../../../../scripts/database-client.mjs"
import { formatTicketKey } from "../../../lib/ticket-key"
import { logApiError } from "../../../lib/api-logger"
import { isDbUnavailable, db503Response } from "../../../lib/db-fallback"
import { apiError } from "../../../lib/api-response"
import { normalizeStatus } from "../../../lib/status-config"
import { isValidTimezone } from "../../../lib/date"
import { readStoredHouseholdTimezone } from "../../../lib/task-queries"
import { resolveRecentActivityActor } from "../../../lib/recent-activity-actor"
import { taskEventAuthorityHeaders } from "../../../lib/webhook-dispatcher"

/** GET /api/tasks — list all tasks, POST /api/tasks — create a task */

export const GET: APIRoute = async context => {
  const { url, locals } = context
  try {
  await ensureSchema()
  const repo = new TaskRepository(getPersistenceClient())

  const sort = url.searchParams.get("sort") ?? "created_at"
  const order = url.searchParams.get("order") === "asc" ? "ASC" as const : "DESC" as const
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100))
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0)

  const taskType = url.searchParams.get("task_type")

  const findOpts: Parameters<typeof repo.findAll>[0] = {
    favorite: url.searchParams.get("favorite") === "1",
    sort,
    order,
    limit,
    offset,
  }
  const status = url.searchParams.get("status")
  if (status) findOpts.status = status
  const deferred = url.searchParams.get("deferred")
  if (deferred !== null) {
    if (deferred !== "0" && deferred !== "1") return apiError("deferred must be 0 or 1", 400)
    findOpts.deferred = deferred === "1"
  }
  const dueDate = url.searchParams.get("due_date")
  if (dueDate !== null) {
    const parsed = new Date(`${dueDate}T00:00:00.000Z`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dueDate) {
      return apiError("due_date must be a valid date in YYYY-MM-DD format", 400)
    }
    const timezone = locals?.timezone?.trim() ?? ""
    findOpts.dueDate = dueDate
    findOpts.timezone = isValidTimezone(timezone) ? timezone : await readStoredHouseholdTimezone()
  }
  const priority = url.searchParams.get("priority")
  if (priority) {
    const parsedPriority = Math.min(5, Math.max(1, Number(priority) || 0))
    if (parsedPriority > 0) findOpts.priority = parsedPriority
  }
  const areaId = url.searchParams.get("area_id")
  if (areaId) findOpts.areaId = areaId
  const projectId = url.searchParams.get("project_id")
  if (projectId) findOpts.projectId = projectId
  if (taskType && VALID_TASK_TYPES.includes(taskType as TaskType)) findOpts.taskType = taskType
  const parentId = url.searchParams.get("parent_id")
  if (parentId) findOpts.parentId = parentId
  const search = url.searchParams.get("q")
  if (search) findOpts.search = search
  const assignedTo = url.searchParams.get("assigned_to")
  if (assignedTo) findOpts.assignedTo = assignedTo
  const label = url.searchParams.get("label")
  if (label) findOpts.label = label

  if (url.searchParams.has("home_assistant_area_id")) {
    const filter = await readHomeAssistantAreaFilter(context, url.searchParams)
    if (!filter) return apiError("Home Assistant Area filter unavailable.", 404)
    findOpts.homeAssistantArea = filter
  }
  const { tasks: rawTasks, total } = await repo.findAll(findOpts)

  const tasks = rawTasks.map((r) => {
    const ticketNum = r.ticket_number != null ? Number(r.ticket_number) : null
    return {
      id: r.id,
      ticket_number: ticketNum,
      ticket_key: formatTicketKey(ticketNum),
      title: r.title,
      description: r.description ?? "",
      status: normalizeStatus(r.status),
      priority: Number(r.priority ?? 3),
      due_date: r.due_date ?? null,
      labels: r.labels ? String(r.labels) : "[]",
      framework_payload: typeof r.framework_payload === "string" ? r.framework_payload : "{}",
      calendar_sync_state: r.calendar_sync_state ?? "pending",
      parent_id: r.parent_id ?? null,
      time_tracked: Number(r.time_tracked ?? 0),
      area_id: r.area_id ?? "default",
      custom_fields: typeof r.custom_fields === "string" ? r.custom_fields : "{}",
      start_date: r.start_date ?? null,
      end_date: r.end_date ?? null,
      progress: Number(r.progress ?? 0),
      color: r.color ?? null,
      is_favorite: Number(r.is_favorite ?? 0),
      task_type: r.task_type ?? "task",
      task_kind: r.task_kind ?? "standard_action",
      assigned_to: r.assigned_to ?? null,
      kanban_position: r.kanban_position != null ? Number(r.kanban_position) : null,
      nfc_tag_id: r.nfc_tag_id ?? null,
      urgency: Number(r.urgency ?? 0),
      importance: Number(r.importance ?? 0),
      eisenhower_quadrant: deriveEisenhowerQuadrant(Number(r.urgency ?? 0), Number(r.importance ?? 0)),
      eisenhower_override: Number(r.eisenhower_override ?? 0),
      effort_minutes: r.effort_minutes != null ? Number(r.effort_minutes) : null,
      effort_type: r.effort_type ?? null,
      blocked_by: r.blocked_by ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      task_version: r.task_version,
      deferred_at: r.deferred_at,
      deferral_revision: r.deferral_revision,
    }
  })

  const body = JSON.stringify({ tasks, total, limit, offset })
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body, "utf8")),
      ...(findOpts.homeAssistantArea ? { "cache-control": "private, no-store" } : {}),
    },
  })
  } catch (err) {
    if (isDbUnavailable(err)) return db503Response("tasks-get", err)
    logApiError("tasks-get", "GET failed", err)
    return new Response(JSON.stringify({ error: "Failed to list tasks" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    })
  }
}

export const POST: APIRoute = async (context) => {
  const { request, locals } = context
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  if (!organizationPlacementAvailable(body)) return apiError("This organizing feature is unavailable.", 404)
  if (hasBoardSelection(body)) return unavailableBoardResponse()
  await ensureSchema()
  const client = getPersistenceClient()
  const repo = new TaskRepository(client)
  // Attribution comes only from verified identity. Unauthenticated X-Agent-Id headers and
  // body fields are claims, so a caller cannot record a task as created by an agent or person.
  const effectiveSource = locals.agentToken
    ? "agent"
    : (request.headers.has("X-Automation-Source") ? locals.automationSource : "user")
  const effectiveCreatedBy = locals.agentToken ? locals.agentToken.tokenName : null

  const placement = parseBoardPlacement(body.placement)
  if (body.placement !== undefined && (!placement || body.project_id !== undefined || body.area_id !== undefined)) {
    return apiError("Choose a valid Household group and Project.", 400)
  }
  const hierarchy = new HierarchyRepository(client)
  const project = placement?.projectId ? await hierarchy.findProjectById(placement.projectId) : null
  if (placement?.projectId && (!project || project.status !== "active" || (placement.areaId && placement.areaId !== project.area_id))) {
    return apiError("Household placement unavailable", 404)
  }
  const placementArea = project?.area_id ?? placement?.areaId ?? "default"
  const guard = placement ? {
    sql: `(? = 'default' OR EXISTS (
      SELECT 1 FROM areas WHERE id = ? AND owner_board_id IS NULL AND retired_at IS NULL
    )) AND (? IS NULL OR EXISTS (
      SELECT 1 FROM projects WHERE id = ? AND owner_board_id IS NULL AND retired_at IS NULL
        AND status = 'active' AND COALESCE(area_id, 'default') = ?
    ))`,
    args: [placementArea, placementArea, placement.projectId, placement.projectId, placementArea],
  } : undefined

  const homeLocation = await resolveHomeAssistantAreaSelection(context, body.home_assistant_area_id)
  if (!homeLocation.ok) return apiError(homeLocation.detail, homeLocation.status)

  const taskBody = {
    ...body,
    ...(placement ? { area_id: placementArea, project_id: placement.projectId } : {}),
    source: effectiveSource,
    created_by: effectiveCreatedBy,
  }
  const prepared = await prepareTaskCreation(repo, taskBody)
  if (!prepared.ok) return Response.json({ error: prepared.error }, { status: 400 })

  const now = Date.now()
  const activity = taskAddedActivity(prepared.task.id, resolveRecentActivityActor(locals, request), now)
  const statements = [taskInsertStatement(prepared.task, now, guard ? { guard } : {}), activity]
  if (body.new_labels !== undefined) {
    if (locals.agentToken) return apiError("Creating labels with a task requires a browser session.", 403)
    const labels: unknown = body.new_labels
    const selected: string[] = JSON.parse(prepared.task.labels)
    if (!Array.isArray(labels) || labels.length > 32 || !labels.every(
      name => typeof name === "string" && name && normalizeLabelTitle(name) === name && selected.includes(name),
    )) return apiError("Provide the new labels selected for this task.", 400)

    const requestId = crypto.randomUUID()
    statements[0] = taskInsertStatement(prepared.task, now, { requestId, ...(guard ? { guard } : {}) })
    statements.push(...[...new Set<string>(labels)].map(name => taskLabelInsert(name, prepared.task.id, requestId)))
  }
  const result = await runWriteTransaction(
    client,
    function* () {
      if (homeLocation.selection) {
        const [policy]: ResultSet[] = yield [readHomeAssistantAreaPolicyRevision(homeLocation.selection.revision)]
        if (!policy?.rows.length) return { allowed: false } as const
      }
      const [inserted]: ResultSet[] = yield statements
      const ticket = inserted?.rows[0]
      if (ticket && homeLocation.selection?.id) {
        yield [setTaskHomeAssistantArea(prepared.task.id, homeLocation.selection.id)]
      }
      return { allowed: true, ticket } as const
    },
    { signal: locals.writeAbortSignal },
  )
  if (!result.allowed) return apiError("Home Assistant Area access changed. Refresh the form and try again.", 403)
  const ticket = result.ticket
  if (!ticket) return placement ? apiError("Household placement unavailable", 404) : apiError("Choose available task relationships", 400)
  const ticketNumber = Number(ticket.ticket_number)
  const payload = taskCreationPayload(prepared.task, ticketNumber, now)
  const authority = await taskEventAuthorityHeaders(["task.created"])
  dispatchTaskCreation(payload, typeof body.request_id === "string" ? body.request_id : undefined, undefined, authority)
  return Response.json(payload, { status: 201, headers: authority })
}

export const DELETE: APIRoute = async ({ request, url }) => {
  try {
    const purge = url.searchParams.get("purge")
    if (purge !== "all") {
      return new Response(JSON.stringify({ error: "Use ?purge=all to confirm purge" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    }
    const boardSelection = await rejectBoardSelectionInJson(request, 400)
    if (boardSelection) return boardSelection
    await ensureSchema()
    const repo = new TaskRepository(getPersistenceClient())
    await repo.purgeAll()
    return new Response(JSON.stringify({ purged: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  } catch (err) {
    logApiError("tasks", "DELETE/purge failed", err)
    return new Response(JSON.stringify({ error: "Failed to purge tasks" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    })
  }
}
