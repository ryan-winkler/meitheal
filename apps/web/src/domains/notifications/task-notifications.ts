import {
  TaskRepository, getPersistenceClient, readWorkDestinations,
  resolveIntegrationScope, resolveIntegrationRecipient, validateBoardScope, readTaskAssignmentReceipt, validateTaskOperation, validateIntegrationScope,
  type BoardScope, type IntegrationScope, type WorkOperation, type TaskAssignmentReceipt,
} from "../tasks"
/**
 * Task notifications — Home Assistant sidebar and Companion push
 *
 * One delivery path for every task notification, so each caller honours the
 * same household preferences (channels, push targets).
 *
 * @domain notifications
 * @bounded-context task-notifications
 */
import { logApiError } from "@lib/api-logger"
import { DEFAULT_ACCENT } from "@lib/design-tokens"

export interface TaskNotificationPreferences {
  enabled: boolean
  disabledUsers: Set<string>
  channels: { sidebar: boolean; mobile_push: boolean }
  mobileTargets: string[]
}

export interface TaskNotification {
  title: string
  /** Markdown. Links are flattened for push, which shows plain text. */
  message: string
  notificationId: string
  /** Ingress entry path, when Meitheal runs as a Home Assistant App. */
  ingress: string | null
  /** Adds a "Mark Done" push action for this task. */
  taskId?: string
  taskVersion?: number
  /** A producer may add a stricter eligibility check; this never grants authority. */
  operationAllowed?: () => Promise<boolean>
  isUrgent?: boolean
  badgeCount?: number
}

async function approvedAudience(context: IntegrationScope, target: string, taskId?: string, expectedVersion?: number): Promise<boolean> {
  const db = getPersistenceClient()
  const { binding, scope: service } = context
  if (taskId) {
    const task = await new TaskRepository(db, service).findById(taskId)
    if (!task || expectedVersion !== undefined && task.task_version !== expectedVersion) return false
  }
  // HA persistent notifications are visible beyond a single recipient. An
  // explicit mobile recipient list cannot make that global surface private.
  if (target !== "persistent_notification" && binding.recipientUserIds !== undefined) {
    if (!binding.recipientUserIds.length) return false
    for (const id of binding.recipientUserIds) {
      const recipient = await resolveIntegrationRecipient(db, context, id)
      if (!recipient.ok || taskId && !await new TaskRepository(db, recipient.scope).findById(taskId)) return false
    }
    return true
  }
  const { rows: [board] } = await db.execute({
    sql: "SELECT visibility FROM task_boards WHERE id = ? AND state = 'active'", args: [service.boardId],
  })
  if (board?.visibility !== "shared") return false
  // A broad channel cannot prove a restricted Area/Project audience. Private
  // Boards use an approved mobile target with individually checked recipients.
  const { rows } = await db.execute({
    sql: "SELECT 1 FROM organization_access_policies WHERE board_id = ? AND audience <> 'everyone' LIMIT 1",
    args: [service.boardId],
  })
  return rows.length === 0
}

/** Current originating action and exact approved disclosure channel are intersections. */
export async function notificationOperationAllowed(
  scope: BoardScope, target: string,
  originatingOperation: WorkOperation = { resource: "task", action: "read" },
  taskId?: string, receipt?: TaskAssignmentReceipt, expectedVersion?: number,
): Promise<boolean> {
  const db = getPersistenceClient()
  if (!(await validateBoardScope(scope, db, originatingOperation)).ok) return false
  if (receipt && (!taskId || receipt.id !== taskId || !await readTaskAssignmentReceipt(db, scope, receipt.eventId, taskId))) return false
  if (taskId && !receipt && !await validateTaskOperation(db, scope, taskId, originatingOperation)) return false
  const sourceId = target.startsWith("persistent_notification") ? "persistent_notification" : target
  const configuration = await readWorkDestinations(db)
  for (const binding of configuration?.bindings ?? []) {
    if (!binding.enabled || binding.integration !== "notification" || binding.purpose !== "notify.delivery" ||
      binding.sourceId !== sourceId || binding.destination.boardId !== scope.boardId) continue
    if (receipt && !receipt.bindingRefs.some(ref => ref.id === binding.id && ref.generation === binding.generation)) continue
    const service = await resolveIntegrationScope(db, binding.id, binding.generation, { resource: "task", action: "read" })
    if (!service.ok || !await approvedAudience(service.value, sourceId, taskId, expectedVersion)) continue
    return (await validateBoardScope(scope, db, originatingOperation)).ok &&
      (await validateIntegrationScope(service.value, db, { resource: "task", action: "read" })).ok
  }
  return false
}

