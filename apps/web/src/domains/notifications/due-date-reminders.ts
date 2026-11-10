/**
 * Due-Date Reminder Scheduler
 *
 * Periodically checks for tasks with upcoming due dates and sends
 * reminder notifications via configured channels (sidebar, mobile push).
 * Also creates a short "reminder" calendar event on the synced HA calendar
 * so the reminder propagates to phone calendars (Google Calendar, Apple, etc.).
 *
 * Production safety:
 *   - Processing flag in `finally` prevents concurrent runs (no race conditions)
 *   - Sent-reminders Set prevents duplicate notifications (bounded, bulk-pruned)
 *   - Proper cleanup on shutdown (clearInterval + process listeners)
 *   - All errors are caught — never crashes the process
 *   - No memory leaks: Set bounded to MAX_TRACKED_REMINDERS
 *   - Module refs cached after first load (no repeated dynamic imports)
 *   - Settings cached with TTL to avoid DB reads every cycle
 *
 * @domain notifications
 * @bounded-context due-date-reminders
 */
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability";
import { STATUS } from "../../lib/status-config";

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["notifications"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: false,
});
const SYS_REQ = "due-date-reminder";

// ── Configuration ──

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const REMINDER_WINDOW_MS = 60 * 60 * 1000; // 1 hour before due
const MAX_TRACKED_REMINDERS = 500; // Prevent unbounded Set growth
const PRUNE_BATCH_SIZE = 50; // Bulk-prune when over limit (F18)

// ── State ──

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let processing = false;
const sentReminders = new Set<string>(); // "taskId:YYYY-MM-DD" — prevents duplicates
const SENT_REMINDERS_MAX = 1000; // Cap to prevent unbounded memory growth

/** Evict oldest 25% when Set exceeds max size (FIFO via insertion order). */
function evictSentReminders(): void {
  if (sentReminders.size <= SENT_REMINDERS_MAX) return;
  const evictCount = Math.floor(SENT_REMINDERS_MAX * 0.25);
  let removed = 0;
  for (const key of sentReminders) {
    if (removed >= evictCount) break;
    sentReminders.delete(key);
    removed++;
  }
}
let schemaEnsured = false; // Skip repeated ensureSchema after first run (F1)

// ── Cached module refs (F2) ──
let _callHAService: typeof import("@domains/ha/ha-services").callHAService | null = null;
let _formatTicketKey: typeof import("../../lib/ticket-key").formatTicketKey | null = null;
let _getIngressEntry: typeof import("@domains/ha/ha-connection").getIngressEntry | null = null;
let _getHABaseUrl: typeof import("@domains/ha/ha-connection").getHABaseUrl | null = null;

async function getModuleRefs() {
  if (!_callHAService) {
    const mod = await import("@domains/ha/ha-services");
    _callHAService = mod.callHAService;
  }
  if (!_formatTicketKey) {
    const mod = await import("../../lib/ticket-key");
    _formatTicketKey = mod.formatTicketKey;
  }
  if (!_getIngressEntry || !_getHABaseUrl) {
    try {
      const mod = await import("@domains/ha/ha-connection");
      _getIngressEntry = mod.getIngressEntry;
      _getHABaseUrl = mod.getHABaseUrl;
    } catch { /* ingress unavailable */ }
  }
  return {
    callHAService: _callHAService!,
    formatTicketKey: _formatTicketKey!,
    getIngressEntry: _getIngressEntry,
    getHABaseUrl: _getHABaseUrl,
  };
}

// ── Cached settings (F3: avoid re-reading DB every cycle) ──
interface CachedNotifSettings {
  enabled: boolean;
  channels: { sidebar: boolean; mobile_push: boolean };
  mobileTargets: string[];
  calendarEntity: string | null;
  reminderEnabled: boolean;
  reminderWindowMs: number;
  cachedAt: number;
}
let settingsCache: CachedNotifSettings | null = null;
const SETTINGS_CACHE_TTL_MS = 5 * 60 * 1000; // Match check interval

async function getCachedSettings(): Promise<CachedNotifSettings> {
  const now = Date.now();
  if (settingsCache && (now - settingsCache.cachedAt) < SETTINGS_CACHE_TTL_MS) {
    return settingsCache;
  }

  const { getPersistenceClient } = await import("@domains/tasks/persistence/store");
  const client = getPersistenceClient();

  let enabled = true;
  let channels = { sidebar: true, mobile_push: false };
  let mobileTargets: string[] = [];
  let calendarEntity: string | null = null;
  let reminderEnabled = true;
  let reminderWindowMs = REMINDER_WINDOW_MS;

  try {
    const prefsResult = await client.execute({
      sql: "SELECT value FROM settings WHERE key = 'notification_preferences' LIMIT 1",
      args: [],
    });
    if (prefsResult.rows.length > 0) {
      const raw = JSON.parse(String((prefsResult.rows[0] as Record<string, unknown>).value));
      if (typeof raw === "object" && raw !== null) {
        enabled = raw.enabled !== false;
        if (raw.channels) channels = raw.channels;
        if (Array.isArray(raw.mobile_targets)) mobileTargets = raw.mobile_targets;
        if (raw.due_date_reminders === false) reminderEnabled = false;
        if (typeof raw.reminder_window_minutes === "number" && raw.reminder_window_minutes > 0) {
          reminderWindowMs = raw.reminder_window_minutes * 60 * 1000;
        }
      }
    }
  } catch { /* defaults */ }

  try {
    const calResult = await client.execute({
      sql: "SELECT value FROM settings WHERE key IN ('calendar_entity', 'calendar_entities') LIMIT 1",
      args: [],
    });
    if (calResult.rows.length > 0) {
      const val = JSON.parse(String((calResult.rows[0] as Record<string, unknown>).value));
      if (typeof val === "string") calendarEntity = val;
      else if (Array.isArray(val) && val.length > 0) calendarEntity = val[0];
    }
  } catch { /* no calendar configured */ }

  settingsCache = { enabled, channels, mobileTargets, calendarEntity, reminderEnabled, reminderWindowMs, cachedAt: now };
  return settingsCache;
}

