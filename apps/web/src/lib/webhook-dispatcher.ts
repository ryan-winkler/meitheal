import {
  TaskRepository, getPersistenceClient, projectPublicTaskFields, readWorkDestinations,
  resolveIntegrationScope, validateIntegrationScope, validateBoardScope, validateTaskOperation,
  readTaskDeletionReceipt, readTaskAssignmentReceipt, validateBoardPlacement,
  type BoardScope, type WorkOperation, type TaskDeletionReceipt, type TaskAssignmentReceipt,
} from "@domains/tasks"
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
  "task.commented": "meitheal_task_commented",
  "area.updated": "meitheal_area_updated",
};

export const HA_EVENT_AUTHORITY_HEADER = "X-Meitheal-HA-Event-Authority"

/** Responsibility for this response's events, never a delivery receipt.
 * Keep native fallback when the App bus is absent or the event is disabled.
 * This only reads local policy; it never waits for a HA connection.
 */
export async function taskEventAuthorityHeaders(eventTypes: string[], scope: BoardScope): Promise<Record<string, string>> {
  if (!process.env.SUPERVISOR_TOKEN) return {}
  const enabled = await getN8nAutoEvents()
  const owned: MeithealEventType[] = []
  for (const type of eventTypes) {
    if (!HA_EVENT_MAP[type] || !(enabled.includes(type) || enabled.includes("*"))) continue
    const allowed = await outboundChannelAuthority(scope, "ha_events", "meitheal", eventOperation(type))
    if (allowed && await allowed()) owned.push(HA_EVENT_MAP[type]!)
  }
  return owned.length ? { [HA_EVENT_AUTHORITY_HEADER]: [...new Set(owned)].join(",") } : {}
}

/**
 * Read n8n auto-mode event filter from settings.
 * The Settings UI persists events under `n8n_events` for both auto and
 * standalone modes. Returns the list of enabled event types, defaulting to all.
 */
async function getN8nAutoEvents(): Promise<string[]> {
  const { rows: [row] } = await getPersistenceClient().execute({ sql: "SELECT value FROM settings WHERE key='n8n_events'", args: [] })
  if (!row) return ["task.created", "task.updated", "task.completed", "task.deleted", "task.overdue", "task.commented"]
  try {
    const value: unknown = JSON.parse(String(row.value))
    return Array.isArray(value) && value.every(item => typeof item === "string") ? value : []
  } catch { return [] }
}

/** Read transport configuration fresh; a TTL cannot establish receiver authority. */
async function getCurrentWebhookSettings(): Promise<Record<string, unknown>> {
  const result = await getPersistenceClient().execute(
    "SELECT key,value FROM settings WHERE key IN ('webhook_endpoint','webhook_secret','n8n_webhook_url','n8n_events','n8n_api_key','n8n_signing_secret') ORDER BY key"
  )
  const settings: Record<string, unknown> = {}
  for (const row of result.rows) {
    try { settings[String(row.key)] = JSON.parse(String(row.value)) }
    catch { settings[String(row.key)] = String(row.value) }
  }
  return settings
}

/** Kept for existing test/setup callers; transport configuration is no longer cached. */
export function resetWebhookCacheForTests(): void {}

function eventOperation(eventType: string): WorkOperation {
  return { resource: "task", action: eventType === "task.created" ? "create" : eventType === "task.deleted" ? "delete"
    : eventType === "task.completed" ? "complete" : eventType === "task.overdue" ? "read" : "edit" }
}

