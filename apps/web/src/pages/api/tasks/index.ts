import { captureAttempt } from "@lib/task-capture-attempt"
import { taskHttpProjection } from "@lib/task-http-projection"
import { scopePermits } from "@domains/tasks/board-scope"
import { withBoardScope } from "@lib/board-http"
import { organizationPlacementAvailable } from "@lib/organization-placement-access"
import { readHomeAssistantAreaPolicyRevision, setTaskHomeAssistantArea } from "@domains/tasks/persistence/home-assistant-task-area"
import { readHomeAssistantAreaFilter, resolveHomeAssistantAreaSelection } from "@lib/home-assistant-area-access"
import { HierarchyRepository } from "@domains/tasks/persistence/hierarchy-repository"
import { parseBoardPlacement } from "@lib/board-workspace"
import type { APIRoute } from "astro"
import type { ResultSet } from "@libsql/client"
import { deriveEisenhowerQuadrant, VALID_TASK_TYPES, type TaskType } from "@meitheal/domain-tasks"
import { normalizeLabelTitle } from "@domains/labels"
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
import { dispatchTaskEvent, taskEventAuthorityHeaders } from "../../../lib/webhook-dispatcher"

/** GET /api/tasks — list all tasks, POST /api/tasks — create a task */

export const GET: APIRoute = withBoardScope({ resource: "task", action: "read" }, async( context, scope) => {
  const { url, locals, request } = context
  try {
  await ensureSchema()
  const repo = new TaskRepository(getPersistenceClient(), scope)

  if (url.searchParams.has("captureReceipt")) {
    if (url.searchParams.get("captureReceipt") !== "1") return apiError("Invalid capture receipt request.", 400)
    const attempt = captureAttempt(request, scope, true)
    if (!attempt.ok) return apiError(attempt.error, 400)
    const receipt = await repo.findCaptureReceipt(attempt.digest!)
    return receipt ? Response.json(receipt) : apiError("Capture receipt unavailable.", 404)
  }
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
      ...taskHttpProjection(r, scope.boardId),
      id: r.id,
      ticket_number: ticketNum,
      ticket_key: r.ticket_key ?? r.ticket_ref ?? formatTicketKey(ticketNum),
      board_id: scope.boardId,
      title: r.title,
      description: r.description ?? "",
      status: normalizeStatus(r.status),
      priority: Number(r.priority ?? 3),
      due_date: r.due_date ?? null,
      labels: r.labels ? String(r.labels) : "[]",
      framework_payload: typeof r.framework_payload === "string" ? r.framework_payload : "{}",
      calendar_sync_state: r.calendar_sync_state ?? "pending",
      time_tracked: Number(r.time_tracked ?? 0),
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
})

export const POST: APIRoute = withBoardScope({ resource: "task", action: "create" }, async (context, scope) => {
  const { request, locals } = context
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  if (!body || typeof body !== "object" || Array.isArray(body)) return apiError("Send a task object.", 400)
  if (!organizationPlacementAvailable(body)) return apiError("This organizing feature is unavailable.", 404)
  if (hasBoardSelection(body)) return apiError("Select the Board using the request context.", 400)
  const attempt = captureAttempt(request, scope)
  if (!attempt.ok) return apiError(attempt.error, 400)
  const clientKey = request.headers.get("Idempotency-Key")
  if (clientKey !== null && (!clientKey.trim() || clientKey.length > 255)) return apiError("Use a valid Idempotency-Key.", 400)
  const repo = new TaskRepository(getPersistenceClient(), scope)
  const placement = parseBoardPlacement(body.placement)
  if (body.placement !== undefined && (!placement || body.project_id !== undefined || body.area_id !== undefined)) {
    return apiError("Choose valid Area and Project placement.", 400)
  }
  const homeLocation = await resolveHomeAssistantAreaSelection(context, body.home_assistant_area_id)
  if (!homeLocation.ok) return apiError(homeLocation.detail, homeLocation.status)
  const effectiveSource = locals.agentToken ? "agent"
    : (request.headers.has("X-Automation-Source") ? locals.automationSource : "user")
  const effectiveCreatedBy = locals.agentToken ? locals.agentToken.tokenName : scope.principal.id
  const prepared = await prepareTaskCreation(repo, {
    ...body,
    ...(placement ? { area_id: placement.areaId, project_id: placement.projectId } : {}),
    source: effectiveSource, created_by: effectiveCreatedBy,
  })
  if (!prepared.ok) return apiError(prepared.error, 400)
  let newLabels: string[] | undefined
  if (body.new_labels !== undefined) {
    if (locals.agentToken) return apiError("Creating labels with a task requires a browser session.", 403)
    const labels: unknown = body.new_labels
    const selected: string[] = JSON.parse(prepared.task.labels)
    if (!Array.isArray(labels) || labels.length > 32 || !labels.every(
      name => typeof name === "string" && name && normalizeLabelTitle(name) === name && selected.includes(name),
    )) return apiError("Provide the new labels selected for this task.", 400)
    newLabels = [...new Set<string>(labels)]
  }
  const result = await repo.createWorkCommand(prepared.task, {
    ...(attempt.digest ? { captureAttemptDigest: attempt.digest } : {}),
    ...(clientKey ? { clientIdempotencyKey: clientKey } : {}),
    activityActor: resolveRecentActivityActor(locals, request),
    ...(typeof body.laneId === "string" ? { laneId: body.laneId, deriveStatusFromLane: body.status === undefined } : {}),
    ...(newLabels ? { newLabels } : {}),
    ...(homeLocation.selection ? { homeLocation: homeLocation.selection } : {}),
    ...(locals.writeAbortSignal ? { signal: locals.writeAbortSignal } : {}),
  })
  if (!result.ok) {
    const status = ["capture_conflict", "conflict", "legacy_key_owner_unverified"].includes(result.errorCode) ? 409
      : result.errorCode === "unavailable" ? 404 : result.errorCode === "denied" ? 403 : 400
    return Response.json({ error: result.errorCode === "capture_conflict" ? "Capture already submitted. Check its receipt before retrying."
      : "This task could not be created.", errorCode: result.errorCode }, { status })
  }
  const payload = taskHttpProjection(result.task, scope.boardId)
  const authority = await taskEventAuthorityHeaders(["task.created"], scope)
  if (!result.replayed) dispatchTaskCreation(payload as ReturnType<typeof taskCreationPayload>, typeof body.request_id === "string" ? body.request_id : undefined, undefined, authority, scope)
  return Response.json(scopePermits(scope, { resource: "task", action: "read" }) ? payload
    : { id: String(result.task.id), ticket_key: payload.ticket_key }, { status: 201, headers: {
      ...authority, ...(clientKey ? { "idempotency-key-status": result.replayed ? "cached" : "processed" } : {}),
    } })
})

export const DELETE: APIRoute = withBoardScope({ resource: "task", action: "delete" }, async ({ request, url }, scope) => {
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
    const repo = new TaskRepository(getPersistenceClient(), scope)
    const receipts = await repo.purgeWorkCommand()
    const authority = await taskEventAuthorityHeaders(["task.deleted"], scope)
    for (const receipt of receipts) dispatchTaskEvent("task.deleted", { id: receipt.id }, undefined, undefined, receipt.eventId, authority, scope).catch(() => {})
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
})
