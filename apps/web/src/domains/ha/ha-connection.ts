/**
 * HA WebSocket Connection — Server-Side Singleton
 *
 * Connects to HA Core via the Supervisor internal proxy using
 * `home-assistant-js-websocket`. Uses `SUPERVISOR_TOKEN` for auth.
 *
 * Architecture:
 *   Addon Server → ws://supervisor/core/websocket → HA Core
 *
 * @domain ha
 * @bounded-context integration
 */
import {
  createConnection,
  createLongLivedTokenAuth,
  ERR_CANNOT_CONNECT,
  ERR_INVALID_AUTH,
  type Connection,
  type HassConfig,
} from "home-assistant-js-websocket";
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability";

// Polyfill WebSocket for Node.js server-side usage
import WebSocket from "ws";
import { supervisorFetch } from "../../lib/supervisor-fetch";
(globalThis as Record<string, unknown>).WebSocket = WebSocket;

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["ha"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: false,
});

const SYS_REQ = "ha-system"; // sentinel request_id for background operations

// ── State ──

let connection: Connection | null = null;
let connecting = false;
let lastError: string | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null; // Guard against rapid reconnect races
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
const MAX_RECONNECT_DELAY_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

// ── Connection Status Events ──
// Allows sidebar/UI to subscribe to connection state changes

export type HAConnectionState = "connected" | "disconnected" | "reconnecting" | "error";
type StatusListener = (state: HAConnectionState, detail?: string) => void;
const statusListeners: Set<StatusListener> = new Set();

/** Subscribe to connection state changes — returns unsubscribe function */
export function onHAConnectionStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener) };
}

function emitStatus(state: HAConnectionState, detail?: string): void {
  for (const listener of statusListeners) {
    try { listener(state, detail) } catch { /* never crash emitter */ }
  }
}

// ── Public API ──

