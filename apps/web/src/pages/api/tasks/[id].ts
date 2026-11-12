import type { APIRoute } from "astro"
import type { InValue } from "@libsql/client"
import { hasBoardSelection, rejectBoardSelectionInJson, unavailableBoardResponse } from "@domains/tasks/board-availability"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { UserRepository } from "@domains/tasks/persistence/user-repository"
import { formatTicketKey } from "../../../lib/ticket-key"
import { dispatchTaskEvent, taskEventAuthorityHeaders } from "../../../lib/webhook-dispatcher"
import { logApiError } from "../../../lib/api-logger"
import { apiError } from "../../../lib/api-response"
import { db503Response, isDbUnavailable } from "../../../lib/db-fallback"
import { resolveRecentActivityActor } from "../../../lib/recent-activity-actor"
import { STATUS, normalizeStatus, isDoneStatus } from "../../../lib/status-config"
import { VALID_TASK_TYPES } from "@meitheal/domain-tasks"
import type { TaskType } from "@meitheal/domain-tasks"


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

export const GET: APIRoute = async ({ params, url }) => {
  await ensureSchema()
  const repo = new TaskRepository(getPersistenceClient())
  const headers = {
    "content-type": "application/json",
    ...(url.searchParams.has("deferralRead") ? { "cache-control": "no-store" } : {}),
  }

  const row = await repo.findById(params.id!)
  if (!row) {
    return new Response(JSON.stringify({ error: "Task not found" }), {
      status: 404,
      headers,
    })
  }

  // Derive human-readable ticket keys
  const ticketNum = row.ticket_number != null ? Number(row.ticket_number) : null
  const parentTicketNum = row.parent_ticket_number != null ? Number(row.parent_ticket_number) : null
  const enriched = {
    ...row,
    is_promoted: Boolean(row.is_promoted),
    ticket_key: formatTicketKey(ticketNum),
    parent_ticket_key: formatTicketKey(parentTicketNum),
  }

  return new Response(JSON.stringify(enriched), {
    status: 200,
    headers,
  })
}

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  if (hasBoardSelection(body)) return unavailableBoardResponse()
  await ensureSchema()
  const repo = new TaskRepository(getPersistenceClient())

  // Resolve task ID (supports UUID and MTH-N format)
  const resolved = await repo.resolveTaskId(params.id!)
  if (!resolved) {
    return new Response(JSON.stringify({ error: "Task not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })
  }

  const resolvedId = resolved.id

  const agentToken = locals.agentToken
  if (agentToken && agentToken.scopes.includes("tasks:write:assigned") && !agentToken.scopes.includes("tasks:write")) {
    const task = await repo.findById(resolvedId)
    if (!task || !agentToken.assigneeId || task.assigned_to !== agentToken.assigneeId) {
      return new Response(JSON.stringify({ error: "Agent can only update tasks assigned to it" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    }
  }

  const clientVersion = typeof body.updated_at === "number" ? body.updated_at : undefined
  if (clientVersion !== undefined && (!Number.isSafeInteger(clientVersion) || clientVersion < 0)) {
    return apiError("updated_at must be a non-negative safe integer", 400)
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

  if (typeof body.title === "string" || typeof body.description === "string") {
    const { sanitize } = await import("../../../lib/sanitize")
    if (typeof body.title === "string") {
      const t = sanitize(body.title.trim())
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
      sanitized.description = sanitize(body.description)
    }
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
  if (typeof body.priority === "number") {
    sanitized.priority = Math.min(5, Math.max(1, Math.round(body.priority)))
  }
  if (body.due_date !== undefined) {
    sanitized.due_date = typeof body.due_date === "string" ? body.due_date : null
  }
  if (body.labels !== undefined) {
    if (typeof body.labels !== "string") {
      return new Response(JSON.stringify({ error: "labels must be a JSON string array" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    try {
      const parsed = JSON.parse(body.labels)
      if (!Array.isArray(parsed) || !parsed.every(item => typeof item === "string")) throw new Error()
      sanitized.labels = body.labels
    } catch {
      return new Response(JSON.stringify({ error: "labels must be a valid JSON string array" }), { status: 400, headers: { "content-type": "application/json" } })
    }
  }
  if (body.framework_payload !== undefined) {
    if (typeof body.framework_payload !== "string") {
      return new Response(JSON.stringify({ error: "framework_payload must be a JSON string" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    try {
      const parsed = JSON.parse(body.framework_payload)
      if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) throw new Error()
      sanitized.framework_payload = body.framework_payload
    } catch {
      return new Response(JSON.stringify({ error: "framework_payload must be a valid JSON object string" }), { status: 400, headers: { "content-type": "application/json" } })
    }
  }
  if (body.custom_fields !== undefined) {
    if (typeof body.custom_fields !== "string") {
      return new Response(JSON.stringify({ error: "custom_fields must be a JSON string" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    try {
      const parsed = JSON.parse(body.custom_fields)
      if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) throw new Error()
      sanitized.custom_fields = body.custom_fields
    } catch {
      return new Response(JSON.stringify({ error: "custom_fields must be a valid JSON object string" }), { status: 400, headers: { "content-type": "application/json" } })
    }
  }
  if (typeof body.area_id === "string") {
    sanitized.area_id = body.area_id
  }
  if (body.project_id !== undefined) {
    if (body.project_id !== null && (typeof body.project_id !== "string" || !body.project_id.trim())) {
      return apiError("project_id must be a project ID or null", 400)
    }
    sanitized.project_id = body.project_id
  }
  if (body.start_date !== undefined) {
    sanitized.start_date = typeof body.start_date === "string" ? body.start_date : null
  }
  if (body.end_date !== undefined) {
    sanitized.end_date = typeof body.end_date === "string" ? body.end_date : null
  }
  if (typeof body.progress === "number") {
    sanitized.progress = Math.min(100, Math.max(0, Math.round(body.progress)))
  }
  if (body.color !== undefined) {
    sanitized.color = typeof body.color === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(body.color) ? body.color : null
  }
  if (body.is_favorite !== undefined) {
    sanitized.is_favorite = body.is_favorite ? 1 : 0
  }
  if (body.is_promoted !== undefined) {
    if (typeof body.is_promoted !== "boolean") return apiError("is_promoted must be a boolean", 400)
    sanitized.is_promoted = body.is_promoted ? 1 : 0
  }
  if (typeof body.parent_id === "string" || body.parent_id === null) {
    sanitized.parent_id = body.parent_id
  }
  // Phase 1: Epic→Story→Task nesting validation on parent_id change
  if (sanitized.parent_id !== undefined && sanitized.parent_id !== null) {
    const parentType = await repo.getParentTaskType(String(sanitized.parent_id))
    if (parentType === null) {
      return new Response(JSON.stringify({ error: "Parent task not found" }), {
        status: 400, headers: { "content-type": "application/json" },
      })
    }
    // Determine child type: use sanitized.task_type if changing, else fetch current
    let childType = typeof sanitized.task_type === "string" ? sanitized.task_type : null
    if (!childType) {
      const current = await repo.findById(resolvedId)
      childType = String(current?.task_type ?? "task")
    }
    if (parentType === "task" && (childType === "epic" || childType === "story")) {
      return new Response(JSON.stringify({
        error: `Cannot nest ${childType} under a task — tasks can only contain other tasks`,
      }), { status: 400, headers: { "content-type": "application/json" } })
    }
    if (parentType === "story" && childType === "epic") {
      return new Response(JSON.stringify({
        error: "Cannot nest an epic under a story — stories can only contain tasks",
      }), { status: 400, headers: { "content-type": "application/json" } })
    }
  }
  if (typeof body.time_tracked === "number") {
    sanitized.time_tracked = Math.max(0, Math.round(body.time_tracked))
  }
  if (typeof body.task_type === "string") {
    const tt = body.task_type.trim().toLowerCase()
    if (VALID_TASK_TYPES.includes(tt as TaskType)) {
      sanitized.task_type = tt
    }
  }
  if (body.assigned_to !== undefined) {
    sanitized.assigned_to = typeof body.assigned_to === "string" && body.assigned_to.trim().length > 0 && body.assigned_to.length <= 255
      ? body.assigned_to.trim() : null
  }
  if (body.owner !== undefined && typeof body.owner === "string") {
    sanitized.owner = body.owner.slice(0, 100)
  } else if (sanitized.assigned_to !== undefined) {
    if (sanitized.assigned_to === null) {
      sanitized.owner = "human"
    } else if (sanitized.assigned_to.startsWith("custom_")) {
      const userRepo = new UserRepository(getPersistenceClient())
      const customUser = await userRepo.getCustomUser(sanitized.assigned_to)
      if (customUser?.kind === "agent") {
        sanitized.owner = `bot:${customUser.name}`
      } else {
        sanitized.owner = "human"
      }
    }
  }
  // Guard the same raw checklist returned by GET. Legacy clients may omit the guard.
  const expectedChecklists = body.expected_checklists
  if (expectedChecklists !== undefined &&
      ((expectedChecklists !== null && typeof expectedChecklists !== "string") || body.checklists === undefined)) {
    return apiError("expected_checklists requires the prior checklist string or null and a replacement checklist", 400)
  }
  if (body.checklists !== undefined) {
    if (typeof body.checklists !== "string") {
      return new Response(JSON.stringify({ error: "checklists must be a JSON string array" }), { status: 400, headers: { "content-type": "application/json" } })
    }
    try {
      const parsed = JSON.parse(body.checklists)
      if (!Array.isArray(parsed)) throw new Error()
      for (const item of parsed) {
        if (typeof item !== "object" || item === null) throw new Error()
        if (typeof item.text !== "string") throw new Error()
        if (typeof item.done !== "boolean") throw new Error()
      }
      sanitized.checklists = body.checklists
    } catch {
      return new Response(JSON.stringify({ error: "checklists must be a valid JSON array of {text, done} objects" }), { status: 400, headers: { "content-type": "application/json" } })
    }
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
  if (typeof body.urgency === "number") {
    sanitized.urgency = Math.min(5, Math.max(0, Math.round(body.urgency)))
  }
  if (typeof body.importance === "number") {
    sanitized.importance = Math.min(5, Math.max(0, Math.round(body.importance)))
  }
  if (body.eisenhower_override !== undefined) {
    sanitized.eisenhower_override = body.eisenhower_override ? 1 : 0
  }

  // Phase 07: Extended planning fields — effort, blocked_by
  if (body.effort_minutes !== undefined) {
    if (body.effort_minutes === null) {
      sanitized.effort_minutes = null
    } else if (typeof body.effort_minutes === "number") {
      sanitized.effort_minutes = Math.min(480, Math.max(1, Math.round(body.effort_minutes)))
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

  if (Object.keys(sanitized).length === 0) {
    return new Response(JSON.stringify({ error: "No fields to update" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })
  }

  // Fetch old values for activity log diffing
  const oldTask = await repo.getFieldsForDiff(resolvedId)

  // Perform the update via repository
  const version = clientVersion === undefined ? undefined : {
    updatedAt: clientVersion,
    ...(body.expected_status === STATUS.BACKLOG ? { expectedStatus: STATUS.BACKLOG } : {}),
  }
  const completionIntent = typeof sanitized.status === "string" && isDoneStatus(sanitized.status)
  let update
  try {
    update = await repo.updateTask(resolvedId, sanitized, {
      activity: resolveRecentActivityActor(locals),
      ...(version ? { version } : {}),
      ...(expectedChecklists !== undefined ? { expectedChecklists } : {}),
    })
  } catch (err) {
    if (!completionIntent) throw err
    const code = err && typeof err === "object" && "code" in err ? err.code : undefined
    if (code === "TRANSACTION_ACTIVE" || code === "SQLITE_BUSY" || isDbUnavailable(err)) {
      return db503Response("task-completion", err)
    }
    logApiError("task-completion", "Failed to save task completion", err)
    return apiError("Could not save task completion. Try again.", 500)
  }
  if (!update.ok) {
    if (update.errorCode === "conflict") {
      return taskVersionConflict(update.updatedAt, clientVersion!)
    }
    if (update.errorCode === "checklist_conflict") {
      return Response.json({
        error: "The checklist changed since your last read",
        code: "checklist_conflict",
        checklists: update.checklists,
      }, { status: 409, headers: { "cache-control": "no-store" } })
    }
    if (update.errorCode === "blocked") {
      return new Response(JSON.stringify({
        error: "Cannot activate: task is blocked by open dependencies",
        errorCode: "TASK_BLOCKED",
        blocked_by: update.blockers.map(({ id, title, status, ticket_number }) => ({
          id,
          title,
          status,
          ticket_key: ticket_number ? formatTicketKey(Number(ticket_number)) : null,
        })),
      }), {
        status: 409,
        headers: { "content-type": "application/json" },
      })
    }
    return typeof sanitized.project_id === "string"
      ? apiError("Task or destination project is no longer available", 409)
      : apiError("Task not found", 404)
  }
  const updatedRow = update.task
  const newlyCompleted = completionIntent && !isDoneStatus(update.previousStatus ?? "")

  // Record activity log entries for each changed field
  if (oldTask) {
    const changes: Array<{ field: string; oldValue: string | null; newValue: string }> = []
    for (const [field, newVal] of Object.entries(sanitized)) {
      const oldVal = oldTask[field]
      if (String(newVal) !== String(oldVal ?? "")) {
        changes.push({ field, oldValue: oldVal != null ? String(oldVal) : null, newValue: String(newVal) })
      }
    }
    if (changes.length > 0) {
      const activityActor = agentToken ? `agent:${agentToken.tokenName}` : (request.headers.get("X-Automation-Source") ? `ha:${request.headers.get("X-Automation-Source")}` : "user")
      const actorType = agentToken ? "agent" : (request.headers.get("X-Automation-Source") ? "ha" : "user")
      repo.logActivity(resolvedId, changes, { actor: activityActor, actor_type: actorType }).catch(() => { })
    }
  }

  const updTicketNum = updatedRow.ticket_number != null ? Number(updatedRow.ticket_number) : null
  const taskPayload: Record<string, unknown> = {
    ...updatedRow,
    is_promoted: Boolean(updatedRow.is_promoted),
    ticket_key: formatTicketKey(updTicketNum),
  }

  const authority = await taskEventAuthorityHeaders([
    "task.updated",
    // The App also owns the decision not to re-emit an acknowledged completion.
    ...(completionIntent ? ["task.completed"] : []),
  ])
  dispatchTaskEvent("task.updated", taskPayload, typeof body.request_id === "string" ? body.request_id : undefined, undefined, undefined, authority).catch(() => {})

  // Notification preference guard
  const notifPrefs = await repo.getNotificationPreferences()

  // F4/F5: Load callHAService once for all notification helpers
  const haServicesImport = import("../../../domains/ha/ha-services")

  // Helper: dispatch notification to configured channels
  interface DispatchOpts { isUrgent?: boolean; badgeCount?: number }
  async function dispatchNotification(
    title: string, message: string, notifId: string,
    ingress: string | null, taskId?: string, opts: DispatchOpts = {},
  ) {
    const { callHAService } = await haServicesImport
    const promises: Promise<unknown>[] = []

    if (notifPrefs.channels.sidebar !== false) {
      promises.push(
        callHAService("persistent_notification", "create", {
          title,
          message,
          notification_id: notifId,
        }).catch(err => logApiError("ha-notify", "Failed to send sidebar notification", err))
      )
    }

    if (notifPrefs.channels.mobile_push && notifPrefs.mobileTargets.length > 0) {
      const plainMessage = message.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      const ingressPath = ingress ? ingress + "/kanban" : null

      for (const target of notifPrefs.mobileTargets) {
        const [domain, ...rest] = target.split(".")
        const service = rest.join(".")
        if (domain && service) {
          const pushData: Record<string, unknown> = {
            title,
            message: plainMessage,
            data: {
              ...(ingressPath ? { clickAction: ingressPath, url: ingressPath } : {}),
              tag: notifId,
              group: "meitheal",
              channel: opts.isUrgent ? "meitheal_urgent" : "meitheal_tasks",
              color: "#6366F1",
              ...(opts.isUrgent ? { importance: "high" } : {}),
              push: {
                "interruption-level": opts.isUrgent ? "time-sensitive" : "active",
                ...(opts.badgeCount !== undefined ? { badge: opts.badgeCount } : {}),
              },
              actions: [
                ...(ingressPath ? [{
                  action: "URI",
                  title: "Open Task",
                  uri: ingressPath,
                }] : []),
                ...(taskId ? [{
                  action: `MEITHEAL_TASK_DONE_${taskId}`,
                  title: "✅ Mark Done",
                }] : []),
              ],
            },
          }
          promises.push(
            callHAService(domain, service, pushData)
              .catch(err => logApiError("ha-notify", `Failed to send mobile push to ${target}`, err))
          )
        }
      }
    }

    return Promise.all(promises)
  }

  // Helper: dismiss mobile notifications
  async function dismissMobileNotification(notifTag: string) {
    if (!notifPrefs.channels.mobile_push || notifPrefs.mobileTargets.length === 0) return
    const { callHAService } = await haServicesImport
    for (const target of notifPrefs.mobileTargets) {
      const [domain, ...rest] = target.split(".")
      const service = rest.join(".")
      if (domain && service) {
        callHAService(domain, service, {
          message: "clear_notification",
          data: { tag: notifTag },
        }).catch(() => {})
      }
    }
  }

  // Phase 52: Notification if bumped to Urgent (P1)
  if (notifPrefs.enabled && sanitized.priority === 1 && oldTask?.priority !== 1) {
    import("../../../domains/ha/ha-connection").then(async ({ getIngressEntry }) => {
      const ingress = await getIngressEntry()
      const titleStr = typeof sanitized.title === "string" ? sanitized.title : String(oldTask?.title ?? "Task")
      const ticketKey = taskPayload.ticket_key ?? "Task"
      const link = ingress ? `\n\n[Open ${ticketKey} in Meitheal →](${ingress}/kanban)` : ""
      const badge = await repo.getOpenTaskCount()
      dispatchNotification(
        `🚨 Escalated to Urgent: ${titleStr}`,
        `${ticketKey} has been escalated to P1 — Urgent.${link}`,
        `meitheal_urgent_${resolvedId}`,
        ingress,
        resolvedId,
        { isUrgent: true, badgeCount: badge },
      ).catch(() => {})
    }).catch(() => {})
  }

  // Assignment-change notification (respects per-user prefs)
  if (notifPrefs.enabled && sanitized.assigned_to !== undefined && String(sanitized.assigned_to) !== String(oldTask?.assigned_to ?? "")) {
    const assignee = typeof sanitized.assigned_to === "string" ? sanitized.assigned_to : null
    if (assignee && !notifPrefs.disabledUsers.has(assignee)) {
      import("../../../domains/ha/ha-connection").then(async ({ getIngressEntry }) => {
        const ingress = await getIngressEntry()
        const titleStr = typeof sanitized.title === "string" ? sanitized.title : String(oldTask?.title ?? "Task")
        const ticketKey = taskPayload.ticket_key ?? "A task"
        const link = ingress ? `\n\n[Open ${ticketKey} in Meitheal →](${ingress}/kanban)` : ""
        let displayName = assignee.replace(/^(ha_|custom_)/, "")
        try {
          if (assignee.startsWith("ha_")) {
            const { listHAUsers } = await import("../../../domains/ha/ha-users")
            const haUsers = await listHAUsers()
            const match = haUsers.find(u => `ha_${u.id}` === assignee)
            if (match?.name) displayName = match.name
          } else if (assignee.startsWith("custom_")) {
            const name = await repo.getCustomUserName(assignee)
            if (name) displayName = name
          }
        } catch { /* fallback to stripped ID */ }
        const badge = await repo.getOpenTaskCount()
        dispatchNotification(
          `📋 Task assigned: ${titleStr}`,
          `${ticketKey} has been assigned to ${displayName}.${link}`,
          `meitheal_assigned_${resolvedId}`,
          ingress,
          resolvedId,
          { badgeCount: badge },
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
      haServicesImport.then(({ callHAService }) => {
        callHAService("persistent_notification", "dismiss", { notification_id: `meitheal_urgent_${resolvedId}` }).catch(() => {})
        callHAService("persistent_notification", "dismiss", { notification_id: `meitheal_assigned_${resolvedId}` }).catch(() => {})
        callHAService("persistent_notification", "dismiss", { notification_id: `meitheal_due_${resolvedId}` }).catch(() => {})
      }).catch(() => {})
    }
  }

  if (newlyCompleted) {
    dispatchTaskEvent("task.completed", { ...taskPayload, completed_at: new Date().toISOString() }, typeof body.request_id === "string" ? body.request_id : undefined, undefined, undefined, authority).catch(() => {})
    try {
      const { isFeatureEnabled } = await import("../../../lib/feature-flags")
      if (await isFeatureEnabled("gamification")) {
        const { recordTaskCompletion, getXpForPriority, checkAchievements, getLevel } = await import("@domains/gamification")
        const xp = getXpForPriority(Number(updatedRow.priority ?? 3))
        const stats = await recordTaskCompletion(xp)
        const achievements = await checkAchievements(stats)
        taskPayload.gamification = { stats, xp, newAchievements: achievements.newlyUnlocked, level: getLevel(stats.totalPoints), confetti: await isFeatureEnabled("confetti") }
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
      }).catch(() => {})
    }

    // Phase 6: Cascade completion — complete all subtasks when parent is completed
    try {
      const cascadedCount = await repo.cascadeComplete(resolvedId)
      if (cascadedCount > 0) {
        // Fire events for each cascaded child
        const childIds = await repo.getChildrenIds(resolvedId)
        for (const childId of childIds) {
          dispatchTaskEvent("task.updated", { id: childId, status: STATUS.COMPLETE }).catch(() => {})
        }
      }
    } catch (err) {
      logApiError("cascade-complete", "Failed to cascade-complete subtasks", err)
    }
  }

  return new Response(JSON.stringify(taskPayload), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...authority,
    },
  })
}

export const DELETE: APIRoute = async ({ params, request }) => {
  const boardSelection = await rejectBoardSelectionInJson(request)
  if (boardSelection) return boardSelection
  await ensureSchema()
  const repo = new TaskRepository(getPersistenceClient())

  const resolved = await repo.resolveTaskId(params.id!)
  if (!resolved) {
    return new Response(JSON.stringify({ error: "Task not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })
  }

  const resolvedId = resolved.id
  await repo.deleteTask(resolvedId)

  const authority = await taskEventAuthorityHeaders(["task.deleted"])
  dispatchTaskEvent("task.deleted", { id: resolvedId }, undefined, undefined, undefined, authority).catch(() => {})

  // Clean up any associated calendar events (fire-and-forget)
  import("../../../domains/calendar/calendar-bridge").then(({ removeTaskCalendarEvent }) => {
    removeTaskCalendarEvent(resolvedId).catch(() => {})
  }).catch(() => {})

  // Clean up any associated HA todo items (fire-and-forget)
  import("../../../domains/todo/todo-bridge").then(({ removeTaskFromTodoList }) => {
    removeTaskFromTodoList(resolvedId).catch(() => {})
  }).catch(() => {})

  return new Response(null, { status: 204, headers: authority })
}

/** PATCH is an alias for PUT — some client-side callers use PATCH for partial updates */
export const PATCH = PUT
