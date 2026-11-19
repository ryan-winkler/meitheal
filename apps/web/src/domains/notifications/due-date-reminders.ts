import { isClosedStatus } from "@lib/status-config"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import {
  ensureSchema, getPersistenceClient, TaskRepository, readWorkDestinations, resolveIntegrationScope,
  validateIntegrationScope, validateTaskOperation, type IntegrationScope, type WorkBinding,
} from "@domains/tasks"
import { homeAssistantWorkLink } from "@lib/ha-app-link"
import { notificationOperationAllowed, sendTaskNotification } from "./task-notifications"

const logger = createLogger({ service: "meitheal-web", env: process.env.NODE_ENV ?? "development", minLevel: "info",
  enabledCategories: ["notifications", "tasks"], redactPatterns: defaultRedactionPatterns, auditEnabled: false })
const intervalMs = 5 * 60_000
const defaultWindowMs = 60 * 60_000
const maxTracked = 1000
let interval: ReturnType<typeof setInterval> | null = null
let processing = false
const sentReminders = new Set<string>()

/** Preferences are read per run. Authority and receiver bindings are never cached here. */
export function invalidateSettingsCache(): void {}

function track(key: string): void {
  sentReminders.add(key)
  if (sentReminders.size <= maxTracked) return
  let removed = 0
  for (const oldest of sentReminders) {
    sentReminders.delete(oldest)
    if (++removed >= Math.floor(maxTracked / 4)) break
  }
}

export async function startDueDateReminders(): Promise<void> {
  await ensureSchema()
  if (interval) return
  const first = checkDueDates()
  interval = setInterval(() => { void checkDueDates() }, intervalMs)
  interval.unref?.()
  logger.log("info", { event: "due_date_reminders.started", domain: "notifications", component: "due-date-reminders",
    request_id: "due-date-reminder", message: "Due-date reminder scheduler started" })
  await first
}
export function stopDueDateReminders(): void {
  if (interval) clearInterval(interval)
  interval = null
}

async function resolveObserver(binding: WorkBinding): Promise<IntegrationScope | null> {
  const result = await resolveIntegrationScope(getPersistenceClient(), binding.id, binding.generation, { resource: "task", action: "read" })
  return result.ok ? result.value : null
}

async function calendarReminder(context: IntegrationScope, task: Awaited<ReturnType<TaskRepository["findDueReminderTasks"]>>[number],
  receiver: WorkBinding, link: string | null): Promise<boolean> {
  if (receiver.integration !== "calendar_reminder" || receiver.purpose !== "calendar.reminder" || receiver.destination.boardId !== context.scope.boardId) return false
  const db = getPersistenceClient()
  const resolved = await resolveIntegrationScope(db, receiver.id, receiver.generation, { resource: "task", action: "read" }, context.scope, { resource: "task", action: "read" })
  if (!resolved.ok) return false
  const operationAllowed = async () => {
    if (!(await validateIntegrationScope(context, db, { resource: "task", action: "read" })).ok ||
      !(await validateIntegrationScope(resolved.value, db, { resource: "task", action: "read" })).ok ||
      !await validateTaskOperation(db, context.scope, task.id, { resource: "task", action: "read" })) return false
    const current = await new TaskRepository(db, resolved.value.scope).findById(task.id).catch(() => null)
    return Boolean(current && Number(current.task_version) === task.task_version && current.due_date === task.due_date &&
      current.deferred_at == null && !isClosedStatus(current.status))
  }
  if (!await operationAllowed()) return false
  const { callHAService } = await import("@domains/ha")
  await callHAService("calendar", "create_event", {
    summary: `📋 ${task.ticket_key}: ${task.title} — DUE`,
    start_date_time: new Date(task.due_ms).toISOString(), end_date_time: new Date(task.due_ms + 15 * 60_000).toISOString(),
    description: `Task ${task.ticket_key} is due.${link ? ` Open in Meitheal: ${link}` : ""}`,
  }, { entity_id: receiver.sourceId }, { operationAllowed })
  return true
}

