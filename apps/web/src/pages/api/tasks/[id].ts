import { scopePermits, type BoardScope } from "@domains/tasks/board-scope"
import { taskHttpProjection, taskDetailHttpProjection } from "@lib/task-http-projection"
import { readCurrentHARole } from "@domains/ha/current-admin"
import { boardScopeErrorResponse, withBoardScope } from "@lib/board-http"
import { organizationPlacementAvailable } from "@lib/organization-placement-access"
import type { APIRoute } from "astro"
import type { InValue } from "@libsql/client"
import { isValidTaskKind, normalizeShoppingItems, parseScheduleDateInput, validateScheduleWindow, VALID_TASK_KINDS, VALID_TASK_TYPES } from "@meitheal/domain-tasks"
import type { TaskType } from "@meitheal/domain-tasks"
import {
  getEntityPillarId,
  getPillarById,
  getPrinciplesForPillar,
  setEntityPillar,
} from "@domains/pillars"
import {
  BoardOperationError,
  parseRRule,
  ensureSchema,
  getPersistenceClient,
  hasBoardSelection,
  rejectBoardSelectionInJson,
  taskActionHints,
  taskChecklistsJson,
  taskJsonObject,
  taskLabelsJson,
  TaskRepository,
  unavailableBoardResponse,
  UserRepository,
} from "@domains/tasks"
import { frameworkPayloadObject } from "../../../lib/rice-lens"
import { formatTicketKey } from "../../../lib/ticket-key"
import { dispatchTaskEvent, taskEventAuthorityHeaders } from "../../../lib/webhook-dispatcher"
import { logApiError } from "../../../lib/api-logger"
import { apiError } from "../../../lib/api-response"
import { sanitizeMarkdownInput } from "../../../lib/sanitize"
import { checkAssignedTask, isAssignedWriteOnly, restrictedAssigneeId } from "../../../lib/agent-token-guard"
import { db503Response, isDbUnavailable } from "../../../lib/db-fallback"
import { resolveRecentActivityActor } from "../../../lib/recent-activity-actor"
import { STATUS, normalizeStatus, isDoneStatus } from "../../../lib/status-config"
import { stripHtml } from "../../../lib/strip-html"
import { sendTaskNotification, notificationOperationAllowed } from "@domains/notifications"
import { localReaderCacheToken } from "../../../../scripts/database-client.mjs"
import { agentActivityActor } from "../../../lib/agent-activity-actor"


/** GET /api/tasks/[id], PUT /api/tasks/[id], DELETE /api/tasks/[id] */

function taskVersionConflict(serverVersion: number, clientVersion: number): Response {
  return new Response(JSON.stringify({
    error: "Conflict: task was modified since your last read",
    errorCode: "TASK_VERSION_CONFLICT",
    server_updated_at: serverVersion,
    client_updated_at: clientVersion,
  }), {
    status: 409,
    headers: { "content-type": "application/json" },
  })
}

export const GET: APIRoute = withBoardScope({ resource: "task", action: "read" }, async ({ params, url, request }, scope) => {
  await ensureSchema()
  const repo = new TaskRepository(getPersistenceClient(), scope)
  const headers = {
    "content-type": "application/json",
    ...(url.searchParams.has("deferralRead") ? { "cache-control": "no-store" } : {}),
  }

  const detailResult = await repo.findDetailWithSubtasks(params.id!)
  if (!detailResult) {
    return new Response(JSON.stringify({ error: "Task not found" }), {
      status: 404,
      headers,
    })
  }
  const { task: row, subtasks, hasPillar } = detailResult

  // Derive human-readable ticket keys
  const ticketNum = row.ticket_number != null ? Number(row.ticket_number) : null
  const parentTicketNum = row.parent_ticket_number != null ? Number(row.parent_ticket_number) : null
  const detail = taskDetailHttpProjection(row, scope.boardId, scope.principal.kind === "ha_user" && await readCurrentHARole(scope.principal.id, request.signal) === "admin")
  const pillarId = hasPillar ? await readOptionalTaskPillarId(scope, String(row.id ?? params.id!)) : null
  const fp = parseFrameworkPayload(row.framework_payload)
  const principleId = pillarId && typeof fp.principle_id === "string" && fp.principle_id ? fp.principle_id : null
  const visibleParent = detail.parent_id != null
  const parentTicketKey = visibleParent
    ? (typeof row.parent_ticket_ref === "string" && row.parent_ticket_ref
        ? row.parent_ticket_ref
        : formatTicketKey(parentTicketNum))
    : null
  const enriched = {
    ...detail,
    pillar_id: pillarId,
    principle_id: principleId,
    actions: taskActionHints(scope, row),
    is_promoted: Boolean(row.is_promoted),
    ticket_key: row.ticket_key ?? row.ticket_ref ?? formatTicketKey(ticketNum),
    parent_ticket_key: parentTicketKey,
    parent_title: visibleParent ? (row.parent_title ?? null) : null,
    parent_task_type: visibleParent ? (row.parent_task_type ?? null) : null,
    subtasks,
  }

  return new Response(JSON.stringify(enriched), {
    status: 200,
    headers,
  })
})

function parseFrameworkPayload(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {}
  try {
    return frameworkPayloadObject(JSON.parse(raw))
  } catch {
    return {}
  }
}

const pillarsPresenceCache = new WeakMap<object, { generation: string; hasPillars: boolean }>()

