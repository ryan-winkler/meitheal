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
  isUrgent?: boolean
  badgeCount?: number
}

/** Send one notification to every enabled channel. Delivery failures are logged, never thrown. */
export async function sendTaskNotification(prefs: TaskNotificationPreferences, notification: TaskNotification): Promise<void> {
  const { callHAService } = await import("@domains/ha")
  const { title, message, notificationId, ingress, taskId, isUrgent, badgeCount } = notification
  const deliveries: Promise<unknown>[] = []

  if (prefs.channels.sidebar !== false) {
    deliveries.push(
      callHAService("persistent_notification", "create", { title, message, notification_id: notificationId })
        .catch(err => logApiError("ha-notify", "Failed to send sidebar notification", err)),
    )
  }

  if (prefs.channels.mobile_push && prefs.mobileTargets.length > 0) {
    const plainMessage = message.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    const ingressPath = ingress ? ingress + "/kanban" : null

    for (const target of prefs.mobileTargets) {
      const [domain, ...rest] = target.split(".")
      const service = rest.join(".")
      if (!domain || !service) continue
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
              ...(ingressPath ? [{ action: "URI", title: "Open Task", uri: ingressPath }] : []),
              ...(taskId ? [{ action: `MEITHEAL_TASK_DONE_${taskId}`, title: "✅ Mark Done" }] : []),
            ],
          },
        }).catch(err => logApiError("ha-notify", `Failed to send mobile push to ${target}`, err)),
      )
    }
  }

  await Promise.all(deliveries)
}
