/**
 * Webhook Dispatcher — Unified Event Pipeline
 *
 * Dispatches task events to:
 *   1. HA Event Bus (Addon mode — for Node-RED/n8n auto integration)
 *   2. HTTP Webhooks (Standalone mode — n8n/Node-RED/generic webhooks)
 *
 * Every task CRUD operation calls `dispatchTaskEvent`, making this
 * the single integration point for all outbound event delivery.
 *
 * @domain integrations
 * @bounded-context event-dispatch
 */
import { getPersistenceClient } from "@domains/tasks/persistence/store";
import { type DomainEvent, type WebhookSubscriberConfig, emitWebhook } from "@meitheal/integration-core";
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability";
import { fireHAEvent, type MeithealTaskEventData, type MeithealEventType } from "@domains/ha/ha-events";

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["integrations"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: false,
});

/**
 * Map webhook event types → HA event bus event types.
 * Node-RED/n8n listen for these via HA WebSocket `events: all` or
 * `events: state_changed` triggers.
 */
const HA_EVENT_MAP: Record<string, MeithealEventType> = {
  "task.created": "meitheal_task_created",
  "task.updated": "meitheal_task_updated",
  "task.completed": "meitheal_task_completed",
  "task.deleted": "meitheal_task_deleted",
  "task.overdue": "meitheal_task_overdue",
  "board.updated": "meitheal_board_updated",
};

/**
 * Read n8n auto-mode event filter from settings.
 * The Settings UI persists events under `n8n_events` for both auto and
 * standalone modes. Returns the list of enabled event types, defaulting to all.
 */
// P2.2: Cache n8n auto events with TTL to avoid DB reads on every task event
let _cachedN8nEvents: string[] | null = null;
let _n8nEventsCachedAt = 0;
const N8N_EVENTS_TTL_MS = 60_000; // 60 seconds

async function getN8nAutoEvents(): Promise<string[]> {
  const now = Date.now();
  if (_cachedN8nEvents && (now - _n8nEventsCachedAt) < N8N_EVENTS_TTL_MS) {
    return _cachedN8nEvents;
  }
  try {
    const client = getPersistenceClient();
    const result = await client.execute(
      "SELECT value FROM settings WHERE key = 'n8n_events'"
    );
    if (result.rows.length > 0) {
      const parsed = JSON.parse(String(result.rows[0]!.value));
      if (Array.isArray(parsed) && parsed.length > 0) {
        _cachedN8nEvents = parsed;
        _n8nEventsCachedAt = now;
        return parsed;
      }
    }
  } catch { /* fall through to defaults */ }
  // Default: all events enabled
  const defaults = ["task.created", "task.updated", "task.completed", "task.deleted"];
  _cachedN8nEvents = defaults;
  _n8nEventsCachedAt = now;
  return defaults;
}

// P2.1: Cache webhook/n8n settings with TTL
let _cachedWebhookSettings: Record<string, unknown> | null = null;
let _webhookSettingsCachedAt = 0;

async function getCachedWebhookSettings(): Promise<Record<string, unknown>> {
  const now = Date.now();
  if (_cachedWebhookSettings && (now - _webhookSettingsCachedAt) < N8N_EVENTS_TTL_MS) {
    return _cachedWebhookSettings;
  }
  const settings: Record<string, unknown> = {};
  try {
    const client = getPersistenceClient();
    const result = await client.execute(
      "SELECT key, value FROM settings WHERE key IN ('webhook_endpoint', 'webhook_secret', 'n8n_webhook_url', 'n8n_events', 'n8n_api_key', 'n8n_signing_secret')"
    );
    for (const row of result.rows) {
      try {
        settings[String(row.key)] = JSON.parse(String(row.value));
      } catch {
        settings[String(row.key)] = String(row.value);
      }
    }
  } catch { /* no webhook settings — empty */ }
  _cachedWebhookSettings = settings;
  _webhookSettingsCachedAt = now;
  return settings;
}

/**
 * Reset all module-scoped webhook caches. Test-only.
 * Must be called in `beforeEach` to prevent stale settings leaking across tests.
 */
export function resetWebhookCacheForTests(): void {
  _cachedWebhookSettings = null;
  _webhookSettingsCachedAt = 0;
  _cachedN8nEvents = null;
  _n8nEventsCachedAt = 0;
}