async function hasAnyPillarsRow(): Promise<boolean> {
  const client = getPersistenceClient()
  const state = localReaderCacheToken(client)
  if (!state) return true
  const cached = pillarsPresenceCache.get(state.owner)
  if (cached && cached.generation === state.token) return cached.hasPillars
  try {
    const result = await client.execute("SELECT 1 FROM pillars LIMIT 1")
    const hasPillars = result.rows.length > 0
    const currentGeneration = localReaderCacheToken(client)?.token
    if (currentGeneration === state.token) {
      pillarsPresenceCache.set(state.owner, { generation: currentGeneration, hasPillars })
    }
    return hasPillars
  } catch {
    return true
  }
}

async function readOptionalTaskPillarId(scope: BoardScope, taskId: string): Promise<string | null> {
  if (!scopePermits(scope, { resource: "pillar", action: "read" }) || !await hasAnyPillarsRow()) return null
  try {
    return await getEntityPillarId(scope, "tasks", taskId)
  } catch (err) {
    if (err instanceof BoardOperationError && (err.errorCode === "denied" || err.errorCode === "unavailable")) return null
    throw err
  }
}

function normalizeReassignedTarget(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 255) return undefined
  return trimmed
}

function parseReceiptAssignee(payload: string | null): string | null | undefined {
  if (typeof payload !== "string") return undefined
  try {
    const parsed: unknown = JSON.parse(payload)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    const value = (parsed as { assigned_to?: unknown }).assigned_to
    return value === null || typeof value === "string" ? value : undefined
  } catch {
    return undefined
  }
}

function loggedTarget(value: string | null): string | null {
  return value === null || value === "" ? null : value
}

/**
 * An assigned-only agent loses write access to a task once it reassigns it, so a
 * client retry of that same PUT would be refused even though it succeeded. When
 * a retry carries the original request_id for the reassignment this agent made,
 * acknowledge it (returning only minimal confirmation unless the token has tasks:read).
 */
async function replayedAgentReassignment(
  repo: TaskRepository,
  agentToken: App.Locals["agentToken"],
  taskId: string,
  body: Record<string, unknown>,
  expectedActor: string | undefined,
  boardId: string,
): Promise<Response | null> {
  if (!agentToken?.assigneeId) return null
  const requestId = typeof body.request_id === "string" ? body.request_id.trim().slice(0, 128) : ""
  if (!requestId) return null
  const requested = normalizeReassignedTarget(body.assigned_to)
  if (requested === undefined) return null
  const fields = Object.keys(body).filter((key) => key !== "updated_at" && key !== "request_id")
  if (fields.length !== 1 || fields[0] !== "assigned_to") return null
  const receipt = await repo.findReassignmentReceipt(taskId, requestId, requested)
  return receipt ? Response.json(receipt) : null
}

