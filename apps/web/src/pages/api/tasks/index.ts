import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { sanitize } from "../../../lib/sanitize"
import { formatTicketKey } from "../../../lib/ticket-key"
import { dispatchTaskEvent } from "../../../lib/webhook-dispatcher"
import { logApiError } from "../../../lib/api-logger"
import { isDbUnavailable, db503Response } from "../../../lib/db-fallback"
import { normalizeStatus, STATUS } from "../../../lib/status-config"
import { VALID_TASK_TYPES } from "@meitheal/domain-tasks"
import type { TaskType } from "@meitheal/domain-tasks"
import { isValidTaskKind } from "@meitheal/domain-tasks"

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
  if (status) findOpts.status = normalizeStatus(status)
  const priority = url.searchParams.get("priority")
  if (priority) {
    const parsedPriority = Math.min(5, Math.max(1, Number(priority) || 0))
    if (parsedPriority > 0) findOpts.priority = parsedPriority
  }
  const areaId = url.searchParams.get("area_id")
  if (areaId) findOpts.areaId = areaId
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
      status: r.status,
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
      created_at: r.created_at,
      updated_at: r.updated_at,
    }
  })

  return new Response(JSON.stringify({ tasks, total, limit, offset }), {
    status: 200,
    headers: { "content-type": "application/json" },
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

export const POST: APIRoute = async ({ request }) => {
  await ensureSchema()
  const repo = new TaskRepository(getPersistenceClient())
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

  // OA-604: Input sanitization
  const rawTitle = typeof body.title === "string" ? body.title.trim() : ""
  const title = sanitize(rawTitle)
  if (!title) {
    return new Response(JSON.stringify({ error: "title is required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })
  }
  if (title.length > 500) {
    return new Response(JSON.stringify({ error: "title must be 500 characters or less" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })
  }

  const id = crypto.randomUUID()

  // Assign next sequential ticket_number for human-readable key (MTH-N)
  const ticket_number = await repo.getNextTicketNumber()

  // Validate priority (1-5)
  const rawPriority = typeof body.priority === "number" ? body.priority : 3
  const priority = Math.min(5, Math.max(1, Math.round(rawPriority)))

  // Sanitize description (strip HTML tags like title)
  const rawDesc = typeof body.description === "string" ? body.description.slice(0, 10000) : ""
  const description = sanitize(rawDesc)

  // Validate status — any non-empty alphanumeric/underscore string up to 50 chars
  const rawStatus = typeof body.status === "string" ? body.status.trim().toLowerCase().replace(/[^a-z0-9_]/g, "") : ""
  const status = rawStatus && rawStatus.length <= 50 ? rawStatus : STATUS.PENDING

  const due_date = typeof body.due_date === "string" ? body.due_date : null
  // Validate labels is valid JSON array of strings
  let labels = "[]"
  if (body.labels !== undefined) {
    if (typeof body.labels !== "string") {
      return new Response(JSON.stringify({ error: "labels must be a JSON string array" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    try {
      const parsed = JSON.parse(body.labels)
      if (!Array.isArray(parsed) || !parsed.every(item => typeof item === "string")) throw new Error()
      labels = body.labels
    } catch {
      return new Response(JSON.stringify({ error: "labels must be a valid JSON string array" }), { status: 400, headers: { "content-type": "application/json" } })
    }
  }

  // Validate framework_payload is valid JSON object
  let framework_payload = "{}"
  if (body.framework_payload !== undefined) {
    if (typeof body.framework_payload !== "string") {
      return new Response(JSON.stringify({ error: "framework_payload must be a JSON string" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    try {
      const parsed = JSON.parse(body.framework_payload)
      if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) throw new Error()
      framework_payload = body.framework_payload
    } catch {
      return new Response(JSON.stringify({ error: "framework_payload must be a valid JSON object string" }), { status: 400, headers: { "content-type": "application/json" } })
    }
  }

  // Phase 20: Agile hierarchy type
  const rawTaskType = typeof body.task_type === "string" ? body.task_type.trim().toLowerCase() : "task"
  const task_type: TaskType = VALID_TASK_TYPES.includes(rawTaskType as TaskType) ? (rawTaskType as TaskType) : "task"

  // Validate parent_id (optional reference to another task)
  const parent_id = typeof body.parent_id === "string" ? body.parent_id : null

  // Phase 1: Epic→Story→Task nesting validation
  if (parent_id) {
    const parentType = await repo.getParentTaskType(parent_id)
    if (parentType === null) {
      return new Response(JSON.stringify({ error: "Parent task not found" }), {
        status: 400, headers: { "content-type": "application/json" },
      })
    }
    if (parentType === "task" && (task_type === "epic" || task_type === "story")) {
      return new Response(JSON.stringify({
        error: `Cannot nest ${task_type} under a task — tasks can only contain other tasks`,
      }), { status: 400, headers: { "content-type": "application/json" } })
    }
    if (parentType === "story" && task_type === "epic") {
      return new Response(JSON.stringify({
        error: "Cannot nest an epic under a story — stories can only contain tasks",
      }), { status: 400, headers: { "content-type": "application/json" } })
    }
  }

  // Area and custom fields
  const area_id = typeof body.area_id === "string" ? body.area_id : "default"

  let custom_fields = "{}"
  if (body.custom_fields !== undefined) {
    if (typeof body.custom_fields !== "string") {
      return new Response(JSON.stringify({ error: "custom_fields must be a JSON string" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    try {
      const parsed = JSON.parse(body.custom_fields)
      if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) throw new Error()
      custom_fields = body.custom_fields
    } catch {
      return new Response(JSON.stringify({ error: "custom_fields must be a valid JSON object string" }), { status: 400, headers: { "content-type": "application/json" } })
    }
  }

  // Phase 18: Extended fields
  const start_date = typeof body.start_date === "string" ? body.start_date : null
  const end_date = typeof body.end_date === "string" ? body.end_date : null
  const progress_raw = typeof body.progress === "number" ? body.progress : 0
  const progress = Math.min(100, Math.max(0, Math.round(progress_raw)))
  const color = typeof body.color === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(body.color) ? body.color : null
  const is_favorite = body.is_favorite ? 1 : 0

  // Assignments: assigned_to user ID (nullable)
  let assigned_to: string | null = typeof body.assigned_to === "string" ? body.assigned_to.trim() : null
  if (assigned_to && assigned_to.length > 255) assigned_to = null

  // Auto-assign from default if not specified
  if (!assigned_to) {
    assigned_to = await repo.getDefaultAssignee()
  }

  // Phase 31: Checklists
  let checklists = "[]"
  if (body.checklists !== undefined) {
    if (typeof body.checklists !== "string") {
      return new Response(JSON.stringify({ error: "checklists must be a JSON string" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    try {
      const parsed = JSON.parse(body.checklists)
      if (!Array.isArray(parsed)) throw new Error()
      checklists = body.checklists
    } catch {
      return new Response(JSON.stringify({ error: "checklists must be a valid JSON array string" }), { status: 400, headers: { "content-type": "application/json" } })
    }
  }

  // Phase 04.1: Task kind (behavioral classification)
  const rawTaskKind = typeof body.task_kind === "string" ? body.task_kind.trim().toLowerCase() : "standard_action"
  const task_kind = isValidTaskKind(rawTaskKind) ? rawTaskKind : "standard_action"

  const project_id = typeof body.project_id === "string" ? body.project_id : null

  await repo.createTask({
    id, title, description, status, priority, due_date, labels,
    framework_payload, parent_id, area_id, custom_fields, project_id,
    start_date, end_date, progress, color, is_favorite,
    task_type, task_kind, ticket_number, assigned_to, checklists,
  })

  const now = Date.now()
  const ticket_key = formatTicketKey(ticket_number)
  const taskPayload = { id, ticket_number, ticket_key, title, description, status, priority, due_date, labels, parent_id, area_id, project_id, custom_fields, time_tracked: 0, start_date, end_date, progress, color, is_favorite, task_type, task_kind, assigned_to, created_at: now, updated_at: now }

  dispatchTaskEvent("task.created", taskPayload, typeof body.request_id === "string" ? body.request_id : undefined).catch(() => {})

  // Phase 52: Native Push Notification for Urgent (P1) tasks
  if (priority === 1) {
    import("../../../domains/ha/ha-services").then(({ sendNotification }) => {
      sendNotification("notify", `🚨 Urgent Task: ${title}`, description.slice(0, 100) || "Needs immediate attention.", {
        push: { category: "URGENT_TASK" },
        action_data: { task_id: id, ticket_key },
        actions: [
          { action: `MEITHEAL_TASK_DONE_${id}`, title: "Mark Done" },
          { action: `MEITHEAL_TASK_VIEW_${id}`, title: "View details", uri: `/meitheal/task/${ticket_key}` }
        ]
      }).catch(err => logApiError("ha-notify", "Failed to send urgent task push", err))
    }).catch(() => {})
  }

  return new Response(JSON.stringify(taskPayload), {
    status: 201,
    headers: { "content-type": "application/json" },
  })
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
