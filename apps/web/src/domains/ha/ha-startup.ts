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
 * Called once from middleware.ts via a "lazy init" guard.
 * Must be idempotent — safe to call multiple times.
 *
 * @domain ha
 * @bounded-context integration
 */
import { initEntitySubscription } from "./ha-entities";
import { getHAConnection } from "./ha-connection";
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability";

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
let _dbReady = false;
let _getPersistenceClient: (() => ReturnType<typeof import("@domains/tasks/persistence/store")["getPersistenceClient"]>) | null = null;

async function getDB() {
  if (!_dbReady) {
    const mod = await import("@domains/tasks/persistence/store");
    await mod.ensureSchema();
    _getPersistenceClient = mod.getPersistenceClient;
    _dbReady = true;
  }
  return _getPersistenceClient!();
}

let initialized = false;
let initializing = false;

/**
 * Initialize all HA integrations. Idempotent — safe to call on every request.
 *
 * Flow:
 *   1. Establish WebSocket connection to HA Core
 *   2. Subscribe to entity state changes (populates entity cache)
 *   3. Auto-start Todo sync from persisted settings
 *   4. Auto-start Calendar sync from persisted settings
 *   5. Validate Grocy connectivity
 *   6. Validate n8n/webhook endpoint reachability
 */
export async function initHAIntegrations(): Promise<void> {
  if (initialized || initializing) return;
  initializing = true;

  try {
    // Only initialize when running as HA addon (SUPERVISOR_TOKEN present)
    if (!process.env.SUPERVISOR_TOKEN) {
      logger.log("info", {
        event: "ha.startup.skipped",
        domain: "ha",
        component: "ha-startup",
        request_id: SYS_REQ,
        message: "No SUPERVISOR_TOKEN — standalone mode, skipping HA integrations",
      });
      initialized = true;
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

    // Step 2: Subscribe to entity states (populates the in-memory cache)
    await initEntitySubscription();
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

    // Step 7: Start due-date reminder scheduler
    await autoStartDueDateReminders();

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
    initializing = false; // Allow retry on next request
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

    // Import and start todo sync for ALL enabled entities
    const { startTodoSync } = await import("@domains/todo");
    startTodoSync(
      entityIds.map((entityId) => ({
        entityId,
        syncEnabled: true,
        writeBack: direction === "outbound" || direction === "bidirectional",
        syncDirection: direction,
      })),
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
    const client = await getDB();

    const res = await client.execute({
      sql: `SELECT key, value FROM settings WHERE key IN (
        'calendar_entities', 'calendar_entity', 'cal_entity', 'calendar-entity',
        'calendar_sync_enabled', 'calendar_write_back', 'calendar_sync_interval_ms',
        'calendar_sync_mode', 'calendar_sync_modes',
        'caldav_url'
      )`,
      args: [],
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

    // Resolve entity list: prefer multi-calendar array, then legacy single key
    let entityIds: string[] = [];

    // Try calendar_entities (JSON array from multi-select UI)
    const entitiesRaw = settings.calendar_entities;
    if (entitiesRaw) {
      try {
        const parsed = typeof entitiesRaw === "string" ? JSON.parse(entitiesRaw) : entitiesRaw;
        if (Array.isArray(parsed)) {
          entityIds = parsed.filter((id: unknown) => typeof id === "string" && id.length > 0);
        }
      } catch { /* invalid JSON — fall through to legacy */ }
    }

    // Fallback: legacy single entity key
    if (entityIds.length === 0) {
      const legacyId =
        settings.calendar_entity ?? settings.cal_entity ?? settings["calendar-entity"];
      if (legacyId) entityIds = [legacyId];
    }

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

    const { startMultiCalendarSync, startCalDAVSync } = await import("@domains/calendar/calendar-bridge");
    type CalSyncMode = import("@domains/calendar/calendar-bridge").CalendarSyncMode;

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
      startMultiCalendarSync(configs);
    }

    if (settings.caldav_url) {
      startCalDAVSync(settings.caldav_url, syncIntervalMs);
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

/**
 * Read persisted Grocy sync settings from SQLite and auto-start sync.
 * Replaces the old validateGrocyConnection — now actually starts the sync
 * bridge instead of just pinging the API.
 */
async function autoStartGrocySync(): Promise<void> {
  try {
    const client = await getDB();

    // Read grocy sync settings
    const res = await client.execute({
      sql: "SELECT key, value FROM settings WHERE key IN ('grocy_url', 'grocy_api_key', 'grocy_sync_enabled', 'grocy_sync_mode', 'grocy_sync_interval')",
      args: [],
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

    const enabled =
      settings.grocy_sync_enabled === "true" || settings.grocy_sync_enabled === "1";
    const url = settings.grocy_url;
    const apiKey = settings.grocy_api_key;
    const syncMode = (settings.grocy_sync_mode ?? "bidirectional") as
      | "import"
      | "export"
      | "bidirectional";
    const intervalMs = Number(settings.grocy_sync_interval) || 15 * 60 * 1000;

    if (!enabled || !url || !apiKey) {
      logger.log("info", {
        event: "ha.startup.grocy.skipped",
        domain: "integrations",
        component: "ha-startup",
        request_id: SYS_REQ,
        message: `Grocy sync not configured (enabled: ${enabled}, url: ${url ? "set" : "missing"}, key: ${apiKey ? "set" : "missing"})`,
      });
      return;
    }

    // Import and start Grocy sync bridge
    const { GrocyAdapter } = await import("@meitheal/integration-core");
    const { startGrocySync } = await import("@domains/grocy");

    const adapter = new GrocyAdapter({ baseUrl: url, apiKey });

    startGrocySync(
      { syncEnabled: true, syncMode, intervalMs },
      adapter,
    );

    logger.log("info", {
      event: "ha.startup.grocy.started",
      domain: "integrations",
      component: "ha-startup",
      request_id: SYS_REQ,
      message: `Auto-started Grocy sync (mode: ${syncMode}, interval: ${intervalMs}ms)`,
    });
  } catch (err) {
    logger.log("error", {
      event: "ha.startup.grocy.failed",
      domain: "integrations",
      component: "ha-startup",
      request_id: SYS_REQ,
      message: `Failed to auto-start Grocy sync: ${err}`,
    });
  }
}

/**
 * Validate webhook/n8n endpoint reachability on boot.
 * Webhooks are event-driven (dispatched per task event), but checking
 * reachability on boot surfaces misconfigured URLs early.
 */
async function validateWebhookEndpoints(): Promise<void> {
  try {
    const client = await getDB();

    const res = await client.execute({
      sql: "SELECT key, value FROM settings WHERE key IN ('webhook_endpoint', 'n8n_webhook_url')",
      args: [],
    });

    const endpoints: { name: string; url: string }[] = [];
    for (const row of res.rows) {
      if (typeof row.key === "string" && typeof row.value === "string") {
        let url: string;
        try {
          url = JSON.parse(row.value);
        } catch {
          url = row.value;
        }
        if (url) {
          const name = row.key === "n8n_webhook_url" ? "n8n" : "webhook";
          endpoints.push({ name, url });
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
      });
      return;
    }

    // Validate each endpoint with a lightweight HEAD/GET request
    for (const ep of endpoints) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        // Use HEAD to minimize payload; fall back to GET if HEAD fails
        const response = await fetch(ep.url, {
          method: "HEAD",
          signal: controller.signal,
        });
        clearTimeout(timeout);

        logger.log("info", {
          event: `ha.startup.${ep.name}.reachable`,
          domain: "integrations",
          component: "ha-startup",
          request_id: SYS_REQ,
          message: `${ep.name} endpoint reachable (${response.status}): ${ep.url}`,
        });
      } catch (fetchErr) {
        logger.log("warn", {
          event: `ha.startup.${ep.name}.unreachable`,
          domain: "integrations",
          component: "ha-startup",
          request_id: SYS_REQ,
          message: `${ep.name} endpoint unreachable: ${ep.url} — ${fetchErr}`,
        });
      }
    }
  } catch (err) {
    logger.log("error", {
      event: "ha.startup.webhooks.failed",
      domain: "integrations",
      component: "ha-startup",
      request_id: SYS_REQ,
      message: `Webhook validation failed: ${err}`,
    });
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
    startDueDateReminders();
    logger.log("info", {
      event: "ha.startup.due_date_reminders.started",
      domain: "notifications",
      component: "ha-startup",
      request_id: SYS_REQ,
      message: "Due-date reminder scheduler started",
    });
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

