import { guardClientContinuity } from "../tasks/persistence/continuity-client"
import { readHouseholdBoardState } from "../tasks/persistence/named-board-repository"
/**
 * HA Startup — Server-Side Integration Initialization
 *
 * Initializes all HA integrations on first request after boot:
 *   - Entity subscription (WebSocket state tracking)
 *   - Todo sync auto-start from persisted settings
 *   - Calendar sync auto-start from persisted settings
 *   - Grocy connectivity validation
 *   - n8n/Webhook endpoint reachability validation
 *
 * Called from middleware.ts via a lazy initialization guard. Successful startup
 * runs once; unconfigured or failed startup remains eligible for retries.
 * Must be idempotent — safe to call multiple times.
 *
 * @domain ha
 * @bounded-context integration
 */
import { createHash } from "node:crypto"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import { fetchOutbound } from "@meitheal/integration-core"
import { getHAConnection, getHAConfiguration } from "./ha-connection"
import { initEntitySubscription } from "./ha-entities"

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["ha", "todo", "calendar", "integrations"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: false,
});
const SYS_REQ = "ha-system";

// Cached DB references — avoids 4x repeated dynamic import + ensureSchema
let _dbReady = false
let _getPersistenceClient: (() => ReturnType<typeof import("@domains/tasks")["getPersistenceClient"]>) | null = null
let _getSettingsRevision: (() => number) | null = null

async function getDB() {
  if (!_dbReady) {
    const mod = await import("@domains/tasks")
    await mod.ensureSchema()
    _getPersistenceClient = mod.getPersistenceClient
    _getSettingsRevision = mod.getSettingsRevision
    _dbReady = true
  }
  return guardClientContinuity(_getPersistenceClient!())
}

let initialized = false;
let initializing = false;
const UNCONFIGURED_RETRY_MS = 5_000
let unconfiguredStartup: {
  client: Awaited<ReturnType<typeof getDB>>
  settingsRevision: number
  environmentFingerprint: string
  retryAfter: number
} | undefined

function startupEnvironmentFingerprint(): string {
  return createHash("sha256").update(JSON.stringify([
    process.env.SUPERVISOR_TOKEN, process.env.HA_BASE_URL, process.env.HA_TOKEN,
  ])).digest("hex")
}

