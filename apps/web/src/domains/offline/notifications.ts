/**
 * Notifications Service — Web Notifications API integration
 *
 * Sends browser notifications through the App's active service worker.
 * Request permission only in response to a user gesture.
 *
 * Bounded context: offline (notification lifecycle managed with PWA)
 */

import { buildIngressPagePath } from "@lib/page-shell-links"
import { buildTaskPath } from "@lib/task-detail-handoff"
import { isPwaSupported } from "./sw-register"

function getNotificationPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission
}

/** Call directly from a user gesture so the browser can show its permission prompt. */
export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  const current = getNotificationPermission()
  return current === "default" ? Notification.requestPermission() : current
}

interface TaskNotification {
  title: string
  body: string
  tag?: string
  url?: string
  requireInteraction?: boolean
}

/** Submit a notification to this installation's active worker. */
export async function showTaskNotification(notification: TaskNotification): Promise<boolean> {
  if (!isPwaSupported() || getNotificationPermission() !== "granted") return false

  try {
    const scope = new URL(buildIngressPagePath("/"), location.origin)
    const expectedScript = new URL("sw.js", scope).href
    let registration = await navigator.serviceWorker.getRegistration(scope.href)
    if (registration?.scope === scope.href && !registration.active) {
      const pending = registration.installing ?? registration.waiting
      if (pending?.scriptURL === expectedScript) {
        await new Promise<void>(resolve => {
          const timer = window.setTimeout(resolve, 2_500)
          const check = () => {
            if (pending.state === "activated" || pending.state === "redundant") {
              window.clearTimeout(timer)
              pending.removeEventListener("statechange", check)
              resolve()
            }
          }
          pending.addEventListener("statechange", check)
          check()
        })
        registration = await navigator.serviceWorker.getRegistration(scope.href)
      }
    }
    // The browser may return Home Assistant's broader worker before the App worker is active.
    if (registration?.scope !== scope.href || registration.active?.scriptURL !== expectedScript) return false

    const url = new URL((notification.url ?? "").replace(/^\/+/, ""), scope)
    if (url.origin !== scope.origin || url.username || url.password || !url.pathname.startsWith(scope.pathname)) return false
    const icon = new URL("icon-192.png", scope).href
    await registration.showNotification(notification.title, {
      body: notification.body,
      tag: notification.tag ?? "meitheal-general",
      icon,
      badge: icon,
      data: { url: url.href },
      requireInteraction: notification.requireInteraction === true,
    })
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
  if (getNotificationPermission() !== "granted") return

  const now = new Date()
  const notifiedKey = "meitheal_notified_overdue"
  const notified = new Set(JSON.parse(sessionStorage.getItem(notifiedKey) ?? "[]"))

  for (const task of tasks) {
    if (notified.has(task.id)) continue
    if (task.status === "complete") continue

    const due = new Date(task.dueDate)
    if (due < now) {
      const delivered = await showTaskNotification({
        title: "⏰ Overdue Task",
        body: task.title,
        tag: `overdue-${task.id}`,
        url: buildTaskPath(task.id),
      })
      if (delivered) notified.add(task.id)
    }
  }

  sessionStorage.setItem(notifiedKey, JSON.stringify([...notified]))
}

/**
 * Check for tasks due within the next hour and fire reminder notifications.
 * Uses sessionStorage deduplication (same as overdue check).
 */
export async function checkUpcomingReminders(tasks: TaskForCheck[]): Promise<void> {
  if (getNotificationPermission() !== "granted") return

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
      const delivered = await showTaskNotification({
        title: "📋 Task Due Soon",
        body: `${task.title} — due in ${minutesUntilDue} minutes`,
        tag: `upcoming-${task.id}`,
        url: buildTaskPath(task.id),
      })
      if (delivered) notified.add(task.id)
    }
  }

  sessionStorage.setItem(notifiedKey, JSON.stringify([...notified]))
}