export async function dispatchTaskEvent(eventType: string, payload: Record<string, unknown>, requestId?: string) {
  try {
    // ── 1. HA Event Bus (Addon mode — Node-RED/n8n auto) ──
    // Fire meitheal_task_* events on the HA event bus so Node-RED/n8n
    // can trigger on them via the HA WebSocket integration.
    const haEventType = HA_EVENT_MAP[eventType];
    if (haEventType && process.env.SUPERVISOR_TOKEN) {
      const enabledEvents = await getN8nAutoEvents();
      if (enabledEvents.includes(eventType) || enabledEvents.includes("*")) {
        const eventData: MeithealTaskEventData = {
          task_id: String(payload.id ?? ""),
          title: String(payload.title ?? ""),
          ...(payload.board_id ? { board_id: String(payload.board_id) } : {}),
          ...(payload.board_name ? { board_name: String(payload.board_name) } : {}),
          ...(payload.priority != null ? { priority: String(payload.priority) } : {}),
          ...(payload.due_date ? { due_date: String(payload.due_date) } : {}),
          ...(payload.assigned_to ? { assigned_to: String(payload.assigned_to) } : {}),
          // Phase 61: Enriched fields for richer Node-RED/n8n automations
          ...(payload.status ? { status: String(payload.status) } : {}),
          ...(payload.labels ? { labels: String(payload.labels) } : {}),
          ...(payload.ticket_key ? { ticket_key: String(payload.ticket_key) } : {}),
          ...(payload.task_type ? { task_type: String(payload.task_type) } : {}),
          ...(payload.description ? { description: String(payload.description).slice(0, 200) } : {}),
        };

        // Fire the mapped event type
        fireHAEvent(haEventType, eventData).catch(() => {});

        // Also fire "completed" event when a task is updated to done status
        if (eventType === "task.updated" && payload.status === "complete") {
          fireHAEvent("meitheal_task_completed", {
            ...eventData,
            completed_at: new Date().toISOString(),
          }).catch(() => {});
        }

        logger.log("info", {
          event: "integration.ha_event.dispatched",
          domain: "integrations",
          component: "webhook-dispatcher",
          request_id: requestId ?? "unknown",
          message: `Fired HA event: ${haEventType} for task ${eventData.task_id}`,
        });
      }
    }

    // ── 2. HTTP Webhooks (Standalone mode) ──
    // P2.1: Cache webhook settings with TTL to avoid DB reads on every event
    const webhookSettings = await getCachedWebhookSettings();

    const subscribers: WebhookSubscriberConfig[] = [];

    if (webhookSettings.webhook_endpoint) {
      subscribers.push({
        id: "generic-webhook",
        url: String(webhookSettings.webhook_endpoint),
        secret: String(webhookSettings.webhook_secret || ""),
        events: ["*"],
        enabled: true,
      });
    }

    if (webhookSettings.n8n_webhook_url) {
      let events = ["*"];
      if (Array.isArray(webhookSettings.n8n_events) && webhookSettings.n8n_events.length > 0) {
        events = webhookSettings.n8n_events;
      }
      const n8nHeaders: Record<string, string> = {};
      if (webhookSettings.n8n_api_key) {
        n8nHeaders["authorization"] = `Bearer ${String(webhookSettings.n8n_api_key)}`;
      }
      subscribers.push({
        id: "n8n-webhook",
        url: String(webhookSettings.n8n_webhook_url),
        secret: webhookSettings.n8n_signing_secret ? String(webhookSettings.n8n_signing_secret) : "",
        events,
        enabled: true,
        ...(Object.keys(n8nHeaders).length > 0 ? { headers: n8nHeaders } : {}),
      });
    }

    if (subscribers.length > 0) {
      const event: DomainEvent = {
        eventId: crypto.randomUUID(),
        eventType,
        occurredAt: new Date().toISOString(),
        requestId: requestId ?? crypto.randomUUID(),
        payload,
      };

      // Dispatch background webhook requests without blocking
      Promise.allSettled(
        subscribers
          .filter(s => s.events.includes("*") || s.events.includes(eventType))
          .map(async (s) => {
            const res = await emitWebhook(event, s);
            logger.log(res.ok ? "info" : "warn", {
              event: "integration.webhook.dispatched",
              domain: "integrations",
              component: "webhook-dispatcher",
              request_id: event.requestId,
              message: `Dispatched to ${s.id}. Status: ${res.statusCode}. Attempts: ${res.attempts}. Error: ${res.finalError ?? "none"}`
            });
          })
      );
    }

    // ── 3. Outbound Sync (Todo + Calendar push) ──
    // Push task mutations to active sync targets (fire-and-forget).
    // Handles loop prevention and no-sync labels internally.
    import("./sync-outbound").then(({ pushToActiveSyncs }) => {
      pushToActiveSyncs(eventType, payload).catch(() => {});
    }).catch(() => {});
  } catch (err) {
    logger.log("error", {
      event: "integration.webhook.failed",
      domain: "integrations",
      component: "webhook-dispatcher",
      request_id: requestId ?? "unknown",
      message: err instanceof Error ? err.message : String(err)
    });
  }
}