async function outboundChannelAuthority(scope: BoardScope, integration: string, sourceId: string,
  originatingOperation: WorkOperation, taskId?: string, receipt?: TaskDeletionReceipt | TaskAssignmentReceipt): Promise<(() => Promise<boolean>) | null> {
  const db = getPersistenceClient()
  if (!(await validateBoardScope(scope, db, originatingOperation)).ok) return null
  const configuration = await readWorkDestinations(db)
  for (const binding of configuration?.bindings ?? []) {
    if (!binding.enabled || binding.integration !== integration || binding.sourceId !== sourceId ||
      binding.destination.boardId !== scope.boardId || binding.purpose !== "webhook.delivery") continue
    const service = await resolveIntegrationScope(db, binding.id, binding.generation, { resource: "task", action: "read" })
    if (!service.ok) continue
    if (receipt) {
      if (!receipt.bindingRefs.some(ref => ref.id === binding.id && ref.generation === binding.generation)) continue
      if (binding.destination.areaId && binding.destination.areaId !== receipt.placement.areaId ||
        binding.destination.projectId && binding.destination.projectId !== receipt.placement.projectId) continue
      if (!await validateBoardPlacement(service.value.scope, db, {
        areaId: typeof receipt.placement.areaId === "string" ? receipt.placement.areaId : null,
        projectId: typeof receipt.placement.projectId === "string" ? receipt.placement.projectId : null,
      })) continue
    }
    if (taskId && !await new TaskRepository(db, service.value.scope).findById(taskId)) continue
    if (taskId && !await validateTaskOperation(db, scope, taskId, originatingOperation)) continue
    if (integration === "ha_events") {
      const { rows: [board] } = await db.execute({ sql: "SELECT visibility FROM task_boards WHERE id = ?", args: [scope.boardId] })
      if (board?.visibility !== "shared") continue
      const { rows } = await db.execute({ sql: "SELECT 1 FROM organization_access_policies WHERE board_id = ? AND audience <> 'everyone' LIMIT 1", args: [scope.boardId] })
      if (rows.length) continue
    }
    return async () => (await validateBoardScope(scope, db, originatingOperation)).ok &&
      (await validateIntegrationScope(service.value, db, { resource: "task", action: "read" })).ok &&
      (!receipt || Boolean(await ("deletedAt" in receipt ? readTaskDeletionReceipt(db, scope, receipt.eventId, receipt.id) : readTaskAssignmentReceipt(db, scope, receipt.eventId, receipt.id)))) &&
      (!receipt || await validateBoardPlacement(service.value.scope, db, {
        areaId: typeof receipt.placement.areaId === "string" ? receipt.placement.areaId : null,
        projectId: typeof receipt.placement.projectId === "string" ? receipt.placement.projectId : null,
      })) &&
      (!taskId || await validateTaskOperation(db, scope, taskId, originatingOperation)) &&
      (!taskId || Boolean(await new TaskRepository(db, service.value.scope).findById(taskId)))
  }
  return null
}

/** A source binding does not itself approve disclosure on the shared HA bus. */
export async function haEventOperationAllowed(
  scope: BoardScope, originatingOperation: WorkOperation = { resource: "task", action: "read" }, taskId?: string,
): Promise<boolean> {
  const allowed = await outboundChannelAuthority(scope, "ha_events", "meitheal", originatingOperation, taskId)
  return Boolean(allowed && await allowed())
}