export async function getHAConnection(): Promise<Connection | null> {
  if (connection) return connection;
  if (connecting) {
    // Wait for in-flight connection with timeout — both branches clear both timers
    return new Promise((resolve) => {
      let check: ReturnType<typeof setInterval> | null = null;
      const timeout = setTimeout(() => {
        if (check) clearInterval(check);
        resolve(connection);
      }, 15_000);
      check = setInterval(() => {
        if (!connecting) {
          clearInterval(check!);
          clearTimeout(timeout);
          resolve(connection);
        }
      }, 100);
    });
  }

  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) {
    logger.log("info", {
      event: "ha.connection.skipped", domain: "ha", component: "ha-connection",
      request_id: SYS_REQ, message: "SUPERVISOR_TOKEN not set — standalone mode",
    });
    return null;
  }

  connecting = true;
  try {
    const auth = createLongLivedTokenAuth("http://supervisor/core", token);
    connection = await createConnection({ auth });
    reconnectAttempts = 0;
    lastError = null;

    logger.log("info", {
      event: "ha.connection.established", domain: "ha", component: "ha-connection",
      request_id: SYS_REQ, message: `Connected to HA Core v${connection.haVersion}`,
    });

    connection.addEventListener("disconnected", () => {
      stopHeartbeat();
      emitStatus("disconnected");
      logger.log("warn", {
        event: "ha.connection.disconnected", domain: "ha", component: "ha-connection",
        request_id: SYS_REQ, message: "Disconnected from HA Core — auto-reconnect will attempt",
      });
    });

    connection.addEventListener("ready", () => {
      reconnectAttempts = 0;
      startHeartbeat();
      emitStatus("connected", `HA ${connection?.haVersion}`);
      logger.log("info", {
        event: "ha.connection.reconnected", domain: "ha", component: "ha-connection",
        request_id: SYS_REQ, message: "Reconnected to HA Core",
      });
    });

    // Start initial heartbeat
    startHeartbeat();
    emitStatus("connected", `HA ${connection.haVersion}`);

    // Phase 52: Subscribe to actionable notifications from Companion Apps
    connection.subscribeEvents((event: unknown) => {
      const ev = event as { data?: { action?: string } };
      const action: string | undefined = ev?.data?.action;
      if (action && action.startsWith("MEITHEAL_TASK_DONE_")) {
        const taskId = action.replace("MEITHEAL_TASK_DONE_", "");
        // F14: Validate taskId format (UUID or hex) before using in fetch
        if (!taskId || taskId.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(taskId)) {
          logger.log("warn", {
            event: "ha.notification.action_invalid", domain: "ha", component: "ha-connection",
            request_id: SYS_REQ, message: `Rejected invalid taskId from notification action: ${taskId.slice(0, 20)}`,
          });
          return;
        }
        logger.log("info", {
          event: "ha.notification.action", domain: "ha", component: "ha-connection",
          request_id: SYS_REQ, message: `Received actionable notification to mark task done: ${taskId}`,
        });

        // Dispatch to internal API
        fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/tasks/${encodeURIComponent(taskId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "complete" })
        }).catch((err: unknown) => {
          logger.log("error", {
            event: "ha.notification.action_failed", domain: "ha", component: "ha-connection",
            request_id: SYS_REQ, message: `Failed to execute task done action from HA event: ${String(err)}`,
          });
        });
      }
    }, "mobile_app_notification_action");

    // Phase 62b: Subscribe to state_changed for Meitheal sensor entities
    // When sensor states change (e.g. active task count), we know the
    // coordinator refreshed — useful for triggering UI updates.
    connection.subscribeEvents((event: unknown) => {
      try {
        const ev = event as { data?: { entity_id?: string; new_state?: { state?: string }; old_state?: { state?: string } } };
        const entityId = ev?.data?.entity_id;
        if (!entityId?.startsWith("sensor.meitheal_") && entityId !== "todo.meitheal_tasks") return;
        const newState = ev?.data?.new_state?.state;
        const oldState = ev?.data?.old_state?.state;
        if (newState === oldState) return;
        logger.log("info", {
          event: "ha.state_changed.meitheal", domain: "ha", component: "ha-connection",
          request_id: SYS_REQ,
          message: `Meitheal entity ${entityId} changed: ${oldState} → ${newState}`,
        });
      } catch { /* P1.2: never crash WS listener */ }
    }, "state_changed");

    // Phase 62b: Subscribe to call_service for meitheal domain
    // Logs when services are invoked (from automations, voice, or dev tools).
    connection.subscribeEvents((event: unknown) => {
      try {
        const ev = event as { data?: { domain?: string; service?: string; service_data?: Record<string, unknown> } };
        if (ev?.data?.domain !== "meitheal") return;
        const svc = ev?.data?.service ?? "unknown";
        const svcData = ev?.data?.service_data ?? {};
        logger.log("info", {
          event: "ha.service_called.meitheal", domain: "ha", component: "ha-connection",
          request_id: SYS_REQ,
          message: `HA service meitheal.${svc} called with ${JSON.stringify(svcData)}`,
        });
      } catch { /* P1.2: never crash WS listener */ }
    }, "call_service");

    // Phase 62b: Subscribe to component-fired meitheal events
    // The custom component fires these on hass.bus with source='component'.
    // We skip events where source='meitheal' (fired by this addon) to prevent loops.
    for (const eventType of [
      "meitheal_task_created", "meitheal_task_completed",
      "meitheal_task_updated", "meitheal_task_deleted",
      "meitheal_board_updated",
    ]) {
      connection.subscribeEvents((event: unknown) => {
        try {
          const ev = event as { data?: { source?: string; title?: string; task_id?: string } };
          if (ev?.data?.source === "meitheal") return;
          const title = ev?.data?.title ?? ev?.data?.task_id ?? "";
          logger.log("info", {
            event: `ha.bus.${eventType}`, domain: "ha", component: "ha-connection",
            request_id: SYS_REQ,
            message: `HA bus event ${eventType} (source: ${ev?.data?.source ?? "unknown"}): ${title}`,
          });
        } catch { /* P1.2: never crash WS listener */ }
      }, eventType);
    }

    return connection;
  } catch (err) {
    const errorCode = err === ERR_CANNOT_CONNECT ? "CANNOT_CONNECT"
      : err === ERR_INVALID_AUTH ? "INVALID_AUTH" : "UNKNOWN";
    lastError = errorCode;
    reconnectAttempts++;
    emitStatus("reconnecting", `attempt ${reconnectAttempts}, ${errorCode}`);

    logger.log("error", {
      event: "ha.connection.failed", domain: "ha", component: "ha-connection",
      request_id: SYS_REQ, err_code: errorCode,
      message: `Failed to connect to HA Core: ${errorCode} (attempt ${reconnectAttempts})`,
    });

    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY_MS);
    // Cancel any pending reconnect to prevent timer accumulation on rapid failures
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connection = null; connecting = false; getHAConnection().catch(() => {}); }, delay);
    return null;
  } finally {
    connecting = false;
  }
}