export const PUT: APIRoute = withBoardScope({ resource: "task", action: "edit" }, async ({ params, request, locals }, scope) => {
  let rawBody: unknown
  try {
    const rawText = await request.text()
    rawBody = rawText.trim() ? JSON.parse(rawText) : {}
  } catch {
    return apiError("Request body must be valid JSON", 400)
  }
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return apiError("Request body must be a JSON object", 400)
  }
  const body = rawBody as Record<string, unknown>
  if (!organizationPlacementAvailable(body)) return apiError("This organizing feature is unavailable.", 404)
  if (hasBoardSelection(body)) return unavailableBoardResponse()
  let clientVersion: number | undefined
  if (body.updated_at !== undefined) {
    if (typeof body.updated_at !== "number" || !Number.isSafeInteger(body.updated_at) || body.updated_at < 0) {
      return apiError("updated_at must be a non-negative safe integer", 400)
    }
    clientVersion = body.updated_at
  }
  await ensureSchema()
  const repo = new TaskRepository(getPersistenceClient(), scope)

  // The committed receipt can confirm this actor's own exact handoff after assignment moved away.
  // It grants no row read and is checked before the normal assigned edit locator.
  if (isAssignedWriteOnly(locals.agentToken)) {
    const replay = await replayedAgentReassignment(repo, locals.agentToken, params.id!, body, agentActivityActor(locals)?.actor, scope.boardId)
    if (replay) return replay
  }
  // Resolve the actual task under current edit and assignment authority.
  const resolved = await repo.resolveTaskId(params.id!, "edit")
  if (!resolved) {
    // Another request can commit the same handoff between the first receipt
    // check and this assigned locator. Confirm only that exact committed intent.
    if (isAssignedWriteOnly(locals.agentToken)) {
      const replay = await replayedAgentReassignment(repo, locals.agentToken, params.id!, body, agentActivityActor(locals)?.actor, scope.boardId)
      if (replay) return replay
    }
    return new Response(JSON.stringify({ error: "Task not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })
  }

  const resolvedId = resolved.id
  const agentToken = locals.agentToken
  const canReadTask = scopePermits(scope, { resource: "task", action: "read" })
  const expectedActor = agentActivityActor(locals)?.actor
  const denied = isAssignedWriteOnly(agentToken) ? await checkAssignedTask(resolvedId, agentToken!) : null
  if (denied) return (await replayedAgentReassignment(repo, agentToken, resolvedId, body, expectedActor, scope.boardId)) ?? denied
  let currentTaskForEdit: Awaited<ReturnType<typeof repo.findTaskForCommand>> = null
  if (body.due_date !== undefined || body.task_kind !== undefined) {
    if (resolved.routine_occurrence === 1 &&
      ((body.due_date !== undefined && body.due_date !== resolved.due_date) ||
        (body.task_kind !== undefined && body.task_kind !== "routine_instance"))) {
      return apiError("A generated Routine task keeps its original date and type. Complete its existing occurrence.", 409)
    }
  }

  if (body.action === "file") {
    const { areaId, projectId, version } = body
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0 ||
        (areaId != null && typeof areaId !== "string") || (projectId != null && typeof projectId !== "string")) {
      return apiError("Choose a valid Board placement and task version.", 400)
    }
    if (agentToken) return apiError("Board filing requires a person’s session.", 403)
    const change = await repo.fileHouseholdTask(resolvedId, version, {
      ...(areaId !== undefined ? { areaId } : {}), ...(projectId !== undefined ? { projectId } : {}),
    })
    return change.ok ? Response.json(scopePermits(scope, { resource: "task", action: "read" }) ? taskHttpProjection(change.task, scope.boardId) : { id: change.task.id })
      : apiError(change.stale ? "Refresh the task before filing it." : "Board placement unavailable", change.stale ? 409 : 404)
  }

  if (body.expected_status !== undefined && (
    body.expected_status !== STATUS.BACKLOG || clientVersion === undefined ||
    (body.status !== STATUS.PENDING && body.status !== STATUS.ACTIVE)
  )) {
    return apiError("Backlog decisions require expected_status backlog, updated_at and status pending or active", 400)
  }

  const storedVersion = Number(resolved.updated_at)
  if (clientVersion !== undefined && clientVersion < storedVersion) {
    return taskVersionConflict(storedVersion, clientVersion)
  }

  if ("nfc_tag_id" in body && body.nfc_tag_id !== null &&
      (typeof body.nfc_tag_id !== "string" || !body.nfc_tag_id.trim() || body.nfc_tag_id.trim().length > 255)) {
    return apiError("nfc_tag_id must be null or 1-255 characters", 400)
  }

  // Input sanitization — same rules as POST
  const sanitized: Record<string, InValue> = {}
  if ("nfc_tag_id" in body) sanitized.nfc_tag_id = typeof body.nfc_tag_id === "string" ? body.nfc_tag_id.trim() : null

  if (typeof body.title === "string") {
    const t = stripHtml(body.title.trim()).trim()
    if (!t) {
      return new Response(JSON.stringify({ error: "title cannot be empty" }), {
        status: 400, headers: { "content-type": "application/json" },
      })
    }
    if (t.length > 500) {
      return new Response(JSON.stringify({ error: "title must be 500 characters or less" }), {
        status: 400, headers: { "content-type": "application/json" },
      })
    }
    sanitized.title = t
  }
  if (typeof body.description === "string") {
    if (body.description.length > 10000) return apiError("description must be 10000 characters or less", 400)
    sanitized.description = body.description ? sanitizeMarkdownInput(body.description) : ""
  }
  if (typeof body.status === "string") {
    const st = body.status.trim().toLowerCase().replace(/[^a-z0-9_]/g, "")
    if (!st || st.length > 50) {
      return new Response(JSON.stringify({ error: "status must be 1-50 alphanumeric/underscore characters" }), {
        status: 400, headers: { "content-type": "application/json" },
      })
    }
    sanitized.status = normalizeStatus(st)
  }
  if (body.priority !== undefined) {
    if (typeof body.priority !== "number" || !Number.isFinite(body.priority)) {
      return apiError("priority must be a finite number between 1 and 5", 400)
    }
    sanitized.priority = Math.min(5, Math.max(1, Math.round(body.priority)))
  }
  if (body.due_date !== undefined) {
    sanitized.due_date = typeof body.due_date === "string" && body.due_date.trim() ? body.due_date.trim() : null
  }
  if (body.labels !== undefined) {
    const labels = taskLabelsJson(body.labels)
    if (labels === null) {
      return new Response(JSON.stringify({ error: "labels must be an array of strings or a JSON string array" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    sanitized.labels = labels
  }
  if (body.framework_payload !== undefined) {
    const fpRes = taskJsonObject(body.framework_payload, "framework_payload")
    if (!fpRes.ok) {
      return new Response(JSON.stringify({ error: fpRes.error }), { status: 400, headers: { "content-type": "application/json" } })
    }
    sanitized.framework_payload = fpRes.json
  }
  let updatedCustomFieldsObj: Record<string, unknown> | null = null
  if (body.custom_fields !== undefined) {
    const cfRes = taskJsonObject(body.custom_fields, "custom_fields")
    if (!cfRes.ok) {
      return new Response(JSON.stringify({ error: cfRes.error }), { status: 400, headers: { "content-type": "application/json" } })
    }
    sanitized.custom_fields = cfRes.json
    updatedCustomFieldsObj = cfRes.obj
  }
  if (typeof body.area_id === "string" || body.area_id === null) {
    sanitized.area_id = body.area_id
  }
  if (body.project_id !== undefined) {
    if (body.project_id !== null && (typeof body.project_id !== "string" || !body.project_id.trim())) {
      return apiError("project_id must be a project ID or null", 400)
    }
    sanitized.project_id = body.project_id
  }
  if (body.start_date !== undefined) {
    const parsedStart = parseScheduleDateInput(body.start_date, "start_date")
    if (!parsedStart.ok) return apiError(parsedStart.error, 400)
    sanitized.start_date = parsedStart.value
  }
  if (body.end_date !== undefined) {
    const parsedEnd = parseScheduleDateInput(body.end_date, "end_date")
    if (!parsedEnd.ok) return apiError(parsedEnd.error, 400)
    sanitized.end_date = parsedEnd.value
  }
  if (sanitized.start_date !== undefined || sanitized.end_date !== undefined) {
    if (sanitized.start_date === undefined || sanitized.end_date === undefined) {
      currentTaskForEdit ??= await repo.findTaskForCommand(resolvedId, "edit")
    }
    const nextStart = sanitized.start_date !== undefined ? (sanitized.start_date as string | null) : (currentTaskForEdit?.start_date ?? null)
    const nextEnd = sanitized.end_date !== undefined ? (sanitized.end_date as string | null) : (currentTaskForEdit?.end_date ?? null)
    const scheduleError = validateScheduleWindow(nextStart, nextEnd)
    if (scheduleError) return apiError(scheduleError, 400)
  }
  if (body.progress !== undefined) {
    if (typeof body.progress !== "number" || !Number.isFinite(body.progress)) {
      return apiError("progress must be a finite number", 400)
    }
    sanitized.progress = Math.min(100, Math.max(0, Math.round(body.progress)))
  }
  if (body.color !== undefined) {
    sanitized.color = typeof body.color === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(body.color) ? body.color : null
  }
  if (body.is_favorite !== undefined) {
    return apiError("is_favorite has been retired; use is_promoted instead.", 400)
  }
  if (body.is_promoted !== undefined) {
    if (typeof body.is_promoted !== "boolean") return apiError("is_promoted must be a boolean", 400)
    sanitized.is_promoted = body.is_promoted ? 1 : 0
  }
  if (body.parent_id !== undefined) {
    if (body.parent_id !== null && typeof body.parent_id !== "string") {
      return apiError("parent_id must be a task ID string or null", 400)
    }
    sanitized.parent_id = typeof body.parent_id === "string" && body.parent_id.trim() ? body.parent_id.trim() : null
  }
  if (body.time_tracked !== undefined) {
    if (typeof body.time_tracked !== "number" || !Number.isFinite(body.time_tracked)) {
      return apiError("time_tracked must be a finite number", 400)
    }
    sanitized.time_tracked = Math.max(0, Math.round(body.time_tracked))
  }
  if (body.task_type !== undefined) {
    if (typeof body.task_type !== "string") {
      return apiError("task_type must be epic, story, or task", 400)
    }
    const tt = body.task_type.trim().toLowerCase()
    if (!VALID_TASK_TYPES.includes(tt as TaskType)) {
      return apiError("task_type must be epic, story, or task", 400)
    }
    sanitized.task_type = tt
  }
  if (body.task_kind !== undefined) {
    if (typeof body.task_kind !== "string") {
      return apiError(`task_kind must be one of: ${VALID_TASK_KINDS.join(", ")}`, 400)
    }
    const tk = body.task_kind.trim().toLowerCase()
    if (!isValidTaskKind(tk)) {
      return apiError(`Invalid task_kind "${body.task_kind}". Valid values: ${VALID_TASK_KINDS.join(", ")}`, 400)
    }
    currentTaskForEdit ??= await repo.findTaskForCommand(resolvedId, "edit")
    if (tk === "routine_instance" && currentTaskForEdit?.task_kind !== "routine_instance") {
      return apiError("Only scheduled Routines can create routine_instance tasks.", 409)
    }
    sanitized.task_kind = tk
  }
  let effectiveKind = typeof sanitized.task_kind === "string" ? sanitized.task_kind : currentTaskForEdit?.task_kind
  if (!effectiveKind && updatedCustomFieldsObj && Array.isArray(updatedCustomFieldsObj.items)) {
    currentTaskForEdit ??= await repo.findTaskForCommand(resolvedId, "edit")
    effectiveKind = currentTaskForEdit?.task_kind
  }
  if ((effectiveKind ?? "standard_action") === "shopping_item" && updatedCustomFieldsObj && Array.isArray(updatedCustomFieldsObj.items)) {
    sanitized.custom_fields = JSON.stringify({
      ...updatedCustomFieldsObj,
      items: normalizeShoppingItems(updatedCustomFieldsObj.items),
    })
  }
  if (body.assigned_to !== undefined) {
    const nextAssignee = normalizeReassignedTarget(body.assigned_to)
    if (nextAssignee === undefined) {
      return apiError("assigned_to must be a non-empty string (max 255 chars) or null", 400)
    }
    sanitized.assigned_to = nextAssignee
  }
  if (body.owner !== undefined) return apiError("Change the assignee or use the task handoff actions to change ownership.", 400)

  // Guard the same raw checklist returned by GET. Legacy clients may omit the guard.
  const expectedChecklists = body.expected_checklists
  if (expectedChecklists !== undefined &&
      ((expectedChecklists !== null && typeof expectedChecklists !== "string") || body.checklists === undefined)) {
    return apiError("expected_checklists requires the prior checklist string or null and a replacement checklist", 400)
  }
  if (body.checklists !== undefined) {
    const clRes = taskChecklistsJson(body.checklists, true)
    if (!clRes.ok) {
      return new Response(JSON.stringify({ error: clRes.error }), { status: 400, headers: { "content-type": "application/json" } })
    }
    sanitized.checklists = clRes.json
  }

  if (body.recurrence_rule !== undefined) {
    if (body.recurrence_rule !== null && typeof body.recurrence_rule !== "string") return apiError("recurrence_rule must be a recurrence rule string or null", 400)
    const rule = typeof body.recurrence_rule === "string" ? body.recurrence_rule.trim() : ""
    if (rule && (rule.length > 200 || !parseRRule(rule))) return apiError("recurrence_rule must be a supported recurrence rule", 400)
    sanitized.recurrence_rule = rule || null
  }

  // Phase 6: Recurrence anchor (due_date or completion_date)
  if (typeof body.recurrence_anchor === "string") {
    const anchor = body.recurrence_anchor.trim().toLowerCase()
    if (anchor === "due_date" || anchor === "completion_date") {
      sanitized.recurrence_anchor = anchor
    }
  }

  // PRA-13: Time-blocking fields for calendar-driven focus sessions
  if (body.time_block_start !== undefined) {
    sanitized.time_block_start = typeof body.time_block_start === "string" ? body.time_block_start : null
  }
  if (body.time_block_end !== undefined) {
    sanitized.time_block_end = typeof body.time_block_end === "string" ? body.time_block_end : null
  }

  // Phase 06: Eisenhower urgency/importance (0-5 integer)
  if (body.urgency !== undefined) {
    if (typeof body.urgency !== "number" || !Number.isFinite(body.urgency)) {
      return apiError("urgency must be a finite number", 400)
    }
    sanitized.urgency = Math.min(5, Math.max(0, Math.round(body.urgency)))
  }
  if (body.importance !== undefined) {
    if (typeof body.importance !== "number" || !Number.isFinite(body.importance)) {
      return apiError("importance must be a finite number", 400)
    }
    sanitized.importance = Math.min(5, Math.max(0, Math.round(body.importance)))
  }
  if (body.eisenhower_override !== undefined) {
    sanitized.eisenhower_override = body.eisenhower_override ? 1 : 0
  }

  // Phase 07: Extended planning fields — effort, blocked_by
  if (body.effort_minutes !== undefined) {
    if (body.effort_minutes === null) {
      sanitized.effort_minutes = null
    } else if (typeof body.effort_minutes === "number" && Number.isFinite(body.effort_minutes)) {
      sanitized.effort_minutes = Math.min(480, Math.max(1, Math.round(body.effort_minutes)))
    } else {
      return apiError("effort_minutes must be a finite number or null", 400)
    }
  }
  if (body.effort_type !== undefined) {
    if (body.effort_type === null) {
      sanitized.effort_type = null
    } else if (typeof body.effort_type === "string") {
      const et = body.effort_type.trim().toLowerCase()
      if (["deep", "shallow", "admin"].includes(et)) {
        sanitized.effort_type = et
      }
    }
  }
  if (body.blocked_by !== undefined) {
    sanitized.blocked_by = typeof body.blocked_by === "string" && body.blocked_by.trim().length > 0
      ? body.blocked_by.trim().slice(0, 500) : null
  }

  const hasPillarUpdate = body.pillar_id !== undefined
  let nextPillarId: string | null = null
  if (hasPillarUpdate) {
    if (body.pillar_id !== null && typeof body.pillar_id !== "string") {
      return apiError("pillar_id must be a string or null", 400)
    }
    nextPillarId = typeof body.pillar_id === "string" && body.pillar_id.trim() ? body.pillar_id.trim() : null
    if (nextPillarId && nextPillarId.length > 128) {
      return apiError("pillar_id must be 128 characters or less", 400)
    }
  }
  const hasPrincipleUpdate = body.principle_id !== undefined
  let nextPrincipleId: string | null = null
  if (hasPrincipleUpdate) {
    if (body.principle_id !== null && typeof body.principle_id !== "string") {
      return apiError("principle_id must be a string or null", 400)
    }
    nextPrincipleId = typeof body.principle_id === "string" && body.principle_id.trim() ? body.principle_id.trim() : null
    if (nextPrincipleId && nextPrincipleId.length > 128) {
      return apiError("principle_id must be 128 characters or less", 400)
    }
  }

  if (hasPillarUpdate || hasPrincipleUpdate) {
    try {
      if (hasPillarUpdate && !scopePermits(scope, { resource: "pillar", action: "edit" })) {
        return apiError("Pillar editing is not permitted", 403)
      }
      if (hasPillarUpdate && nextPillarId) {
        const pillar = await getPillarById(scope, nextPillarId)
        if (!pillar) return apiError("Invalid pillar_id", 400)
      }
      const existingRow = typeof sanitized.framework_payload === "string" ? null : await repo.findById(resolvedId)
      const fp = typeof sanitized.framework_payload === "string"
        ? parseFrameworkPayload(sanitized.framework_payload)
        : parseFrameworkPayload(existingRow?.framework_payload)
      const currentPillarId = await readOptionalTaskPillarId(scope, resolvedId)
      const effectivePillarId = hasPillarUpdate ? nextPillarId : currentPillarId

      if (hasPrincipleUpdate) {
        if (nextPrincipleId) {
          if (!effectivePillarId) return apiError("Select a pillar before setting a principle", 400)
          const principles = await getPrinciplesForPillar(scope, effectivePillarId)
          if (!principles.some(p => p.id === nextPrincipleId)) {
            return apiError("Invalid principle_id", 400)
          }
          fp.principle_id = nextPrincipleId
        } else {
          delete fp.principle_id
        }
      } else if (hasPillarUpdate && (nextPillarId === null || nextPillarId !== currentPillarId)) {
        delete fp.principle_id
      }
      sanitized.framework_payload = JSON.stringify(fp)
    } catch (err) {
      const scopeFailure = boardScopeErrorResponse(err)
      if (scopeFailure) return scopeFailure
      throw err
    }
  }

  if (Object.keys(sanitized).length === 0) {
    return new Response(JSON.stringify({ error: "No fields to update" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })
  }

  // The writer records activity from its own snapshot. Only priority and
  // assignment notifications need old fields from this request.
  const oldTask = sanitized.priority === 1 || sanitized.assigned_to !== undefined
    ? await repo.getFieldsForDiff(resolvedId)
    : null

  // Perform the update via repository
  const version = clientVersion === undefined ? undefined : {
    updatedAt: clientVersion,
    ...(body.expected_status === STATUS.BACKLOG ? { expectedStatus: STATUS.BACKLOG } : {}),
  }
  const completionIntent = typeof sanitized.status === "string" && isDoneStatus(sanitized.status)
  const expectedAssignedTo = restrictedAssigneeId(agentToken)
  const requestId = typeof body.request_id === "string" ? body.request_id.trim().slice(0, 128) : ""
  const reassignmentReceipt = requestId && agentToken && sanitized.assigned_to !== undefined &&
    (!isAssignedWriteOnly(agentToken) || (sanitized.assigned_to ?? null) !== agentToken.assigneeId)
    ? {
      key: `${agentToken.tokenId}:${isAssignedWriteOnly(agentToken) ? agentToken.assigneeId : "scope:broad"}:${resolvedId}:${requestId}`,
      requestId,
      assignedTo: sanitized.assigned_to === null ? null : String(sanitized.assigned_to),
    }
    : undefined
  let update
  try {
    update = await repo.updateTask(resolvedId, sanitized, {
      activity: resolveRecentActivityActor(locals, request),
      ...(requestId ? { activityRequestId: requestId } : {}),
      ...(version ? { version } : {}),
      ...(expectedChecklists !== undefined ? { expectedChecklists } : {}),
      ...(expectedAssignedTo !== undefined ? { expectedAssignedTo } : {}),
      ...(reassignmentReceipt ? { reassignmentReceipt } : {}),
      ...(locals.writeAbortSignal ? { signal: locals.writeAbortSignal } : {}),
    })
  } catch (err) {
    if ((err as { name?: string } | null)?.name === "AbortError") throw err
    // A queued writer can lose the old assignment after the identical request
    // commits. Its durable receipt is the only permitted acknowledgement.
    if (isAssignedWriteOnly(agentToken)) {
      const replay = await replayedAgentReassignment(repo, agentToken, resolvedId, body, expectedActor, scope.boardId)
      if (replay) return replay
    }
    const scopeFailure = boardScopeErrorResponse(err)
    if (scopeFailure) return scopeFailure
    if (!completionIntent) throw err
    if ((err as { name?: string } | null)?.name === "AbortError") throw err
    const code = err && typeof err === "object" && "code" in err ? err.code : undefined
    if (code === "TRANSACTION_ACTIVE" || code === "SQLITE_BUSY" || isDbUnavailable(err)) {
      return db503Response("task-completion", err)
    }
    logApiError("task-completion", "Failed to save task completion", err)
    return apiError("Could not save task completion. Try again.", 500)
  }
  if (!update.ok) {
    if (update.errorCode === "assignee_mismatch") {
      return (await replayedAgentReassignment(repo, agentToken, resolvedId, body, expectedActor, scope.boardId)) ??
        apiError("Agent can only update tasks assigned to it", 403)
    }
    if (update.errorCode === "hierarchy_invalid") {
      return apiError(update.message, 400)
    }
    if (update.errorCode === "hierarchy_conflict") {
      return apiError(update.message, 409)
    }
    if (update.errorCode === "conflict") {
      return taskVersionConflict(update.updatedAt, clientVersion!)
    }
    if (update.errorCode === "checklist_conflict") {
      return Response.json({
        error: "The checklist changed since your last read",
        code: "checklist_conflict",
        ...(canReadTask ? { checklists: update.checklists } : {}),
      }, { status: 409, headers: { "cache-control": "no-store" } })
    }
    if (update.errorCode === "blocked") {
      return new Response(JSON.stringify({
        error: "Cannot activate: task is blocked by open dependencies",
        errorCode: "TASK_BLOCKED",
        ...(canReadTask
          ? {
              blocked_by: update.blockers.map(({ id, title, status, ticket_number }) => ({
                id,
                title,
                status,
                ticket_key: ticket_number ? formatTicketKey(Number(ticket_number)) : null,
              })),
            }
          : {}),
      }), {
        status: 409,
        headers: { "content-type": "application/json" },
      })
    }
    if (isAssignedWriteOnly(agentToken)) {
      const replay = await replayedAgentReassignment(repo, agentToken, resolvedId, body, expectedActor, scope.boardId)
      if (replay) return replay
    }
    return typeof sanitized.project_id === "string"
      ? apiError("Task or destination project is no longer available", 409)
      : apiError("Task not found", 404)
  }
  const updatedRow = update.task
  if (hasPillarUpdate) {
    try {
      const linked = await setEntityPillar(scope, "tasks", resolvedId, nextPillarId)
      if (!linked && nextPillarId !== null) return apiError("Invalid pillar_id", 400)
    } catch (err) {
      const scopeFailure = boardScopeErrorResponse(err)
      if (scopeFailure) return scopeFailure
      throw err
    }
  }
  const newlyCompleted = completionIntent && !isDoneStatus(update.previousStatus ?? "")

  // The common writer commits recent activity and field history with the task mutation.

  const updTicketNum = updatedRow.ticket_number != null ? Number(updatedRow.ticket_number) : null
  const finalPillarId = hasPillarUpdate ? nextPillarId : await readOptionalTaskPillarId(scope, resolvedId)
  const finalFp = parseFrameworkPayload(updatedRow.framework_payload)
  const finalPrincipleId = finalPillarId && typeof finalFp.principle_id === "string" && finalFp.principle_id
    ? finalFp.principle_id
    : null
  const taskPayload: Record<string, unknown> = {
    ...taskHttpProjection(updatedRow, scope.boardId),
    pillar_id: finalPillarId,
    principle_id: finalPrincipleId,
    is_promoted: Boolean(updatedRow.is_promoted),
    ticket_key: updatedRow.ticket_key ?? updatedRow.ticket_ref ?? formatTicketKey(updTicketNum),
  }

  const authority = await taskEventAuthorityHeaders([
    "task.updated",
    // The App also owns the decision not to re-emit an acknowledged completion.
    ...(completionIntent ? ["task.completed"] : []),
  ], scope)
  dispatchTaskEvent("task.updated", taskPayload, requestId || undefined, undefined, update.assignmentEventId, authority, scope).catch(() => {})

  // Notification preference guard
  const notifPrefs = await repo.getNotificationPreferences()

  // Lazy-load @domains/ha only when an enabled notification channel dispatches
  let haServicesPromise: Promise<typeof import("@domains/ha")> | null = null
  const getHAServices = () => (haServicesPromise ??= import("@domains/ha"))

  // Helper: dispatch notification to configured channels
  interface DispatchOpts { isUrgent?: boolean; badgeCount?: number }
  function dispatchNotification(
    title: string, message: string, notifId: string,
    ingress: string | null, taskId?: string, opts: DispatchOpts = {},
  ) {
    return sendTaskNotification(notifPrefs, {
      title, message, notificationId: notifId, ingress,
      ...(taskId ? { taskId } : {}), ...(typeof updatedRow.task_version === "number" ? { taskVersion: updatedRow.task_version } : {}), ...opts,
    }, scope, { resource: "task", action: "edit" })
  }

  // Helper: dismiss mobile notifications
  async function dismissMobileNotification(notifTag: string) {
    if (!notifPrefs.channels.mobile_push || notifPrefs.mobileTargets.length === 0) return
    const { callHAService } = await getHAServices()
    for (const target of notifPrefs.mobileTargets) {
      const [domain, ...rest] = target.split(".")
      const service = rest.join(".")
      if (domain && service) {
        callHAService(domain, service, {
          message: "clear_notification",
          data: { tag: notifTag },
        }, undefined, { operationAllowed: () => notificationOperationAllowed(scope, target, { resource: "task", action: "edit" }, resolvedId, undefined, updatedRow.task_version) }).catch(() => {})
      }
    }
  }

  // Phase 52: Notification if bumped to Urgent (P1)
  if (notifPrefs.enabled && sanitized.priority === 1 && oldTask?.priority !== 1) {
    import("@lib/ha-app-link").then(async ({ homeAssistantWorkLink }) => {
      const ingress = await homeAssistantWorkLink(scope.boardId, resolvedId)
      const titleStr = typeof sanitized.title === "string" ? sanitized.title : String(oldTask?.title ?? "Task")
      const ticketKey = taskPayload.ticket_key ?? "Task"
      const link = ingress ? `\n\n[Open ${ticketKey} in Meitheal →](${ingress})` : ""
      const badge = await repo.getOpenTaskCount().catch(() => undefined)
      dispatchNotification(
        `🚨 Escalated to Urgent: ${titleStr}`,
        `${ticketKey} has been escalated to P1 — Urgent.${link}`,
        `meitheal_urgent_${resolvedId}`,
        ingress,
        resolvedId,
        { isUrgent: true, ...(badge === undefined ? {} : { badgeCount: badge }) },
      ).catch(() => {})
    }).catch(() => {})
  }

  // Assignment-change notification (respects per-user prefs)
  if (notifPrefs.enabled && !update.assignmentEventId && sanitized.assigned_to !== undefined && (sanitized.assigned_to || null) !== (oldTask?.assigned_to || null)) {
    const assignee = typeof sanitized.assigned_to === "string" ? sanitized.assigned_to : null
    const handedBackByAgent = Boolean(agentToken?.assigneeId) && oldTask?.assigned_to === agentToken?.assigneeId
    if (assignee && !notifPrefs.disabledUsers.has(assignee)) {
      import("@lib/ha-app-link").then(async ({ homeAssistantWorkLink }) => {
        const ingress = await homeAssistantWorkLink(scope.boardId, resolvedId)
        const titleStr = typeof sanitized.title === "string" ? sanitized.title : String(oldTask?.title ?? "Task")
        const ticketKey = taskPayload.ticket_key ?? "A task"
        const link = ingress ? `\n\n[Open ${ticketKey} in Meitheal →](${ingress})` : ""
        let displayName = assignee.replace(/^(ha_|custom_)/, "")
        try {
          if (assignee.startsWith("ha_")) {
            const { listHAUsers } = await import("@domains/ha")
            const haUsers = await listHAUsers()
            const match = haUsers.find(u => `ha_${u.id}` === assignee)
            if (match?.name) displayName = match.name
          } else if (assignee.startsWith("custom_")) {
            const name = await repo.getCustomUserName(assignee)
            if (name) displayName = name
          }
        } catch { /* fallback to stripped ID */ }
        const badge = await repo.getOpenTaskCount().catch(() => undefined)
        // "Handed back" only when the agent gives up a task it held; otherwise it is an ordinary assignment.
        const agentName = handedBackByAgent ? agentActivityActor(locals)?.actor : undefined
        dispatchNotification(
          agentName ? `↩️ Handed back by ${agentName}: ${titleStr}` : `📋 Task assigned: ${titleStr}`,
          agentName
            ? `${agentName} handed ${ticketKey} back to ${displayName}.${link}`
            : `${ticketKey} has been assigned to ${displayName}.${link}`,
          `meitheal_assigned_${resolvedId}`,
          ingress,
          resolvedId,
          { ...(badge === undefined ? {} : { badgeCount: badge }) },
        ).catch(() => {})
      }).catch(() => {})
    } else if (!assignee && handedBackByAgent && agentActivityActor(locals)) {
      // An agent gave the task up without naming anyone, so someone has to pick it up.
      const agentName = agentActivityActor(locals)!.actor
      import("@lib/ha-app-link").then(async ({ homeAssistantWorkLink }) => {
        const ingress = await homeAssistantWorkLink(scope.boardId, resolvedId)
        const titleStr = typeof sanitized.title === "string" ? sanitized.title : String(oldTask?.title ?? "Task")
        const ticketKey = taskPayload.ticket_key ?? "A task"
        const link = ingress ? `\n\n[Open ${ticketKey} in Meitheal →](${ingress})` : ""
        dispatchNotification(
          `↩️ Handed back by ${agentName}: ${titleStr}`,
          `${agentName} handed ${ticketKey} back. It is now unassigned.${link}`,
          `meitheal_assigned_${resolvedId}`,
          ingress,
          resolvedId,
        ).catch(() => {})
      }).catch(() => {})
    }
  }

  // Auto-dismiss all notifications when task is marked done/complete
  if (notifPrefs.enabled && newlyCompleted) {
    dismissMobileNotification(`meitheal_urgent_${resolvedId}`)
    dismissMobileNotification(`meitheal_assigned_${resolvedId}`)
    dismissMobileNotification(`meitheal_due_${resolvedId}`)
    if (notifPrefs.channels.sidebar !== false) {
      getHAServices().then(async ({ callHAService, getHAConfiguration }) => {
        if (!await getHAConfiguration()) return
        callHAService("persistent_notification", "dismiss", { notification_id: `meitheal_urgent_${resolvedId}` }, undefined, { operationAllowed: () => notificationOperationAllowed(scope, "persistent_notification.dismiss", { resource: "task", action: "edit" }, resolvedId, undefined, updatedRow.task_version) }).catch(() => {})
        callHAService("persistent_notification", "dismiss", { notification_id: `meitheal_assigned_${resolvedId}` }, undefined, { operationAllowed: () => notificationOperationAllowed(scope, "persistent_notification.dismiss", { resource: "task", action: "edit" }, resolvedId, undefined, updatedRow.task_version) }).catch(() => {})
        callHAService("persistent_notification", "dismiss", { notification_id: `meitheal_due_${resolvedId}` }, undefined, { operationAllowed: () => notificationOperationAllowed(scope, "persistent_notification.dismiss", { resource: "task", action: "edit" }, resolvedId, undefined, updatedRow.task_version) }).catch(() => {})
      }).catch(() => {})
    }
  }

  if (newlyCompleted) {
    dispatchTaskEvent("task.completed", { ...taskPayload, completed_at: new Date().toISOString() }, requestId || undefined, undefined, undefined, authority, scope).catch(() => {})
    try {
      const { getFeatureFlags } = await import("../../../lib/feature-flags")
      const flags = await getFeatureFlags()
      if (flags.gamification !== false) {
        const { completeTaskGamification, getXpForPriority, getLevel } = await import("@domains/gamification")
        const xp = getXpForPriority(Number(updatedRow.priority ?? 3))
        const { stats, achievements } = await completeTaskGamification(scope, xp)
        if (stats && achievements) {
          taskPayload.gamification = { stats, xp, newAchievements: achievements.newlyUnlocked, level: getLevel(stats.totalPoints), confetti: Boolean(flags.confetti) }
        }
      }
    } catch {
      // The task write succeeded. Optional statistics must not invent a failed mutation.
      taskPayload.gamification = { error: "Task saved; completion statistics unavailable" }
    }
    if (update.successor) {
      const { id, title, dueDate, rule, ticketNumber } = update.successor
      dispatchTaskEvent("task.created", {
        id, title, status: STATUS.PENDING,
        due_date: dueDate, recurrence_rule: rule,
        ticket_key: formatTicketKey(ticketNumber),
      }, undefined, undefined, undefined, undefined, scope).catch(() => {})
    }

    // Phase 6: Cascade completion — complete all subtasks when parent is completed
    try {
      const childIds = await repo.cascadeCompleteIds(resolvedId, expectedAssignedTo)
      for (const childId of childIds) {
        dispatchTaskEvent("task.updated", { id: childId, status: STATUS.COMPLETE }, undefined, undefined, undefined, undefined, scope).catch(() => {})
      }
    } catch (err) {
      logApiError("cascade-complete", "Failed to cascade-complete subtasks", err)
    }
  }

  const responseBody = canReadTask
    ? taskPayload
    : {
        id: updatedRow.id,
        ticket_key: taskPayload.ticket_key,
        status: updatedRow.status,
        assigned_to: updatedRow.assigned_to ?? null,
      }

  return new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...authority,
    },
  })
})

export const DELETE: APIRoute = withBoardScope({ resource: "task", action: "delete" }, async ({ params, request, locals }, scope) => {
  const boardSelection = await rejectBoardSelectionInJson(request.clone())
  if (boardSelection) return boardSelection
  await ensureSchema()
  const repo = new TaskRepository(getPersistenceClient(), scope)

  const body: unknown = await request.clone().json().catch(() => null)
  const version = body && typeof body === "object" && "version" in body ? body.version : undefined
  if (version !== undefined && (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0)) return apiError("Use a current task version.", 400)
  const outcome = await repo.deleteWorkCommand(params.id!, { ...(typeof version === "number" ? { version } : {}), ...(locals.writeAbortSignal ? { signal: locals.writeAbortSignal } : {}) })
  if (!outcome.ok) return apiError("This task could not be deleted.", outcome.errorCode === "unavailable" ? 404 : 409)
  const authority = await taskEventAuthorityHeaders(["task.deleted"], scope)
  dispatchTaskEvent("task.deleted", { id: outcome.id }, undefined, undefined, outcome.eventId, authority, scope).catch(() => {})

  return new Response(null, { status: 204, headers: authority })
})

/** PATCH is an alias for PUT — some client-side callers use PATCH for partial updates */
export const PATCH = PUT
