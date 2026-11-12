import {
  deriveEisenhowerQuadrant,
  isValidEffortMinutes,
  isValidEffortType,
  isValidImportance,
  isValidTaskKind,
  isValidUrgency,
  VALID_TASK_TYPES,
  type TaskType,
} from "@meitheal/domain-tasks"
import { logApiError } from "../../lib/api-logger"
import { normalizeStatus, STATUS } from "../../lib/status-config"

/**
 * Accept labels as an array of strings or as a JSON-encoded string array.
 * Automation callers (n8n, MCP) send arrays; the browser sends JSON strings.
 * Returns the JSON string to store, or null when the value is not a string array.
 */
export function taskLabelsJson(value: unknown): string | null {
  let parsed: unknown = value
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) } catch { return null }
  }
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === "string")) return null
  return JSON.stringify(parsed)
}
import { formatTicketKey } from "../../lib/ticket-key"
import { dispatchTaskEvent } from "../../lib/webhook-dispatcher"
import type { TaskCreationData, TaskRepository } from "./persistence/task-repository"

export async function prepareTaskCreation(
  repo: TaskRepository,
  body: Record<string, unknown>,
  { id = crypto.randomUUID(), useDefaultAssignee = true } = {},
): Promise<{ ok: true; task: TaskCreationData } | { ok: false; error: string }> {
  // OA-604: Input sanitization
  const { sanitize } = await import("../../lib/sanitize")
  const rawTitle = typeof body.title === "string" ? body.title.trim() : ""
  const title = sanitize(rawTitle)
  if (!title) return { ok: false, error: "title is required" }
  if (title.length > 500) return { ok: false, error: "title must be 500 characters or less" }

  // Validate priority (1-5)
  const rawPriority = typeof body.priority === "number" ? body.priority : 3
  const priority = Math.min(5, Math.max(1, Math.round(rawPriority)))

  // Sanitize description (strip HTML tags like title)
  if (typeof body.description === "string" && body.description.length > 10000) {
    return { ok: false, error: "description must be 10000 characters or less" }
  }
  const rawDesc = typeof body.description === "string" ? body.description : ""
  const description = sanitize(rawDesc)

  // Validate status — any non-empty alphanumeric/underscore string up to 50 chars
  const rawStatus = typeof body.status === "string" ? body.status.trim().toLowerCase().replace(/[^a-z0-9_]/g, "") : ""
  const status = rawStatus && rawStatus.length <= 50 ? normalizeStatus(rawStatus) : STATUS.PENDING

  const due_date = typeof body.due_date === "string" ? body.due_date : null
  let labels = "[]"
  if (body.labels !== undefined) {
    const parsed = taskLabelsJson(body.labels)
    if (parsed === null) return { ok: false, error: "labels must be an array of strings or a JSON string array" }
    labels = parsed
  }

  // Validate framework_payload is valid JSON object
  let framework_payload = "{}"
  if (body.framework_payload !== undefined) {
    if (typeof body.framework_payload !== "string") {
      return { ok: false, error: "framework_payload must be a JSON string" }
    }
    try {
      const parsed = JSON.parse(body.framework_payload)
      if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) throw new Error()
      framework_payload = body.framework_payload
    } catch {
      return { ok: false, error: "framework_payload must be a valid JSON object string" }
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
    if (parentType === null) return { ok: false, error: "Parent task not found" }
    if (parentType === "task" && (task_type === "epic" || task_type === "story")) {
      return { ok: false, error: `Cannot nest ${task_type} under a task — tasks can only contain other tasks` }
    }
    if (parentType === "story" && task_type === "epic") {
      return { ok: false, error: "Cannot nest an epic under a story — stories can only contain tasks" }
    }
  }

  // Area and custom fields
  const area_id = typeof body.area_id === "string" ? body.area_id : "default"

  let custom_fields = "{}"
  if (body.custom_fields !== undefined) {
    if (typeof body.custom_fields !== "string") {
      return { ok: false, error: "custom_fields must be a JSON string" }
    }
    try {
      const parsed = JSON.parse(body.custom_fields)
      if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) throw new Error()
      custom_fields = body.custom_fields
    } catch {
      return { ok: false, error: "custom_fields must be a valid JSON object string" }
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
  if (!assigned_to && useDefaultAssignee) {
    assigned_to = await repo.getDefaultAssignee()
  }

  // Phase 31: Checklists
  let checklists = "[]"
  if (body.checklists !== undefined) {
    if (typeof body.checklists !== "string") {
      return { ok: false, error: "checklists must be a JSON string" }
    }
    try {
      const parsed = JSON.parse(body.checklists)
      if (!Array.isArray(parsed)) throw new Error()
      checklists = body.checklists
    } catch {
      return { ok: false, error: "checklists must be a valid JSON array string" }
    }
  }

  // Phase 04.1: Task kind (behavioral classification)
  const rawTaskKind = typeof body.task_kind === "string" ? body.task_kind.trim().toLowerCase() : "standard_action"
  const task_kind = isValidTaskKind(rawTaskKind) ? rawTaskKind : "standard_action"

  const project_id = typeof body.project_id === "string" ? body.project_id : null
  const goal_id = typeof body.goal_id === "string" ? body.goal_id : null

  // Phase 06: Eisenhower urgency/importance (0-5, default 0 = unclassified)
  const rawUrgency = typeof body.urgency === "number" ? body.urgency : 0
  const urgency = isValidUrgency(Math.round(rawUrgency)) ? Math.round(rawUrgency) : 0
  const rawImportance = typeof body.importance === "number" ? body.importance : 0
  const importance = isValidImportance(Math.round(rawImportance)) ? Math.round(rawImportance) : 0

  // Phase 07: Extended planning fields — effort, blocked_by
  const rawEffortMinutes = body.effort_minutes != null ? Number(body.effort_minutes) : null
  const effort_minutes = isValidEffortMinutes(rawEffortMinutes) ? rawEffortMinutes : null
  const rawEffortType = typeof body.effort_type === "string" ? body.effort_type.trim().toLowerCase() : null
  const effort_type = isValidEffortType(rawEffortType) ? rawEffortType : null
  const blocked_by = typeof body.blocked_by === "string" && body.blocked_by.trim().length > 0
    ? body.blocked_by.trim().slice(0, 500) : null

  // Recurrence rule (RRULE string, e.g. "FREQ=DAILY")
  const rawRecurrence = typeof body.recurrence_rule === "string" ? body.recurrence_rule.trim() : ""
  const recurrence_rule = rawRecurrence && /^[A-Z=;,0-9]+$/.test(rawRecurrence) && rawRecurrence.length <= 200
    ? rawRecurrence : null

  const rawSource = typeof body.source === "string" ? body.source.trim() : null
  const source = rawSource ? rawSource.slice(0, 50) : "user"
  const created_by = typeof body.created_by === "string" ? body.created_by.trim().slice(0, 100) : null

  return { ok: true, task: {
    id, title, description, status, priority, due_date, labels,
    framework_payload, parent_id, area_id, custom_fields, project_id, goal_id,
    start_date, end_date, progress, color, is_favorite,
    task_type, task_kind, assigned_to, checklists,
    urgency, importance, effort_minutes, effort_type, blocked_by,
    recurrence_rule, source, created_by,
  } }
}

export function taskCreationPayload(task: TaskCreationData, ticket_number: number, now: number) {
  const {
    id, title, description, status, priority, due_date, labels, parent_id, area_id, project_id, goal_id,
    custom_fields, start_date, end_date, progress, color, is_favorite, task_type, task_kind,
    assigned_to, urgency, importance, effort_minutes, effort_type, blocked_by, source, created_by,
  } = task
  return {
    id, ticket_number, ticket_key: formatTicketKey(ticket_number), title, description, status, priority,
    due_date, labels, parent_id, area_id, project_id, goal_id, custom_fields, time_tracked: 0, start_date,
    end_date, progress, color, is_favorite, task_type, task_kind, assigned_to, urgency, importance,
    effort_minutes, effort_type, blocked_by, source: source ?? "user", created_by: created_by ?? null,
    eisenhower_quadrant: deriveEisenhowerQuadrant(urgency ?? 0, importance ?? 0),
    eisenhower_override: 0, created_at: now, updated_at: now,
  }
}

export function dispatchTaskCreation(
  taskPayload: ReturnType<typeof taskCreationPayload>,
  requestId?: string,
  eventId?: string,
  responseAuthority?: Record<string, string>,
) {
  const { id, ticket_key, title, description, priority } = taskPayload
  dispatchTaskEvent("task.created", taskPayload, requestId, undefined, eventId, responseAuthority).catch(() => {})

  // Phase 52: Native Push Notification for Urgent (P1) tasks
  if (priority === 1) {
    import("../ha/ha-services").then(({ sendNotification }) => {
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
}