// ── Heartbeat ──

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (!connection) { stopHeartbeat(); return }
    const timeout = setTimeout(() => {
      logger.log("warn", {
        event: "ha.heartbeat.timeout", domain: "ha", component: "ha-connection",
        request_id: SYS_REQ, message: "Heartbeat pong not received within 10s — closing stale connection",
      });
      emitStatus("error", "heartbeat timeout");
      // Force close — the library will trigger reconnect
      connection?.close();
      connection = null;
    }, HEARTBEAT_TIMEOUT_MS);

    connection.sendMessagePromise({ type: "ping" })
      .then(() => { clearTimeout(timeout) })
      .catch(() => {
        clearTimeout(timeout);
        logger.log("warn", {
          event: "ha.heartbeat.failed", domain: "ha", component: "ha-connection",
          request_id: SYS_REQ, message: "Heartbeat ping failed",
        });
      });
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

export function getHAConnectionStatus() {
  return {
    connected: connection !== null,
    haVersion: connection?.haVersion ?? null,
    lastError,
    reconnectAttempts,
  };
}

export async function getHAConfig(): Promise<HassConfig | null> {
  const conn = await getHAConnection();
  if (!conn) return null;
  try {
    return await conn.sendMessagePromise<HassConfig>({ type: "get_config" });
  } catch (err) {
    logger.log("error", {
      event: "ha.config.fetch_failed", domain: "ha", component: "ha-connection",
      request_id: SYS_REQ, message: `Failed to fetch HA config: ${err}`,
    });
    return null;
  }
}

export function closeHAConnection(): void {
  stopHeartbeat();
  if (connection) {
    connection.close();
    connection = null;
    emitStatus("disconnected", "manual close");
    logger.log("info", {
      event: "ha.connection.closed", domain: "ha", component: "ha-connection",
      request_id: SYS_REQ, message: "HA Core connection closed",
    });
  }
}

// ── Ingress Entry Resolution ──

let cachedIngressEntry: string | null = null;

/**
 * Get the addon's ingress entry path from the Supervisor API.
 * Returns e.g. "/api/hassio_ingress/abc123..." or null if unavailable.
 * Cached forever — ingress entry doesn't change at runtime.
 */
export async function getIngressEntry(): Promise<string | null> {
  if (cachedIngressEntry) return cachedIngressEntry;

  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) return null;

  try {
    const res = await supervisorFetch("/addons/self/info");
    if (!res || !res.ok) return null;
    const data = await res.json() as { data?: { ingress_entry?: string } };
    cachedIngressEntry = data?.data?.ingress_entry ?? null;
    logger.log("info", {
      event: "ha.ingress.resolved", domain: "ha", component: "ha-connection",
      request_id: SYS_REQ, message: `Ingress entry: ${cachedIngressEntry}`,
    });
    return cachedIngressEntry;
  } catch (err) {
    logger.log("warn", {
      event: "ha.ingress.resolve_failed", domain: "ha", component: "ha-connection",
      request_id: SYS_REQ, message: `Failed to resolve ingress entry: ${err}`,
    });
    return null;
  }
}

// ── HA Base URL Resolution (for notification deep links) ──

let cachedBaseUrl: string | null = null;

/**
 * Get the HA instance base URL (external preferred, internal fallback).
 * Used to construct full deep link URLs for mobile notifications.
 * Returns e.g. "https://ha.internal:8123" or null if unavailable.
 *
 * @domain ha
 * @kcs HA Companion app requires full URLs (scheme+host) for clickAction/url.
 *       Relative ingress paths only work inside the HA frontend iframe.
 * @see https://companion.home-assistant.io/docs/notifications/notifications-basic/#opening-a-url
 */
export async function getHABaseUrl(): Promise<string | null> {
  if (cachedBaseUrl) return cachedBaseUrl;

  const config = await getHAConfig();
  if (!config) return null;

  // HassConfig type doesn't explicitly declare external_url/internal_url
  // but HA Core always includes them in the get_config response.
  const cfg = config as Record<string, unknown>;
  const url = (typeof cfg.external_url === "string" && cfg.external_url)
    ? cfg.external_url
    : (typeof cfg.internal_url === "string" && cfg.internal_url)
      ? cfg.internal_url
      : null;

  if (url) {
    cachedBaseUrl = url.replace(/\/+$/, ""); // strip trailing slashes
    logger.log("info", {
      event: "ha.base_url.resolved", domain: "ha", component: "ha-connection",
      request_id: SYS_REQ, message: `HA base URL resolved: ${cachedBaseUrl}`,
    });
  } else {
    logger.log("warn", {
      event: "ha.base_url.unresolved", domain: "ha", component: "ha-connection",
      request_id: SYS_REQ,
      message: "No external_url or internal_url in HA config — deep links will use relative paths",
    });
  }

  return cachedBaseUrl;
}

/** Invalidate cached HA base URL (for testing or config changes). */
export function invalidateBaseUrlCache(): void {
  cachedBaseUrl = null;
}