function withStartupCap(task: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    timer.unref?.();
    task.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

/**
 * Initialize all HA integrations. Idempotent — safe to call on every request.
 *
 * Flow:
 *   0. Verify/ensure local SQLite schema once
 *   1. Start local due-date reminder scheduler & establish WebSocket connection to HA Core
 *   2. Subscribe to scoped entity state changes
 *   3. Auto-start Todo sync -> title cleanup -> Calendar sync -> Grocy sync -> Webhook validation sequentially
 */
export async function initHAIntegrations(): Promise<void> {
  if (initialized || initializing) return;
  initializing = true;

  try {
    // Ensure schema verification completes once before background schedulers or WS frames run.
    const client = await getDB()
    if (await readHouseholdBoardState(client) === "locked") return
    const settingsRevision = _getSettingsRevision!()
    const environmentFingerprint = startupEnvironmentFingerprint()
    // Unconfigured standalone requests need no repeated settings DDL or startup logs.
    // Successful settings saves, a different database or changed environment bypass this pause.
    if (unconfiguredStartup?.client === client && unconfiguredStartup.settingsRevision === settingsRevision &&
        unconfiguredStartup.environmentFingerprint === environmentFingerprint && performance.now() < unconfiguredStartup.retryAfter) return
    unconfiguredStartup = undefined

    // Task deadlines are local domain transitions, including in standalone
    // mode or while HA is unavailable. The scheduler itself is idempotent.
    await autoStartDueDateReminders();

    // Only initialize when running as HA addon or configured standalone HA
    if (!(await getHAConfiguration())) {
      unconfiguredStartup = { client, settingsRevision, environmentFingerprint, retryAfter: performance.now() + UNCONFIGURED_RETRY_MS }
      logger.log("info", {
        event: "ha.startup.skipped",
        domain: "ha",
        component: "ha-startup",
        request_id: SYS_REQ,
        message: "Home Assistant is not configured; skipping HA integrations",
      });
      return;
    }

    // Step 1: Establish connection
    const conn = await getHAConnection();
    if (!conn) {
      logger.log("warn", {
        event: "ha.startup.no_connection",
        domain: "ha",
        component: "ha-startup",
        request_id: SYS_REQ,
        message: "Could not connect to HA Core — will retry on next request",
      });
      initializing = false;
      return; // Don't mark initialized — retry next request
    }

    // Step 2: Subscribe to entity states (populates the scoped in-memory cache)
    await initEntitySubscription(conn);
    logger.log("info", {
      event: "ha.startup.entities_subscribed",
      domain: "ha",
      component: "ha-startup",
      request_id: SYS_REQ,
      message: "Entity subscription initialized",
    });

    // Step 3: Read saved todo sync settings and auto-start
    await autoStartTodoSync();

    // Step 3.1: One-time cleanup of corrupt task titles from HA todo sync
    await cleanupCorruptTitleData();

    // Step 4: Read saved calendar sync settings and auto-start
    await autoStartCalendarSync();

    // Step 5: Auto-start Grocy sync from persisted settings
    await autoStartGrocySync();

    // Step 6: Validate webhook/n8n endpoints (non-blocking)
    await validateWebhookEndpoints();

    initialized = true;
    logger.log("info", {
      event: "ha.startup.complete",
      domain: "ha",
      component: "ha-startup",
      request_id: SYS_REQ,
      message: "All HA integrations initialized successfully",
    });
  } catch (err) {
    logger.log("error", {
      event: "ha.startup.failed",
      domain: "ha",
      component: "ha-startup",
      request_id: SYS_REQ,
      message: `HA integration startup failed: ${err}`,
    });
  } finally {
    initializing = false // Also allow retry after unconfigured/disconnected early returns
  }
}

/**
 * Read persisted todo sync settings from SQLite and auto-start sync.
 */
async function autoStartTodoSync(): Promise<void> {
  try {
    const client = await getDB();

    // Read todo sync settings
    const res = await client.execute({
      sql: "SELECT key, value FROM settings WHERE key IN ('todo_sync_enabled', 'todo_entity', 'todo_entities', 'todo_sync_direction')",
      args: [],
    });

    const settings: Record<string, string | boolean> = {};
    for (const row of res.rows) {
      if (typeof row.key === "string" && typeof row.value === "string") {
        // Settings values are stored JSON-encoded (with quotes)
        try {
          settings[row.key] = JSON.parse(row.value);
        } catch {
          settings[row.key] = row.value;
        }
      }
    }

    const enabled =
      settings.todo_sync_enabled === true ||
      settings.todo_sync_enabled === "true";
    const direction =
      (typeof settings.todo_sync_direction === "string" ? settings.todo_sync_direction : "bidirectional") as
        | "inbound"
        | "outbound"
        | "bidirectional";
    // Resolve entity IDs: prefer todo_entities array, fall back to todo_entity single key
    let entityIds: string[] = [];
    if (settings.todo_entities) {
      const raw = settings.todo_entities;
      if (Array.isArray(raw)) {
        entityIds = raw.filter((e): e is string => typeof e === "string" && e.length > 0);
      } else if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) entityIds = parsed.filter((e: unknown): e is string => typeof e === "string");
        } catch { /* fall through */ }
      }
    }
    if (entityIds.length === 0 && typeof settings.todo_entity === "string" && settings.todo_entity) {
      entityIds = [settings.todo_entity];
    }

    if (!enabled || entityIds.length === 0) {
      logger.log("info", {
        event: "ha.startup.todo_sync.skipped",
        domain: "todo",
        component: "ha-startup",
        request_id: SYS_REQ,
        message: `Todo sync not configured (enabled: ${enabled}, entities: ${entityIds.length})`,
      });
      return;
    }

    // Import and start todo sync for ALL enabled entities (bounded by 5s non-fatal cap)
    const { startTodoSync } = await import("@domains/todo");
    await withStartupCap(
      startTodoSync(
        entityIds.map((entityId) => ({
          entityId,
          syncEnabled: true,
          writeBack: direction === "outbound" || direction === "bidirectional",
          syncDirection: direction,
        })),
      ),
      5_000,
    );

    logger.log("info", {
      event: "ha.startup.todo_sync.started",
      domain: "todo",
      component: "ha-startup",
      request_id: SYS_REQ,
      message: `Auto-started todo sync for ${entityIds.length} entity/entities: ${entityIds.join(", ")} (direction: ${direction})`,
    });
  } catch (err) {
    logger.log("error", {
      event: "ha.startup.todo_sync.failed",
      domain: "todo",
      component: "ha-startup",
      request_id: SYS_REQ,
      message: `Failed to auto-start todo sync: ${err}`,
    });
  }
}

