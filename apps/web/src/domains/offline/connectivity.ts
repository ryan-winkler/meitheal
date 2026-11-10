/**
 * Connectivity Detector
 *
 * Combines navigator.onLine with periodic health check pings.
 * Debounces state transitions (2s) to prevent flicker.
 * Emits custom events for UI components and sync engine.
 *
 * Bounded context: offline domain
 */

// --- Types ---

export type ConnectivityState = "online" | "offline" | "checking"

export interface ConnectivityEventDetail {
  state: ConnectivityState
  previousState: ConnectivityState
}

import { apiUrl } from "../../lib/ingress-fetch"
import { createClientLogger } from "@lib/client-logger"

const log = createClientLogger("offline", "connectivity")

// --- Configuration ---

const HEALTH_CHECK_INTERVAL_MS = 30_000
const DEBOUNCE_MS = 2_000

// --- State ---

let currentState: ConnectivityState = typeof navigator !== "undefined" && navigator.onLine ? "online" : "offline"
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let healthCheckTimer: ReturnType<typeof setInterval> | null = null

function emit(state: ConnectivityState, previousState: ConnectivityState): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<ConnectivityEventDetail>("meitheal-connectivity", {
        detail: { state, previousState },
      })
    )
  }
}

function transitionTo(newState: ConnectivityState): void {
  if (newState === currentState) return

  if (debounceTimer) clearTimeout(debounceTimer)

  debounceTimer = setTimeout(() => {
    const previousState = currentState
    currentState = newState
    emit(currentState, previousState)
  }, DEBOUNCE_MS)
}

async function checkHealth(): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5_000)
    const response = await fetch(apiUrl("/api/health"), {
      method: "HEAD",
      signal: controller.signal,
      cache: "no-store",
      credentials: "include", // Required for HA ingress session cookie
    })
    clearTimeout(timeout)
    return response.ok
  } catch {
    return false
  }
}

// --- SSE Connection Manager (Phase 53) ---

let sseConnection: EventSource | null = null;
let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let sseReconnectAttempts = 0;
const MAX_SSE_RETRY_MS = 60_000;

function connectSSE(): void {
  if (typeof window === "undefined") return;
  if (sseConnection) {
    sseConnection.close();
    sseConnection = null;
  }

  // Clear any pending reconnects
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }

  // Only connect if we believe we are online
  if (currentState !== "online") return;

  try {
    const sseUrl = apiUrl("/api/sse");
    sseConnection = new EventSource(sseUrl, { withCredentials: true });

    sseConnection.onopen = () => {
      sseReconnectAttempts = 0; // Reset backoff on success
    };

    sseConnection.onerror = () => {
      if (sseConnection) {
        sseConnection.close();
        sseConnection = null;
      }

      sseReconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, sseReconnectAttempts), MAX_SSE_RETRY_MS);

      sseReconnectTimer = setTimeout(() => {
        if (currentState === "online") connectSSE();
      }, delay);
    };

    // Forward SSE events as custom document events for UI components to listen to
    sseConnection.addEventListener("ha:entity_changed", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        window.dispatchEvent(new CustomEvent("ha-entity-update", { detail: data }));
      } catch { /* malformed SSE data — non-critical */ }
    });

  } catch (err) {
    log.warn("Failed to initialize EventSource", err);
  }
}

function disconnectSSE(): void {
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }
  if (sseConnection) {
    sseConnection.close();
    sseConnection = null;
  }
}

// --- Public API ---

export function getConnectivityState(): ConnectivityState {
  return currentState
}

export function startConnectivityMonitor(): void {
  if (typeof window === "undefined") return

  // Listen to browser online/offline events
  window.addEventListener("online", () => {
    transitionTo("checking")
    checkHealth().then((ok) => {
      transitionTo(ok ? "online" : "offline");
      if (ok) connectSSE();
    }).catch(() => transitionTo("offline"))
  })

  window.addEventListener("offline", () => {
    transitionTo("offline");
    disconnectSSE();
  })

  // Periodic health check (skip when tab is backgrounded to save bandwidth)
  healthCheckTimer = setInterval(async () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return
    if (navigator.onLine) {
      const ok = await checkHealth()
      if (!ok && currentState === "online") {
        transitionTo("offline");
        disconnectSSE();
      } else if (ok && currentState === "offline") {
        transitionTo("online");
        connectSSE();
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS)

  // Initial SSE Connection if online
  if (currentState === "online") {
    connectSSE();
  }
}

export function stopConnectivityMonitor(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer)
    healthCheckTimer = null
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  disconnectSSE();
}
