/**
 * Notifications Service — Web Notifications API integration
 *
 * Provides task due-date reminders and sync conflict alerts via the
 * Notification API. Includes Permissions API pre-check for graceful
 * permission requests without browser-level prompts.
 *
 * Bounded context: offline (notification lifecycle managed with PWA)
 */

// --- Ingress-aware URL helper ---

/**
 * Build a URL prefixed with the HA ingress path when running inside HA.
 * The ingress path is set on window.__ingress_path by Layout.astro.
 * Falls back to raw path when running standalone.
 */
function getIngressAwareUrl(path: string): string {
  const win = typeof window !== "undefined" ? window : undefined;
  const prefix = (win as Record<string, unknown> | undefined)?.__ingress_path ?? "";
  return `${prefix}${path}`;
}

// --- Permissions API pre-check ---

/**
 * Get current notification permission without triggering a prompt.
 * Returns "granted" | "denied" | "default" | "unsupported".
 */
export async function getNotificationPermission(): Promise<string> {
  if (typeof Notification === "undefined") return "unsupported"

  // Use Permissions API for silent check when available
  if ("permissions" in navigator) {
    try {
      const status = await navigator.permissions.query({ name: "notifications" })
      return status.state // "granted" | "denied" | "prompt"
    } catch {
      // Permissions API doesn't support notifications query in some browsers
    }
  }

  return Notification.permission
}

/**
 * Request notification permission. Only prompts if status is "default".
 */
export async function requestNotificationPermission(): Promise<string> {
  const current = await getNotificationPermission()
  if (current === "granted" || current === "denied") return current

  if (typeof Notification === "undefined") return "unsupported"

  return Notification.requestPermission()
}

// --- Notification dispatch ---

interface TaskNotification {
  title: string
  body: string
  tag?: string
  url?: string
  requireInteraction?: boolean
}

/**
 * Show a notification if permission is granted.
 * Uses tag-based deduplication to avoid spamming.
 */
export async function showTaskNotification(notification: TaskNotification): Promise<boolean> {
  const permission = await getNotificationPermission()
  if (permission !== "granted") return false

  try {
    const opts: NotificationOptions = {
      body: notification.body,
      tag: notification.tag ?? "meitheal-general",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: notification.url ?? "/" },
    }
    if (notification.requireInteraction) {
      opts.requireInteraction = true
    }

    const n = new Notification(notification.title, opts)

    // Click handler: navigate to task
    n.onclick = () => {
      window.focus()
      if (notification.url) {
        try {
          const target = new URL(notification.url, window.location.origin)
          if (target.origin === window.location.origin) {
            window.location.href = target.href
          }
        } catch { /* invalid URL — ignore */ }
      }
      n.close()
    }

    return true
  } catch {
    return false
  }
}

// --- Due date reminders ---

interface TaskForCheck {
  id: string
  title: string
  dueDate: string
  status: string
}

/**
 * Check for overdue tasks and fire notifications.
 * Only notifies once per task per session (uses sessionStorage).
 */
export async function checkOverdueTasks(tasks: TaskForCheck[]): Promise<void> {
  const permission = await getNotificationPermission()
  if (permission !== "granted") return

  const now = new Date()
  const notifiedKey = "meitheal_notified_overdue"
  const notified = new Set(JSON.parse(sessionStorage.getItem(notifiedKey) ?? "[]"))

  for (const task of tasks) {
    if (notified.has(task.id)) continue
    if (task.status === "complete") continue

    const due = new Date(task.dueDate)
    if (due < now) {
      await showTaskNotification({
        title: "⏰ Overdue Task",
        body: task.title,
        tag: `overdue-${task.id}`,
        url: getIngressAwareUrl(`/tasks?open=${task.id}`),
      })
      notified.add(task.id)
    }
  }

  sessionStorage.setItem(notifiedKey, JSON.stringify([...notified]))
}

/**
 * Check for tasks due within the next hour and fire reminder notifications.
 * Uses sessionStorage deduplication (same as overdue check).
 */
export async function checkUpcomingReminders(tasks: TaskForCheck[]): Promise<void> {
  const permission = await getNotificationPermission()
  if (permission !== "granted") return

  const now = new Date()
  const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000)
  const notifiedKey = "meitheal_notified_upcoming"
  const notified = new Set(JSON.parse(sessionStorage.getItem(notifiedKey) ?? "[]"))

  for (const task of tasks) {
    if (notified.has(task.id)) continue
    if (task.status === "complete") continue

    const due = new Date(task.dueDate)
    if (due > now && due <= oneHourFromNow) {
      const minutesUntilDue = Math.round((due.getTime() - now.getTime()) / 60000)
      await showTaskNotification({
        title: "📋 Task Due Soon",
        body: `${task.title} — due in ${minutesUntilDue} minutes`,
        tag: `upcoming-${task.id}`,
        url: getIngressAwareUrl(`/tasks?open=${task.id}`),
      })
      notified.add(task.id)
    }
  }

  sessionStorage.setItem(notifiedKey, JSON.stringify([...notified]))
}