/**
 * Read persisted calendar sync settings from SQLite and auto-start sync.
 * Supports multi-calendar: reads `calendar_entities` JSON array first,
 * falls back to legacy `calendar_entity` single key.
 * Reads configurable interval from `calendar_sync_interval_ms`.
 */
async function autoStartCalendarSync(): Promise<void> {
  try {
    const { CALENDAR_ENTITY_SETTINGS, configuredCalendarEntityIds, startMultiCalendarSync, startCalDAVSync } =
      await import("@domains/calendar")
    const client = await getDB();

    const res = await client.execute({
      sql: `SELECT key, value FROM settings WHERE key IN (
        ${CALENDAR_ENTITY_SETTINGS.map(() => "?").join(", ")},
        'calendar_sync_enabled', 'calendar_write_back', 'calendar_sync_interval_ms',
        'calendar_sync_mode', 'calendar_sync_modes',
        'caldav_url'
      )`,
      args: [...CALENDAR_ENTITY_SETTINGS],
    });

    const settings: Record<string, string> = {};
    for (const row of res.rows) {
      if (typeof row.key === "string" && typeof row.value === "string") {
        try {
          settings[row.key] = JSON.parse(row.value);
        } catch {
          settings[row.key] = row.value;
        }
      }
    }

    const enabled = settings.calendar_sync_enabled !== "false";
    const writeBack = settings.calendar_write_back === "true";
    const syncIntervalMs = Number(settings.calendar_sync_interval_ms) || 5 * 60 * 1000;

    const entityIds = configuredCalendarEntityIds(settings)

    // Backward-compat migration: copy legacy key to canonical
    if (entityIds.length > 0 && !settings.calendar_entity && (settings.cal_entity || settings["calendar-entity"])) {
      try {
        await client.execute({
          sql: `INSERT INTO settings (key, value, updated_at) VALUES ('calendar_entity', ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          args: [JSON.stringify(entityIds[0]), Date.now()],
        });
        logger.log("info", {
          event: "ha.startup.calendar_sync.key_migrated",
          domain: "calendar", component: "ha-startup",
          request_id: SYS_REQ, message: `Migrated legacy calendar key to calendar_entity: ${entityIds[0]}`,
        });
      } catch { /* non-critical */ }
    }

    if (entityIds.length === 0 && !settings.caldav_url) {
      logger.log("info", {
        event: "ha.startup.calendar_sync.skipped",
        domain: "calendar",
        component: "ha-startup",
        request_id: SYS_REQ,
        message: "Calendar sync not configured (no HA entities or CalDAV set)",
      });
      return;
    }

    if (!enabled) {
      logger.log("info", {
        event: "ha.startup.calendar_sync.disabled",
        domain: "calendar",
        component: "ha-startup",
        request_id: SYS_REQ,
        message: `Calendar sync disabled for ${entityIds.length} entities`,
      });
      return;
    }

    type CalSyncMode = import("@domains/calendar").CalendarSyncMode;

    // Per-entity sync modes from settings (JSON map: {entity_id: mode})
    let perEntityModes: Record<string, CalSyncMode> = {};
    if (settings.calendar_sync_modes) {
      try {
        const parsed = typeof settings.calendar_sync_modes === "string"
          ? JSON.parse(settings.calendar_sync_modes)
          : settings.calendar_sync_modes;
        if (parsed && typeof parsed === "object") perEntityModes = parsed;
      } catch { /* invalid JSON */ }
    }
    const globalMode: CalSyncMode =
      (settings.calendar_sync_mode as CalSyncMode) ?? "bidirectional";

    const configs = entityIds.map((entityId) => {
      const mode = perEntityModes[entityId] ?? globalMode;
      return {
        entityId,
        syncEnabled: true,
        syncMode: mode,
        writeBack: mode !== "import" ? writeBack : false,
        syncIntervalMs,
      };
    });

    if (configs.length > 0) {
      await withStartupCap(startMultiCalendarSync(configs), 5_000);
    }

    if (settings.caldav_url) {
      await startCalDAVSync(settings.caldav_url, syncIntervalMs);
    }

    logger.log("info", {
      event: "ha.startup.calendar_sync.started",
      domain: "calendar",
      component: "ha-startup",
      request_id: SYS_REQ,
      message: `Auto-started calendar sync: ${entityIds.length} HA entities, CalDAV: ${!!settings.caldav_url} (interval: ${syncIntervalMs}ms)`,
      metadata: { entities: entityIds, caldav: !!settings.caldav_url, interval_ms: syncIntervalMs },
    });
  } catch (err) {
    logger.log("error", {
      event: "ha.startup.calendar_sync.failed",
      domain: "calendar",
      component: "ha-startup",
      request_id: SYS_REQ,
      message: `Failed to auto-start calendar sync: ${err}`,
    });
  }
}

const MAX_GROCY_STARTUP_RETRIES = 3
const GROCY_STARTUP_RETRY_DELAY_MS = 30_000
let grocyStartupRetryTimer: ReturnType<typeof setTimeout> | null = null
let grocyStartupEpoch = 0
let grocyStopHookRegistered = false

function resetGrocyStartupRetryTimer(): void {
  if (grocyStartupRetryTimer !== null) {
    clearTimeout(grocyStartupRetryTimer)
    grocyStartupRetryTimer = null
  }
}

export function clearGrocyStartupRetry(): void {
  grocyStartupEpoch++
  resetGrocyStartupRetryTimer()
}

function redactUrlForLog(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    parsed.username = ""
    parsed.password = ""
    return parsed.toString()
  } catch {
    return "<invalid-url>"
  }
}

/**
 * Read persisted Grocy sync settings from SQLite and auto-start sync.
 * Replaces the old validateGrocyConnection — now actually starts the sync
 * bridge instead of just pinging the API.
 */
export async function autoStartGrocySync(
  retryAttempt = 0,
  retryDelayMs = GROCY_STARTUP_RETRY_DELAY_MS,
): Promise<void> {
  const runEpoch = grocyStartupEpoch
  try {
    const { getGrocySyncStatus, onGrocySyncStopped, startGrocySync } = await import("@domains/grocy")
    if (!grocyStopHookRegistered) {
      onGrocySyncStopped(clearGrocyStartupRetry)
      grocyStopHookRegistered = true
    }
    const client = await getDB()

    // Read grocy sync settings
    const res = await client.execute({
      sql: "SELECT key, value FROM settings WHERE key IN ('grocy_url', 'grocy_api_key', 'grocy_sync_enabled', 'grocy_sync_mode', 'grocy_sync_interval')",
      args: [],
    })
    if (runEpoch !== grocyStartupEpoch) return

    const settings: Record<string, unknown> = {}
    for (const row of res.rows) {
      if (typeof row.key === "string" && typeof row.value === "string") {
        try {
          settings[row.key] = JSON.parse(row.value)
        } catch {
          settings[row.key] = row.value
        }
      }
    }

    const enabled =
      settings.grocy_sync_enabled === true ||
      settings.grocy_sync_enabled === 1 ||
      settings.grocy_sync_enabled === "true" ||
      settings.grocy_sync_enabled === "1"
    const url = typeof settings.grocy_url === "string" ? settings.grocy_url : ""
    const apiKey =
      typeof settings.grocy_api_key === "string"
        ? settings.grocy_api_key
        : typeof settings.grocy_api_key === "number" && Number.isFinite(settings.grocy_api_key)
          ? String(settings.grocy_api_key)
          : ""
    const syncMode: "import" | "export" | "bidirectional" =
      settings.grocy_sync_mode === "import" ||
      settings.grocy_sync_mode === "export" ||
      settings.grocy_sync_mode === "bidirectional"
        ? settings.grocy_sync_mode
        : "bidirectional"
    const rawInterval =
      settings.grocy_sync_interval !== undefined &&
      settings.grocy_sync_interval !== null &&
      settings.grocy_sync_interval !== ""
        ? Number(settings.grocy_sync_interval)
        : Number.NaN
    const intervalMs = Number.isFinite(rawInterval) && rawInterval >= 0 ? rawInterval : 15 * 60 * 1000

    if (!enabled || !url || !apiKey) {
      resetGrocyStartupRetryTimer()
      logger.log("info", {
        event: "ha.startup.grocy.skipped",
        domain: "integrations",
        component: "ha-startup",
        request_id: SYS_REQ,
        message: `Grocy sync not configured (enabled: ${enabled}, url: ${url ? "set" : "missing"}, key: ${apiKey ? "set" : "missing"})`,
      })
      return
    }

    // Validate & migrate Grocy URL through createGrocyClient before starting sync bridge
    const { createGrocyClient, isLegacySupervisorIngressUrl } = await import("../../lib/grocy-client")

    if (retryAttempt > 0 && getGrocySyncStatus().active) {
      resetGrocyStartupRetryTimer()
      return
    }

    const adapter = await createGrocyClient()
    if (runEpoch !== grocyStartupEpoch) return

    if (!adapter) {
      const canRetryLegacy =
        isLegacySupervisorIngressUrl(url) &&
        retryAttempt < MAX_GROCY_STARTUP_RETRIES &&
        grocyStartupRetryTimer === null
      logger.log("warn", {
        event: "ha.startup.grocy.skipped",
        domain: "integrations",
        component: "ha-startup",
        request_id: SYS_REQ,
        message: canRetryLegacy
          ? `Grocy add-on not yet resolvable on boot; scheduling retry ${retryAttempt + 1}/${MAX_GROCY_STARTUP_RETRIES}`
          : "Grocy sync skipped due to invalid or unresolvable Grocy configuration",
      })
      if (canRetryLegacy) {
        grocyStartupRetryTimer = setTimeout(() => {
          grocyStartupRetryTimer = null
          if (runEpoch !== grocyStartupEpoch) return
          void autoStartGrocySync(retryAttempt + 1, retryDelayMs)
        }, retryDelayMs)
        grocyStartupRetryTimer.unref?.()
      }
      return
    }

    resetGrocyStartupRetryTimer()
    startGrocySync(
      { syncEnabled: true, syncMode, intervalMs },
      adapter,
    )

    logger.log("info", {
      event: "ha.startup.grocy.started",
      domain: "integrations",
      component: "ha-startup",
      request_id: SYS_REQ,
      message: `Auto-started Grocy sync (mode: ${syncMode}, interval: ${intervalMs}ms)`,
    })
  } catch (err) {
    logger.log("error", {
      event: "ha.startup.grocy.failed",
      domain: "integrations",
      component: "ha-startup",
      request_id: SYS_REQ,
      message: `Failed to auto-start Grocy sync: ${err}`,
    })
  }
}

/**
 * Validate webhook/n8n endpoint reachability on boot.
 * Webhooks are event-driven (dispatched per task event), but checking
 * reachability on boot surfaces misconfigured URLs early.
 */
async function validateWebhookEndpoints(): Promise<void> {
  try {
    const client = await getDB()

    const res = await client.execute({
      sql: "SELECT key, value FROM settings WHERE key IN ('webhook_endpoint', 'n8n_webhook_url')",
      args: [],
    })

    const endpoints: { name: string; url: string }[] = []
    for (const row of res.rows) {
      if (typeof row.key === "string" && typeof row.value === "string") {
        let url = ""
        try {
          const parsed: unknown = JSON.parse(row.value)
          if (typeof parsed === "string") url = parsed.trim()
        } catch {
          url = row.value.trim()
        }
        if (url) {
          const name = row.key === "n8n_webhook_url" ? "n8n" : "webhook"
          endpoints.push({ name, url })
        }
      }
    }

    if (endpoints.length === 0) {
      logger.log("info", {
        event: "ha.startup.webhooks.skipped",
        domain: "integrations",
        component: "ha-startup",
        request_id: SYS_REQ,
        message: "No webhook endpoints configured",
      })
      return
    }

    // Validate each endpoint with a lightweight HEAD request under shared outbound policy
    for (const ep of endpoints) {
      const safeUrl = redactUrlForLog(ep.url)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      timeout.unref?.()
      try {
        const response = await fetchOutbound(ep.url, {
          method: "HEAD",
          allowPrivate: true,
          redirect: "error",
          signal: controller.signal,
        })
        await response.body?.cancel().catch(() => undefined)

        logger.log("info", {
          event: `ha.startup.${ep.name}.reachable`,
          domain: "integrations",
          component: "ha-startup",
          request_id: SYS_REQ,
          message: `${ep.name} endpoint reachable (${response.status}): ${safeUrl}`,
        })
      } catch (fetchErr) {
        const rawErr = fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
        const safeErr = ep.url ? rawErr.replaceAll(ep.url, safeUrl) : rawErr
        logger.log("warn", {
          event: `ha.startup.${ep.name}.unreachable`,
          domain: "integrations",
          component: "ha-startup",
          request_id: SYS_REQ,
          message: `${ep.name} endpoint unreachable: ${safeUrl} — ${safeErr}`,
        })
      } finally {
        clearTimeout(timeout)
      }
    }
  } catch (err) {
    logger.log("error", {
      event: "ha.startup.webhooks.failed",
      domain: "integrations",
      component: "ha-startup",
      request_id: SYS_REQ,
      message: `Webhook validation failed: ${err}`,
    })
  }
}

/**
 * Start the due-date reminder scheduler.
 * Sends notifications for tasks with upcoming due dates (within 1 hour).
 * Also creates calendar events as native phone reminders.
 */
async function autoStartDueDateReminders(): Promise<void> {
  try {
    const { startDueDateReminders } = await import(
      "@domains/notifications/due-date-reminders"
    );
    await startDueDateReminders();
  } catch (err) {
    logger.log("error", {
      event: "ha.startup.due_date_reminders.failed",
      domain: "notifications",
      component: "ha-startup",
      request_id: SYS_REQ,
      message: `Failed to start due-date reminder scheduler: ${err}`,
    });
  }
}

/**
 * One-time cleanup of corrupt task titles from HA todo sync.
 * Strips recursive MTH-NN prefixes and trailing DUE repetitions.
 * Idempotent — safe to call multiple times (no-ops on clean data).
 */
async function cleanupCorruptTitleData(): Promise<void> {
  try {
    const { cleanupCorruptTitles } = await import("@lib/cleanup-corrupt-titles");
    const cleaned = await cleanupCorruptTitles();
    if (cleaned > 0) {
      logger.log("info", {
        event: "ha.startup.title_cleanup.complete",
        domain: "tasks",
        component: "ha-startup",
        request_id: SYS_REQ,
        message: `Cleaned ${cleaned} corrupt task titles`,
        metadata: { cleaned },
      });
    }
  } catch (err) {
    logger.log("error", {
      event: "ha.startup.title_cleanup.failed",
      domain: "tasks",
      component: "ha-startup",
      request_id: SYS_REQ,
      message: `Title cleanup failed: ${err}`,
    });
  }
}

