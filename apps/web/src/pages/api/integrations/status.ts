/**
 * Integration Status API — GET /api/integrations/status
 *
 * Returns health and delivery status for all active integrations:
 * n8n/Node-RED mode, event configuration, HA event bus health,
 * and webhook subscriber status.
 *
 * @domain integrations
 * @bounded-context event-dispatch
 */
import type { APIRoute } from "astro";
import { getHAConnectionStatus } from "../../../domains/ha";
import { logApiError } from "../../../lib/api-logger";

export const GET: APIRoute = async () => {
  try {
    const { ensureSchema, getPersistenceClient } = await import("@domains/tasks/persistence/store")
    const { SettingsRepository } = await import("@domains/tasks/persistence/settings-repository")
    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())
    await repo.ensureSettingsTable()

    // Read integration settings via repository
    const settingKeys = ["n8n_mode", "n8n_events", "n8n_webhook_url", "webhook_endpoint", "webhook_secret"]
    const settings: Record<string, unknown> = {}
    for (const key of settingKeys) {
      const result = await repo.getByKey(key)
      if (result) {
        settings[key] = result.value
      }
    }

    // HA connection status (for event bus health)
    const haStatus = getHAConnectionStatus();

    // N8n / Node-RED status
    const n8nMode = settings.n8n_mode ?? (process.env.SUPERVISOR_TOKEN ? "ha_addon" : "standalone");
    let n8nEvents: string[] = []
    try {
      const raw = settings.n8n_events
      if (typeof raw === "string") n8nEvents = JSON.parse(raw)
      else if (Array.isArray(raw)) n8nEvents = raw
    } catch { /* default to empty */ }
    const defaultEvents = ["task.created", "task.updated", "task.completed", "task.deleted", "task.overdue"];

    // Webhooks status
    const hasGenericWebhook = !!settings.webhook_endpoint;
    const hasN8nWebhook = !!settings.n8n_webhook_url;

    return new Response(JSON.stringify({
      n8n_nodered: {
        mode: n8nMode,
        ha_event_bus: {
          available: !!process.env.SUPERVISOR_TOKEN,
          connected: haStatus.connected,
          event_types: ["meitheal_task_created", "meitheal_task_updated", "meitheal_task_completed", "meitheal_task_deleted", "meitheal_task_overdue", "meitheal_area_updated"],
          enabled_events: n8nEvents.length > 0 ? n8nEvents : defaultEvents,
        },
        standalone_webhook: {
          configured: hasN8nWebhook,
          url: hasN8nWebhook ? "***configured***" : null,
          events: n8nEvents.length > 0 ? n8nEvents : ["*"],
        },
      },
      generic_webhook: {
        configured: hasGenericWebhook,
        url: hasGenericWebhook ? "***configured***" : null,
        has_secret: !!settings.webhook_secret,
      },
      ha_connection: {
        connected: haStatus.connected,
        version: haStatus.haVersion,
        last_error: haStatus.lastError,
        reconnect_attempts: haStatus.reconnectAttempts,
        supervisor_token_present: !!process.env.SUPERVISOR_TOKEN, // nosemgrep
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    logApiError("integrations-status", "Failed to fetch integration status", err);
    return new Response(JSON.stringify({ error: "Failed to fetch status" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};