export async function dispatchTaskEvent(eventType: string, input: Record<string, unknown>,
  requestId: string | undefined, traceId: string | undefined, eventId: string | undefined,
  responseAuthority: Record<string, string> | undefined, scope: BoardScope) {
  try {
    const haEventType = HA_EVENT_MAP[eventType];
    const hasHaBus = Boolean(haEventType && process.env.SUPERVISOR_TOKEN);
    const earlyWebhookSettings = !hasHaBus && eventType !== "task.deleted" && !eventId
      ? await getCurrentWebhookSettings()
      : null;
    if (earlyWebhookSettings && !earlyWebhookSettings.webhook_endpoint && !earlyWebhookSettings.n8n_webhook_url) {
      return;
    }

    const assignment = eventType === "task.updated" && typeof eventId === "string" && typeof input.id === "string"
      ? await readTaskAssignmentReceipt(getPersistenceClient(), scope, eventId, input.id) : null
    const originatingOperation: WorkOperation = assignment ? { resource: "task", action: "assign" } : eventOperation(eventType)
    const originAllowed = async () => (await validateBoardScope(scope, getPersistenceClient(), originatingOperation)).ok
    if (!await originAllowed()) return
    if (typeof input.board_id === "string" && input.board_id !== scope.boardId) return
    const deletion = eventType === "task.deleted"
      ? typeof eventId === "string" && typeof input.id === "string"
        ? await readTaskDeletionReceipt(getPersistenceClient(), scope, eventId, input.id) : null
      : undefined
    if (eventType === "task.deleted" && !deletion) return
    const payload: Record<string, unknown> = { ...projectPublicTaskFields(deletion?.task ?? assignment?.task ?? input), board_id: scope.boardId }
    if (eventType === "task.commented") {
      for (const key of ["comment_id", "author", "content"] as const) {
        if (typeof input[key] === "string" || key === "comment_id" && typeof input[key] === "number") payload[key] = input[key]
      }
      if (input.comment && typeof input.comment === "object" && !Array.isArray(input.comment)) {
        const comment = input.comment as Record<string, unknown>
        payload.comment = Object.fromEntries(["id", "author", "excerpt", "by_agent"].filter(key => Object.hasOwn(comment, key)).map(key => [key, comment[key]]))
      }
    }
    const taskId = eventType === "task.deleted" || assignment ? undefined : typeof payload.id === "string" ? payload.id : undefined
    // ── 1. HA Event Bus (Addon mode — Node-RED/n8n auto) ──
    // Fire meitheal_task_* events on the HA event bus so Node-RED/n8n
    // can trigger on them via the HA WebSocket integration.
    if (haEventType && process.env.SUPERVISOR_TOKEN) {
      const authority = assignment ? { [HA_EVENT_AUTHORITY_HEADER]: haEventType } : responseAuthority ?? await taskEventAuthorityHeaders([eventType], scope);
      if (authority[HA_EVENT_AUTHORITY_HEADER]?.split(",").includes(haEventType)) {
        const eventData: MeithealTaskEventData = {
          task_id: String(payload.id ?? ""),
          title: String(payload.title ?? ""),
          ...(payload.area_id ? { area_id: String(payload.area_id) } : {}),
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
          ...(payload.comment_id != null ? { comment_id: Number(payload.comment_id) } : {}),
          ...(payload.author ? { author: String(payload.author) } : {}),
        };

        // Fire the mapped event type
        const operationAllowed = await outboundChannelAuthority(scope, "ha_events", "meitheal", originatingOperation, taskId, deletion ?? assignment ?? undefined)
        if (operationAllowed && await operationAllowed()) {
          fireHAEvent(haEventType, eventData, { operationAllowed }).catch(() => {})
          logger.log("info", {
            event: "integration.ha_event.queued", domain: "integrations", component: "webhook-dispatcher",
            request_id: requestId ?? "unknown", message: "Queued an approved Home Assistant event delivery",
          })
        }
      }
    }

    // ── 2. HTTP Webhooks (Standalone mode) ──
    // P2.1: Cache webhook settings with TTL to avoid DB reads on every event
    const webhookSettings = earlyWebhookSettings ?? await getCurrentWebhookSettings();
    const profileFingerprint = JSON.stringify(webhookSettings)

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
      if (Array.isArray(webhookSettings.n8n_events)) {
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
        eventId: eventId ?? crypto.randomUUID(),
        eventType,
        occurredAt: new Date().toISOString(),
        requestId: requestId ?? crypto.randomUUID(),
        payload,
        ...(traceId ? { traceId } : {}),
      };

      // Dispatch background webhook requests without blocking
      Promise.allSettled(
        subscribers
          .filter(s => s.events.includes("*") || s.events.includes(eventType))
          .map(async (s) => {
            const channelAllowed = await outboundChannelAuthority(scope, "webhook", s.id, originatingOperation, taskId, deletion ?? assignment ?? undefined)
            const operationAllowed = async () => Boolean(channelAllowed && await channelAllowed()) &&
              JSON.stringify(await getCurrentWebhookSettings()) === profileFingerprint
            if (!await operationAllowed()) return
            const res = await emitWebhook(event, s, { operationAllowed });
            
            // Save last n8n delivery result for the UI
            if (s.id === "n8n-webhook") {
              try {
                const client = getPersistenceClient();
                await client.execute({
                  sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                  args: [
                    "n8n_last_delivery",
                    JSON.stringify({ 
                      success: res.ok, 
                      status: res.statusCode, 
                      timestamp: new Date().toISOString(),
                      error: res.ok ? null : "delivery_failed"
                    }),
                    Date.now()
                  ]
                });
              } catch (e) {
                // Non-critical, just for UI
              }
            }
            
            logger.log(res.ok ? "info" : "warn", {
              event: "integration.webhook.dispatched",
              domain: "integrations",
              component: "webhook-dispatcher",
              request_id: event.requestId,
              message: `Webhook delivery status: ${res.statusCode}. Attempts: ${res.attempts}.`
            });
          })
      );
    }

    if (assignment) {
      const { notifyTaskHandback } = await import("@domains/notifications")
      await notifyTaskHandback(scope, assignment.eventId, assignment.id).catch(() => {})
      // Assignment and its optional comment do not change provider Task fields.
      return
    }

    // ── 3. Outbound Sync (Todo + Calendar push) ──
    // Push task mutations to active sync targets (fire-and-forget).
    // Handles loop prevention and no-sync labels internally.
    import("./sync-outbound").then(async ({ pushToActiveSyncs }) => {
      if (!await originAllowed()) return
      pushToActiveSyncs(eventType, payload, scope, deletion ?? undefined).catch(() => {});
    }).catch(() => {});
  } catch (err) {
    logger.log("error", {
      event: "integration.webhook.failed",
      domain: "integrations",
      component: "webhook-dispatcher",
      request_id: requestId ?? "unknown",
      message: "Task event delivery unavailable"
    });
  }
}