/** Invalidate settings cache (called when settings are saved) */
export function invalidateSettingsCache(): void {
  settingsCache = null;
}

// ── Notification target helper (F17: extracted shared logic) ──

function parseNotifyTarget(target: string): { domain: string; service: string } | null {
  const [domain, ...rest] = target.split(".");
  const service = rest.join(".");
  return (domain && service) ? { domain, service } : null;
}

/**
 * Start the due-date reminder scheduler.
 * Idempotent — calling multiple times is safe.
 */
export function startDueDateReminders(): void {
  if (intervalHandle !== null) return;

  logger.log("info", {
    event: "due_date_reminders.started",
    domain: "notifications",
    component: "due-date-reminders",
    request_id: SYS_REQ,
    message: `Due-date reminder scheduler started (interval: ${CHECK_INTERVAL_MS}ms)`,
  });

  // Run once immediately, then on interval
  checkDueDates().catch(() => {});
  intervalHandle = setInterval(() => {
    checkDueDates().catch(() => {});
  }, CHECK_INTERVAL_MS);

  // Ensure cleanup on process exit
  const cleanup = () => stopDueDateReminders();
  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);
  process.once("beforeExit", cleanup);
}

/**
 * Stop the scheduler and clean up resources.
 */
export function stopDueDateReminders(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.log("info", {
      event: "due_date_reminders.stopped",
      domain: "notifications",
      component: "due-date-reminders",
      request_id: SYS_REQ,
      message: "Due-date reminder scheduler stopped",
    });
  }
}

/**
 * Core check: query tasks with due dates in the upcoming window,
 * send notifications for any not yet reminded.
 */
