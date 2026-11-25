import { serializeCalendarDelivery } from "@domains/calendar/calendar-delivery"
import {
  isMeithealOriginatedEvent,
  stripCalendarReminderWrappers,
} from "@domains/calendar/calendar-event-identity"
import { decodeCalendarSetting, ticketDetailsEnabled } from "@domains/calendar/calendar-policy"
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

/** Reset in-memory reminder dedup state between test runs. */
export function resetDueDateRemindersForTests(): void {
  stopDueDateReminders()
  sentReminders.clear()
  processing = false
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

  // Respect active calendar sync mode & writeTicketDetails preference (fail-closed on import-only)
  const repo = new TaskRepository(db, resolved.value.scope)
  let writeTicketDetails = true
  try {
    const calSettings = await repo.getSettings(["calendar_sync_mode", "calendar_sync_modes", "calendar_write_ticket_details"])
    let perEntityMode: string | undefined
    if (calSettings.calendar_sync_modes) {
      try {
        const parsed: unknown = JSON.parse(calSettings.calendar_sync_modes)
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const val = (parsed as Record<string, unknown>)[receiver.sourceId]
          if (typeof val === "string") perEntityMode = val
        }
      } catch { /* ignore invalid JSON */ }
    }
    const dbMode = perEntityMode ?? decodeCalendarSetting(calSettings.calendar_sync_mode)
    if (dbMode === "import") return false
    writeTicketDetails = ticketDetailsEnabled(calSettings.calendar_write_ticket_details)

    const { getCalendarSyncConfigs } = await import("@domains/calendar")
    const bindings = (await readWorkDestinations(db))?.bindings ?? []
    const activeConfig = getCalendarSyncConfigs().find(c => c.entityId === receiver.sourceId &&
      bindings.some(b => b.enabled && b.integration === "calendar" && b.purpose === "calendar.sync" &&
        b.destination.boardId === context.scope.boardId && b.sourceId === c.entityId &&
        b.id === c.bindingId && b.generation === c.generation))
    if (activeConfig) {
      if (activeConfig.syncMode === "import") return false
      if (calSettings.calendar_write_ticket_details === undefined && activeConfig.writeTicketDetails === false) {
        writeTicketDetails = false
      }
    }
  } catch { return false }

  // Loop prevention: never create a calendar due-date reminder for:
  // 1) tasks already imported from any calendar (1 invite = 1 ticket),
  // 2) tasks already synced/written-back to this calendar,
  // 3) tasks already reminded on this calendar for this due timestamp (even if receiver.id changed),
  // 4) pre-existing Meitheal reminder/write-back artifacts.
  const startIso = new Date(task.due_ms).toISOString()
  const endIso = new Date(task.due_ms + 15 * 60_000).toISOString()
  const reminderRequestId = `due-reminder-${receiver.id}-${task.id}-${task.due_ms}`
  const isImportedOrOriginated = (current: { idempotency_key?: string | null; title?: string | null; description?: string | null } | null): boolean => {
    if (!current) return false
    if (typeof current.idempotency_key === "string" && /^(?:cal-sync-|caldav-sync-)/.test(current.idempotency_key)) {
      return true
    }
    return isMeithealOriginatedEvent(
      typeof current.title === "string" ? current.title : "",
      typeof current.description === "string" ? current.description : null,
    )
  }
  const covered = async (currentReservation: string | null = null) => {
    const existingConf = await db.execute({
      sql: `SELECT confirmation_id FROM calendar_confirmations
            WHERE task_id = ?
              AND (
                source IN ('ha.calendar_sync', 'caldav')
                OR (source != 'ha.due_reminder' AND json_extract(payload, '$.entity_id') = ?)
                OR (source = 'ha.due_reminder' AND json_extract(payload, '$.entity_id') = ? AND json_extract(payload, '$.start') = ?)
                OR request_id = ?
                OR provider_event_id = ?
              )
            LIMIT 1`,
      args: [task.id, receiver.sourceId, receiver.sourceId, startIso, reminderRequestId, reminderRequestId],
    })
    if (existingConf.rows.length > 0) return true
    const existingDelivery = await db.execute({
      sql: `SELECT request_id FROM calendar_reminder_deliveries
            WHERE task_id = ? AND entity_id = ? AND due_ms = ?
              AND (? IS NULL OR request_id != ? OR acknowledged != 0)
            LIMIT 1`,
      args: [task.id, receiver.sourceId, task.due_ms, currentReservation, currentReservation],
    })
    if (existingDelivery.rows.length > 0) return true
    const current = await new TaskRepository(db, resolved.value.scope).findById(task.id).catch(() => null)
    return isImportedOrOriginated(current)
  }
  if (await covered()) return false

  const operationAllowed = async () => {
    if (!(await validateIntegrationScope(context, db, { resource: "task", action: "read" })).ok ||
      !(await validateIntegrationScope(resolved.value, db, { resource: "task", action: "read" })).ok ||
      !await validateTaskOperation(db, context.scope, task.id, { resource: "task", action: "read" })) return false
    const current = await new TaskRepository(db, resolved.value.scope).findById(task.id).catch(() => null)
    if (isImportedOrOriginated(current)) return false
    return Boolean(current && Number(current.task_version) === task.task_version && current.due_date === task.due_date &&
      current.deferred_at == null && !isClosedStatus(current.status))
  }
  if (!await operationAllowed()) return false

  let fullLink: string | undefined
  if (link && link.startsWith("/")) {
    try {
      const { getHABaseUrl } = await import("@domains/ha")
      const baseUrl = await getHABaseUrl()
      if (baseUrl && ["http:", "https:"].includes(new URL(baseUrl).protocol)) fullLink = `${baseUrl.replace(/\/$/, "")}${link}`
    } catch { /* omit unavailable link */ }
  }

  const cleanTitle = stripCalendarReminderWrappers(task.title) || task.title
  const summary = writeTicketDetails
    ? `📋 ${task.ticket_key}: ${cleanTitle} — DUE`
    : `📋 ${cleanTitle} — DUE`
  const detailLines: string[] = []
  if (writeTicketDetails) {
    detailLines.push(`📋 ${task.ticket_key}`)
    if (fullLink) detailLines.push(`Open ${task.ticket_key} in Meitheal: ${fullLink}`)
  }
  detailLines.push("Added from Meitheal")
  const headerLine = writeTicketDetails ? `Task ${task.ticket_key} is due.` : "Task reminder."
  const description = `${headerLine}\n\n${detailLines.join("\n")}`

  const { createCalendarEvent } = await import("@domains/ha")
  return serializeCalendarDelivery(task.id, receiver.sourceId, async () => {
    if (await covered()) return false
    const reservation = await db.execute({
      sql: `INSERT INTO calendar_reminder_deliveries
        (request_id, task_id, entity_id, due_ms, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING`,
      args: [reminderRequestId, task.id, receiver.sourceId, task.due_ms,
        JSON.stringify({ entity_id: receiver.sourceId, summary, start: startIso, end: endIso }), Date.now()],
    })
    if (!reservation.rowsAffected) return false
    const created = await createCalendarEvent(receiver.sourceId, { summary, start: startIso, end: endIso, description },
      { operationAllowed: async () => await operationAllowed() && !await covered(reminderRequestId) })
    if (!created) {
      await db.execute({ sql: "DELETE FROM calendar_reminder_deliveries WHERE request_id=?", args: [reminderRequestId] })
      return false
    }
    await db.execute({ sql: "UPDATE calendar_reminder_deliveries SET acknowledged=1 WHERE request_id=?", args: [reminderRequestId] })
    await finishReminderBookkeeping()
    return true
  })
}

