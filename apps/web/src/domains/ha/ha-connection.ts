/**
 * HA WebSocket Connection — Server-Side Singleton
 *
 * Connects to HA Core via the Supervisor internal proxy using
 * `home-assistant-js-websocket`. Uses `SUPERVISOR_TOKEN` for auth.
 *
 * Architecture:
 *   Addon Server → supervisor/core/api/websocket (via Supervisor proxy) → HA Core
 *
 * @domain ha
 * @bounded-context integration
 */
import { createHash } from "node:crypto"
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
import WebSocket, { type ClientOptions } from "ws";
import { supervisorFetch } from "../../lib/supervisor-fetch";
import { resolveHAConfiguration, type HAConfiguration } from "./ha-configuration"
import { initEntitySubscription, resetEntityConnection } from "./ha-entities"
(globalThis as Record<string, unknown>).WebSocket = WebSocket;
const CORE_PROXY = "http://supervisor/core"

/** Open an isolated socket to Core with caller-specific transport limits. */
export function openHACoreSocket(token: string, options: ClientOptions): WebSocket {
  const Socket = globalThis.WebSocket as unknown as typeof WebSocket
  return new Socket(createLongLivedTokenAuth(CORE_PROXY, token).wsUrl, options)
}

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
let configurationFingerprint: string | null = null