async function checkDueDates(): Promise<void> {
  // Guard: prevent concurrent runs (F15: processing flag always reset in finally)
  if (processing) return;
  processing = true;

  try {
    // Ensure schema once (F1)
    if (!schemaEnsured) {
      const { ensureSchema } = await import("@domains/tasks/persistence/store");
      await ensureSchema();
      schemaEnsured = true;
    }

    // Load cached settings (F3)
    const settings = await getCachedSettings();
    if (!settings.enabled || !settings.reminderEnabled) return;

    const { getPersistenceClient } = await import("@domains/tasks/persistence/store");
    const client = getPersistenceClient();

    const now = Date.now();
    const windowEnd = now + settings.reminderWindowMs;

    // F6: Use ISO date strings for SQL comparison instead of fetching ALL tasks
    // due_date is stored as ISO string — use string comparison for efficiency
    const nowIso = new Date(now).toISOString();
    const windowEndIso = new Date(windowEnd).toISOString();

    const result = await client.execute({
      sql: `SELECT id, title, due_date, priority, ticket_number, assigned_to, status
            FROM tasks
            WHERE status NOT IN ('${STATUS.COMPLETE}')
              AND due_date IS NOT NULL
              AND due_date != ''
              AND due_date >= ?
              AND due_date <= ?
            ORDER BY due_date ASC
            LIMIT 50`,
      args: [nowIso, windowEndIso],
    });

    // P7.1: Also query tasks with epoch-ms due dates (numeric values bypass ISO comparison)
    const epochResult = await client.execute({
      sql: `SELECT id, title, due_date, priority, ticket_number, assigned_to, status
            FROM tasks
            WHERE status NOT IN ('${STATUS.COMPLETE}')
              AND due_date IS NOT NULL
              AND due_date != ''
              AND CAST(due_date AS INTEGER) >= ?
              AND CAST(due_date AS INTEGER) <= ?
              AND due_date GLOB '[0-9]*'
            ORDER BY due_date ASC
            LIMIT 50`,
      args: [now, windowEnd],
    }).catch(() => ({ rows: [] })); // If CAST fails, skip epoch query

    // Merge rows, dedup by id
    const seenIds = new Set<string>();
    const allRows = [];
    for (const row of [...result.rows, ...epochResult.rows]) {
      const id = String((row as Record<string, unknown>).id);
      if (!seenIds.has(id)) { seenIds.add(id); allRows.push(row); }
    }

    if (allRows.length === 0) return;

    // Load module refs (F2: cached after first call)
    const { callHAService, formatTicketKey, getIngressEntry, getHABaseUrl } = await getModuleRefs();

    let ingressPath: string | null = null;
    if (getIngressEntry) {
      try { ingressPath = await getIngressEntry(); } catch { /* ingress unavailable */ }
    }

    // Resolve HA base URL for full deep links (mobile push needs scheme+host)
    // @see https://companion.home-assistant.io/docs/notifications/notifications-basic/#opening-a-url
    let baseUrl: string | null = null;
    if (getHABaseUrl) {
      try { baseUrl = await getHABaseUrl(); } catch { /* standalone mode */ }
    }

    for (const row of allRows) {
      const task = row as Record<string, unknown>;
      const taskId = String(task.id);
      const dueRaw = task.due_date;

      // Parse due date
      let dueMs: number;
      if (typeof dueRaw === "number") {
        dueMs = dueRaw;
      } else if (typeof dueRaw === "string") {
        const parsed = Date.parse(dueRaw);
        if (Number.isNaN(parsed)) continue;
        dueMs = parsed;
      } else {
        continue;
      }

      // Double-check window (SQL filter handles most, but epoch-stored dates need recheck)
      if (dueMs < now || dueMs > windowEnd) continue;

      // Dedup check
      const dueDateStr = new Date(dueMs).toISOString().slice(0, 10);
      const dedupKey = `${taskId}:${dueDateStr}`;
      if (sentReminders.has(dedupKey)) continue;
      sentReminders.add(dedupKey);

      // Evict oldest entries when Set grows past cap (memory safety)
      evictSentReminders();

      const title = String(task.title || "Untitled task");
      const ticketKey = formatTicketKey(task.ticket_number != null ? Number(task.ticket_number) : null) ?? "Task";
      const minutesUntilDue = Math.round((dueMs - now) / 60000);
      const timeLabel = minutesUntilDue <= 5
        ? "now"
        : minutesUntilDue < 60
          ? `in ${minutesUntilDue} min`
          : "in ~1 hour";

      // Full URL for mobile push — Companion app needs scheme+host+path
      // Relative ingress path for sidebar — renders inside HA frontend iframe
      const fullDeepLink = (baseUrl && ingressPath)
        ? `${baseUrl}${ingressPath}/kanban`
        : null;
      const sidebarLink = ingressPath
        ? `\n\n[Open ${ticketKey} in Meitheal →](${ingressPath}/kanban)`
        : "";
      const notifId = `meitheal_due_${taskId}`;

      // Sidebar notification
      if (settings.channels.sidebar !== false) {
        callHAService("persistent_notification", "create", {
          title: `⏰ Due ${timeLabel}: ${title}`,
          message: `${ticketKey} is due ${timeLabel}.${sidebarLink}`,
          notification_id: notifId,
        }).catch(() => {});
      }

      // Mobile push with enrichments
      if (settings.channels.mobile_push && settings.mobileTargets.length > 0) {
        for (const target of settings.mobileTargets) {
          const parsed = parseNotifyTarget(target);
          if (parsed) {
            callHAService(parsed.domain, parsed.service, {
              title: `⏰ Due ${timeLabel}: ${title}`,
              message: `${ticketKey} is due ${timeLabel}.`,
              data: {
                ...(fullDeepLink ? { clickAction: fullDeepLink, url: fullDeepLink } : {}),
                tag: notifId,
                group: "meitheal",
                channel: "meitheal_reminders",
                color: "#f59e0b",
                push: { "interruption-level": "time-sensitive" },
                actions: [
                  ...(fullDeepLink ? [{ action: "URI", title: "Open Task", uri: fullDeepLink }] : []),
                  { action: `MEITHEAL_TASK_DONE_${taskId}`, title: "✅ Mark Done" },
                ],
              },
            }).catch(() => {});
          }
        }
      }

      // Calendar reminder event (propagates to phone calendars)
      if (settings.calendarEntity) {
        const startIso = new Date(dueMs).toISOString();
        const endIso = new Date(dueMs + 15 * 60 * 1000).toISOString();
        callHAService("calendar", "create_event", {
          summary: `📋 ${ticketKey}: ${title} — DUE`,
          start_date_time: startIso,
          end_date_time: endIso,
          description: `Task ${ticketKey} is due. ${fullDeepLink ? `Open in Meitheal: ${fullDeepLink}` : ""}`,
        }, { entity_id: settings.calendarEntity }).catch(() => {});
      }

      logger.log("info", {
        event: "due_date_reminders.sent",
        domain: "notifications",
        component: "due-date-reminders",
        request_id: SYS_REQ,
        message: `Sent due-date reminder for ${ticketKey}: "${title}" (due ${timeLabel})`,
      });
    }
  } catch (err) {
    logger.log("error", {
      event: "due_date_reminders.check_failed",
      domain: "notifications",
      component: "due-date-reminders",
      request_id: SYS_REQ,
      message: `Due-date check failed: ${err}`,
    });
  } finally {
    processing = false; // F15: Always reset, even on early returns
  }
}
