import type { APIRoute } from "astro"
import { deriveEisenhowerQuadrant, VALID_TASK_TYPES, type TaskType } from "@meitheal/domain-tasks"
import { normalizeLabelTitle, taskLabelInsert } from "@domains/labels"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { taskAddedActivity } from "@domains/tasks/persistence/recent-activity"
import { taskInsertStatement, TaskRepository } from "@domains/tasks/persistence/task-repository"
import { dispatchTaskCreation, prepareTaskCreation, taskCreationPayload } from "@domains/tasks/task-creation-service"
import { formatTicketKey } from "../../../lib/ticket-key"
import { logApiError } from "../../../lib/api-logger"
import { isDbUnavailable, db503Response } from "../../../lib/db-fallback"
import { apiError } from "../../../lib/api-response"
import { normalizeStatus } from "../../../lib/status-config"
import { resolveRecentActivityActor } from "../../../lib/recent-activity-actor"
import { taskEventAuthorityHeaders } from "../../../lib/webhook-dispatcher"

/** GET /api/tasks — list all tasks, POST /api/tasks — create a task */

export const GET: APIRoute = async ({ url }) => {
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
    findOpts.dueDate = dueDate
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

export const POST: APIRoute = async ({ request, locals }) => {
  await ensureSchema()
  const client = getPersistenceClient()
  const repo = new TaskRepository(client)
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const prepared = await prepareTaskCreation(repo, body)
  if (!prepared.ok) return Response.json({ error: prepared.error }, { status: 400 })

  const now = Date.now()
  const activity = taskAddedActivity(prepared.task.id, resolveRecentActivityActor(locals), now)
  const statements = [taskInsertStatement(prepared.task, now), activity]
  if (body.new_labels !== undefined) {
    if (locals.agentToken) return apiError("Creating labels with a task requires a browser session.", 403)
    const labels: unknown = body.new_labels
    const selected: string[] = JSON.parse(prepared.task.labels)
    if (!Array.isArray(labels) || labels.length > 32 || !labels.every(
      name => typeof name === "string" && name && normalizeLabelTitle(name) === name && selected.includes(name),
    )) return apiError("Provide the new labels selected for this task.", 400)

    const requestId = crypto.randomUUID()
    statements[0] = taskInsertStatement(prepared.task, now, { requestId })
    statements.push(...[...new Set<string>(labels)].map(name => taskLabelInsert(name, prepared.task.id, requestId)))
  }
  const [inserted] = await client.batch(statements, "write")
  const ticketNumber = Number(inserted!.rows[0]!.ticket_number)
  const payload = taskCreationPayload(prepared.task, ticketNumber, now)
  const authority = await taskEventAuthorityHeaders(["task.created"])
  dispatchTaskCreation(payload, typeof body.request_id === "string" ? body.request_id : undefined, undefined, authority)
  return Response.json(payload, { status: 201, headers: authority })
}

export const DELETE: APIRoute = async ({ url }) => {
  try {
    const purge = url.searchParams.get("purge")
    if (purge !== "all") {
      return new Response(JSON.stringify({ error: "Use ?purge=all to confirm purge" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    }
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