/** Send one notification to approved channels. Delivery failures do not change the task result. */
export async function sendTaskNotification(
  prefs: TaskNotificationPreferences, notification: TaskNotification, scope: BoardScope,
  originatingOperation: WorkOperation = { resource: "task", action: "read" },
  receipt?: TaskAssignmentReceipt,
): Promise<void> {
  if (!prefs.enabled || notification.operationAllowed && !await notification.operationAllowed()) return
  const { callHAService } = await import("@domains/ha")
  const { title, message, notificationId, taskId, isUrgent, badgeCount } = notification
  const deliveries: Promise<unknown>[] = []

  if (prefs.channels.sidebar !== false) {
    const operationAllowed = async () => (!notification.operationAllowed || await notification.operationAllowed()) && await notificationOperationAllowed(scope, "persistent_notification", originatingOperation, taskId, receipt, notification.taskVersion)
    if (await operationAllowed()) {
    deliveries.push(
      callHAService("persistent_notification", "create", { title, message, notification_id: notificationId }, undefined, { operationAllowed })
        .catch(err => logApiError("ha-notify", "Failed to send sidebar notification", err)),
    )
    }
  }

  if (prefs.channels.mobile_push && prefs.mobileTargets.length > 0) {
    const plainMessage = message.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    const { homeAssistantWorkLink } = await import("@lib/ha-app-link")
    const ingressPath = await homeAssistantWorkLink(scope.boardId, taskId)

    for (const target of prefs.mobileTargets) {
      const [domain, ...rest] = target.split(".")
      const service = rest.join(".")
      if (!domain || !service) continue
      const operationAllowed = async () => (!notification.operationAllowed || await notification.operationAllowed()) && await notificationOperationAllowed(scope, target, originatingOperation, taskId, receipt, notification.taskVersion)
      if (!await operationAllowed()) continue
      const { createTaskNotificationDoneAction } = await import("@lib/task-notification-action")
      const doneAction = taskId ? await createTaskNotificationDoneAction(scope.boardId, target, taskId, notification.taskVersion) : null
      deliveries.push(
        callHAService(domain, service, {
          title,
          message: plainMessage,
          data: {
            ...(ingressPath ? { clickAction: ingressPath, url: ingressPath } : {}),
            tag: notificationId,
            group: "meitheal",
            channel: isUrgent ? "meitheal_urgent" : "meitheal_tasks",
            color: DEFAULT_ACCENT,
            ...(isUrgent ? { importance: "high" } : {}),
            push: {
              "interruption-level": isUrgent ? "time-sensitive" : "active",
              ...(badgeCount !== undefined ? { badge: badgeCount } : {}),
            },
            actions: [
              ...(doneAction ? [{ action: doneAction, title: "Mark Done" }] : []),
              ...(ingressPath ? [{ action: "URI", title: "Open Task", uri: ingressPath }] : []),
            ],
          },
        }, undefined, { operationAllowed }).catch(err => logApiError("ha-notify", `Failed to send mobile push to ${target}`, err)),
      )
    }
  }

  await Promise.all(deliveries)
}

export async function notifyUrgentTaskCreation(scope: BoardScope, payload: Record<string, unknown>): Promise<void> {
  if (payload.priority !== 1 || typeof payload.id !== "string") return
  const { rows: [row] } = await getPersistenceClient().execute({
    sql: "SELECT value FROM settings WHERE key = 'notification_preferences'", args: [],
  })
  let preferences: Record<string, unknown> = {}
  try { preferences = row ? JSON.parse(String(row.value)) : {} } catch { return }
  const channels = preferences.channels as { sidebar?: boolean, mobile_push?: boolean } | undefined
  await sendTaskNotification({
    enabled: preferences.enabled !== false, disabledUsers: new Set(),
    channels: { sidebar: channels?.sidebar !== false, mobile_push: channels?.mobile_push === true },
    mobileTargets: Array.isArray(preferences.mobile_targets) ? preferences.mobile_targets.filter((target): target is string => typeof target === "string") : [],
  }, {
    title: `Urgent Task: ${String(payload.title ?? "")}`,
    message: typeof payload.description === "string" ? payload.description.slice(0, 100) : "Needs immediate attention.",
    notificationId: `meitheal_urgent_${payload.id}`, taskId: payload.id,
    ...(typeof payload.task_version === "number" ? { taskVersion: payload.task_version } : {}), ingress: null, isUrgent: true,
  }, scope, { resource: "task", action: "create" })
}

/** The sender may lose assignment access on commit; only its proved receipt can disclose this event. */
export async function notifyTaskHandback(scope: BoardScope, eventId: string, taskId: string): Promise<void> {
  const db = getPersistenceClient()
  const receipt = await readTaskAssignmentReceipt(db, scope, eventId, taskId)
  if (!receipt) return
  const { rows: [row] } = await db.execute({ sql: "SELECT value FROM settings WHERE key='notification_preferences'", args: [] })
  let prefs: Record<string, unknown>
  try { prefs = row ? JSON.parse(String(row.value)) : {} } catch { return }
  const channels = prefs.channels as { sidebar?: boolean, mobile_push?: boolean } | undefined
  await sendTaskNotification({ enabled: prefs.enabled !== false, disabledUsers: new Set(),
    channels: { sidebar: channels?.sidebar !== false, mobile_push: channels?.mobile_push === true },
    mobileTargets: Array.isArray(prefs.mobile_targets) ? prefs.mobile_targets.filter((item): item is string => typeof item === "string") : [],
  }, { title: "Task handed back", message: String(receipt.task.title ?? "Task updated"),
    notificationId: `meitheal_handoff_${taskId}`, ingress: null, taskId }, scope, { resource: "task", action: "assign" }, receipt)
}