export async function getHAConfiguration(): Promise<HAConfiguration | null> {
  if (process.env.SUPERVISOR_TOKEN) return resolveHAConfiguration(process.env)
  const { ensureSchema, getPersistenceClient } = await import("../tasks/persistence/store")
  const { SettingsRepository } = await import("../tasks/persistence/settings-repository")
  await ensureSchema()
  const repo = new SettingsRepository(getPersistenceClient())
  await repo.ensureSettingsTable()
  return resolveHAConfiguration(process.env, await repo.getByKeys(["ha_url", "ha_token"]))
}
let connecting = false;
let connectingFingerprint: string | null = null
let connectionGeneration = 0
let lastError: string | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null; // Guard against rapid reconnect races
interface HeartbeatState {
  readonly connection: Connection
  readonly generation: number
  interval: ReturnType<typeof setInterval> | null
  timeout: ReturnType<typeof setTimeout> | null
}
let heartbeat: HeartbeatState | null = null
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
  let config: HAConfiguration | null
  try { config = await getHAConfiguration() } catch {
    lastError = "HA_CONFIGURATION_UNAVAILABLE"
    closeHAConnection()
    return null
  }
  const fingerprint = config ? createHash("sha256").update(JSON.stringify(config)).digest("hex") : null
  if ((connection && configurationFingerprint !== fingerprint) ||
    (connecting && connectingFingerprint !== fingerprint)) {
    closeHAConnection()
    invalidateBaseUrlCache()
    cachedIngressEntry = null
  }
  if (!config) {
    closeHAConnection()
    lastError = "HA_NOT_CONFIGURED"
    return null
  }
  if (connection) return connection;
  if (connecting) {
    const waitingGeneration = connectionGeneration
    const completed = await new Promise<boolean>((resolve) => {
      let check: ReturnType<typeof setInterval> | null = null
      const timeout = setTimeout(() => {
        if (check) clearInterval(check)
        resolve(false)
      }, 15_000)
      check = setInterval(() => {
        if (!connecting || connectionGeneration !== waitingGeneration) {
          clearInterval(check!)
          clearTimeout(timeout)
          resolve(true)
        }
      }, 100)
    })
    // Re-read credentials before handing a waiter the newly established socket.
    return completed && (connection || connecting) ? getHAConnection() : null
  }

  connecting = true;
  connectingFingerprint = fingerprint
  const attemptGeneration = ++connectionGeneration
  let candidate: Connection | null = null
  try {
    const auth = createLongLivedTokenAuth(config.baseUrl, config.token);
    candidate = await createConnection({ auth });
    const currentConfig = await getHAConfiguration()
    const currentFingerprint = currentConfig ? createHash("sha256").update(JSON.stringify(currentConfig)).digest("hex") : null
    if (attemptGeneration !== connectionGeneration || currentFingerprint !== fingerprint) {
      candidate.close()
      candidate = null
      if (attemptGeneration === connectionGeneration) closeHAConnection()
      return null
    }
    connection = candidate
    const establishedConnection = connection
    configurationFingerprint = fingerprint
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    reconnectAttempts = 0;
    lastError = null;

    logger.log("info", {
      event: "ha.connection.established", domain: "ha", component: "ha-connection",
      request_id: SYS_REQ, message: `Connected to HA Core v${connection.haVersion}`,
    });

    connection.addEventListener("disconnected", () => {
      if (connection !== establishedConnection) return
      resetEntityConnection()
      stopHeartbeat();
      emitStatus("disconnected");
      logger.log("warn", {
        event: "ha.connection.disconnected", domain: "ha", component: "ha-connection",
        request_id: SYS_REQ, message: "Disconnected from HA Core — auto-reconnect will attempt",
      });
    });

    connection.addEventListener("ready", () => {
      if (connection !== establishedConnection) return
      void initEntitySubscription(establishedConnection)
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

    const subscribeEvent = (listener: (event: unknown) => void, eventType: string) => {
      void establishedConnection.subscribeEvents(listener, eventType).catch(() => {
        // Closing a replaced connection rejects its pending subscriptions.
        if (connection !== establishedConnection || !establishedConnection.connected) return
        logger.log("warn", {
          event: "ha.subscription.failed", domain: "ha", component: "ha-connection",
          request_id: SYS_REQ, message: "Home Assistant event subscription failed",
        })
      })
    }

    // Phase 52: Subscribe to actionable notifications from Companion Apps
    subscribeEvent((event: unknown) => {
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
        }).then(response => {
          void response.body?.cancel().catch(() => {})
          if (!response.ok) {
            const retryAfter = response.headers.get("retry-after")
            const retry = retryAfter ? ` (Retry-After: ${retryAfter})` : ""
            throw new Error(`Task completion returned HTTP ${response.status}${retry}`)
          }
        }).catch((err: unknown) => {
          logger.log("error", {
            event: "ha.notification.action_failed", domain: "ha", component: "ha-connection",
            request_id: SYS_REQ, message: `Failed to execute task done action from HA event: ${String(err)}`,
          });
        });
      }
    }, "mobile_app_notification_action");

    // Phase 62b: Subscribe to component-fired meitheal events
    // The custom component fires these on hass.bus with source='component'.
    // We skip events where source='meitheal' (fired by this addon) to prevent loops.
    for (const eventType of [
      "meitheal_task_created", "meitheal_task_completed",
      "meitheal_task_updated", "meitheal_task_deleted",
      "meitheal_area_updated",
    ]) {
      subscribeEvent((event: unknown) => {
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

    await initEntitySubscription(establishedConnection)
    return connection;
  } catch (err) {
    candidate?.close()
    if (attemptGeneration !== connectionGeneration) return null
    if (connection === candidate) {
      connection = null
      configurationFingerprint = null
      resetEntityConnection()
    }
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
    if (connectionGeneration === attemptGeneration) {
      connecting = false
      connectingFingerprint = null
    }
  }
}

// ── Heartbeat ──

function startHeartbeat(): void {
  stopHeartbeat()
  if (!connection) return
  const state: HeartbeatState = { connection, generation: connectionGeneration, interval: null, timeout: null }
  heartbeat = state
  const current = () => heartbeat === state && connection === state.connection && connectionGeneration === state.generation
  state.interval = setInterval(() => {
    if (!current()) {
      if (heartbeat === state) stopHeartbeat()
      return
    }
    const timeout = setTimeout(() => {
      if (!current()) return
      stopHeartbeat()
      logger.log("warn", {
        event: "ha.heartbeat.timeout", domain: "ha", component: "ha-connection",
        request_id: SYS_REQ, message: "Heartbeat pong not received within 10s — closing stale connection",
      })
      emitStatus("error", "heartbeat timeout")
      // Close only the connection whose ping timed out. Status listeners may
      // themselves retire its generation before this callback finishes.
      state.connection.close()
      if (connection === state.connection && connectionGeneration === state.generation) connection = null
    }, HEARTBEAT_TIMEOUT_MS)
    state.timeout = timeout
    const clearDeadline = () => {
      clearTimeout(timeout)
      if (state.timeout === timeout) state.timeout = null
    }
    state.connection.sendMessagePromise({ type: "ping" })
      .then(clearDeadline)
      .catch(() => {
        clearDeadline()
        if (!current()) return
        logger.log("warn", {
          event: "ha.heartbeat.failed", domain: "ha", component: "ha-connection",
          request_id: SYS_REQ, message: "Heartbeat ping failed",
        })
      })
  }, HEARTBEAT_INTERVAL_MS)
}

function stopHeartbeat(): void {
  const retired = heartbeat
  heartbeat = null
  if (retired) {
    if (retired.interval) clearInterval(retired.interval)
    if (retired.timeout) clearTimeout(retired.timeout)
    retired.interval = null
    retired.timeout = null
  }
}

export function getHAConnectionStatus() {
  return {
    connected: connection?.connected ?? false,
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
  connectionGeneration++
  connecting = false
  connectingFingerprint = null
  resetEntityConnection()
  invalidateBaseUrlCache()
  cachedIngressEntry = null
  stopHeartbeat();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  configurationFingerprint = null
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