// Each local insert and its completion flag commit together. Neither retry path contacts HA.
async function finishReminderBookkeeping(): Promise<void> {
  const db = getPersistenceClient()
  const pending = await db.execute("SELECT request_id FROM calendar_reminder_deliveries WHERE acknowledged=1 AND (confirmed=0 OR logged=0)")
  for (const row of pending.rows) {
    const args = [String(row.request_id)]
    for (const [flag, insert] of [
      ["confirmed", `INSERT INTO calendar_confirmations (confirmation_id, task_id, request_id, provider_event_id, source, payload, created_at)
        SELECT request_id, task_id, request_id, request_id, 'ha.due_reminder', payload, created_at`],
      ["logged", `INSERT INTO task_activity_log (task_id, field, new_value, actor, actor_type, event_type, summary, correlation_id, created_at)
        SELECT task_id, 'calendar_sync', request_id, 'calendar-sync', 'calendar_sync', 'calendar_sync',
          'Calendar due reminder sent to ' || entity_id, request_id, created_at`],
    ] as const) {
      try {
        await db.batch([
          { sql: insert + ` FROM calendar_reminder_deliveries WHERE request_id=? AND ${flag}=0` +
            (flag === "confirmed" ? " ON CONFLICT(task_id, request_id) DO NOTHING" : ""), args },
          { sql: `UPDATE calendar_reminder_deliveries SET ${flag}=1 WHERE request_id=?`, args },
        ], "write")
      } catch {
        logger.log("warn", { event: "calendar.reminder.bookkeeping_pending", domain: "notifications",
          component: "due-date-reminders", request_id: "due-date-reminder", message: "Calendar reminder bookkeeping will retry" })
      }
    }
  }
}

/** One scheduler, independent observers for every approved Board and receiver. */
export async function checkDueDates(now = Date.now()): Promise<void> {
  if (processing) return
  processing = true
  try {
    await ensureSchema()
    const db = getPersistenceClient()
    await finishReminderBookkeeping()
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