/** One scheduler, independent observers for every approved Board and receiver. */
export async function checkDueDates(now = Date.now()): Promise<void> {
  if (processing) return
  processing = true
  try {
    await ensureSchema()
    const db = getPersistenceClient()
    const configuration = await readWorkDestinations(db)
    if (!configuration) return
    // Overdue domain observation remains independent of delivery preferences.
    for (const binding of configuration.bindings) {
      if (!binding.enabled || binding.purpose !== "builtin.overdue.observe") continue
      try {
        const context = await resolveObserver(binding)
        if (!context) continue
        const { checkOverdueTaskEvents } = await import("@domains/tasks")
        const { dispatchTaskEvent } = await import("@lib/webhook-dispatcher")
        const observed = await checkOverdueTaskEvents(db, (event, task, requestId, scope) =>
          dispatchTaskEvent(event, task, requestId, undefined, undefined, undefined, scope), now, context)
        if (observed.observed) logger.log(observed.dispatchFailed ? "warn" : "info", { event: "tasks.overdue.observed", domain: "tasks",
          component: "due-date-reminders", request_id: "due-date-reminder", message: "Recorded overdue transitions",
          metadata: { observed: observed.observed, dispatch_failed: observed.dispatchFailed } })
      } catch {
        logger.log("warn", { event: "due_date_reminders.observer_unavailable", domain: "notifications", component: "due-date-reminders",
          request_id: "due-date-reminder", message: "An overdue observer is unavailable" })
      }
    }
    for (const binding of configuration.bindings) {
      if (!binding.enabled || binding.purpose !== "builtin.reminders.observe") continue
      try {
        let context = await resolveObserver(binding)
        if (!context) continue
        const repo = new TaskRepository(db, context.scope)
        const prefs = await repo.getNotificationPreferences()
        const settings = await repo.getSettings(["notification_preferences"])
        let policy: Record<string, unknown> = {}
        try {
            const parsed: unknown = JSON.parse(settings.notification_preferences ?? "{}")
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) policy = parsed as Record<string, unknown>
          } catch {}
          if (!prefs.enabled || policy.due_date_reminders === false) continue
          const windowMs = typeof policy.reminder_window_minutes === "number" && Number.isFinite(policy.reminder_window_minutes) && policy.reminder_window_minutes > 0
            ? policy.reminder_window_minutes * 60_000 : defaultWindowMs
          const tasks = await repo.findDueReminderTasks(now, now + windowMs)
          for (const candidate of tasks) {
            const key = `${binding.id}:${binding.generation}:${context.scope.boardId}:${candidate.id}:${new Date(candidate.due_ms).toISOString().slice(0, 10)}`
            if (sentReminders.has(key) || candidate.assigned_to && prefs.disabledUsers.has(candidate.assigned_to)) continue
            // Each item retains the original binding identity/generation, while a
            // new finite proof is resolved outside every provider/SQLite writer.
            context = await resolveObserver(binding)
            if (!context) break
            const current = await new TaskRepository(db, context.scope).findById(candidate.id).catch(() => null)
            if (!current || Number(current.task_version) !== candidate.task_version || current.due_date !== candidate.due_date || current.deferred_at != null || isClosedStatus(current.status)) continue
            const task = candidate
            const sidebar = prefs.channels.sidebar !== false && await notificationOperationAllowed(context.scope, "persistent_notification", { resource: "task", action: "read" }, task.id)
            const targets: string[] = []
            if (prefs.channels.mobile_push) for (const target of prefs.mobileTargets) {
              if (await notificationOperationAllowed(context.scope, target, { resource: "task", action: "read" }, task.id)) targets.push(target)
            }
            const link = await homeAssistantWorkLink(context.scope.boardId, task.id)
            let attempted = sidebar || targets.length > 0
            const minutes = Math.round((task.due_ms - now) / 60_000)
            const time = minutes <= 5 ? "now" : minutes < 60 ? `in ${minutes} min` : "in ~1 hour"
            const deliveryContext = context
            if (attempted) await sendTaskNotification({ ...prefs, channels: { sidebar, mobile_push: targets.length > 0 }, mobileTargets: targets }, {
              title: `⏰ Due ${time}: ${task.title}`, message: `${task.ticket_key} is due ${time}.${link ? `\n\n[Open ${task.ticket_key} in Meitheal →](${link})` : ""}`,
              notificationId: `meitheal_due_${task.id}`, ingress: null, taskId: task.id, taskVersion: task.task_version, isUrgent: true,
              operationAllowed: async () => {
                const latest = await new TaskRepository(db, deliveryContext.scope).findById(task.id).catch(() => null)
                return Boolean(latest && Number(latest.task_version) === task.task_version && latest.due_date === task.due_date && latest.deferred_at == null && !isClosedStatus(latest.status))
              },
            }, context.scope, { resource: "task", action: "read" })
            for (const receiver of configuration.bindings) {
              if (!receiver.enabled || receiver.integration !== "calendar_reminder" || receiver.purpose !== "calendar.reminder") continue
              try { attempted = await calendarReminder(context, task, receiver, link) || attempted } catch {}
            }
            if (attempted) track(key)
          }
      } catch {
        logger.log("warn", { event: "due_date_reminders.observer_unavailable", domain: "notifications", component: "due-date-reminders",
          request_id: "due-date-reminder", message: "A reminder observer is unavailable" })
      }
    }
  } catch {
    logger.log("error", { event: "due_date_reminders.check_failed", domain: "notifications", component: "due-date-reminders",
      request_id: "due-date-reminder", message: "Due-date reminder check unavailable" })
  } finally { processing = false }
}
