/**
 * Service Worker Registration — Ingress-Aware with Secure Context Detection
 *
 * Handles SW lifecycle: registration, update detection, skipWaiting on user confirm (FR-308).
 * Emits custom events for UI to show update prompt.
 *
 * When running behind HA Supervisor ingress, uses window.__ingress_path
 * to register the SW at the correct ingress-prefixed URL and scope.
 * The ingress token is permanent per-installation (HA issue #6605).
 *
 * Graceful degradation: on insecure contexts (HTTP without localhost),
 * skips registration entirely and sets window.__pwa_supported = false.
 * Most HA users have HTTPS via Nabu Casa or DuckDNS+LetsEncrypt.
 *
 * Bounded context: offline domain
 */

import { createClientLogger } from "@lib/client-logger"

const log = createClientLogger("offline", "sw-register")

// --- Types ---

export interface SwUpdateEventDetail {
  type: "update-available" | "update-activated"
}

/**
 * Check whether the current context supports PWA features.
 * Service workers require a secure context (HTTPS or localhost).
 */
export function isPwaSupported(): boolean {
  if (typeof window === "undefined") return false
  return window.isSecureContext && "serviceWorker" in navigator
}

// --- Registration ---

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isPwaSupported()) {
    if (typeof window !== "undefined" && !window.isSecureContext) {
      log.info("Insecure context (HTTP) — PWA features disabled. Enable HTTPS for offline support.")
    } else if (!("serviceWorker" in navigator)) {
      log.info("Service workers not supported in this browser")
    }
    return null
  }

  try {
    // Build ingress-aware SW URL and scope.
    // When accessed via HA ingress, window.__ingress_path contains the
    // permanent prefix (e.g. "/api/hassio_ingress/{token}").
    const ip = window.__ingress_path ?? ""
    const swUrl = `${ip}/sw.js`
    const swScope = `${ip}/`

    const registration = await navigator.serviceWorker.register(swUrl, {
      scope: swScope,
    })

    // Send ingress path to the SW so it can prefix precache URLs
    // and adjust fetch routing accordingly.
    // Use navigator.serviceWorker.ready to ensure SW is active before messaging.
    if (ip) {
      const sendIngressPath = (sw: ServiceWorker | null) => {
        if (sw) sw.postMessage({ type: "SET_INGRESS_PATH", path: ip })
      }

      // Send to currently installing/waiting SW immediately (covers first registration)
      sendIngressPath(registration.installing)
      sendIngressPath(registration.waiting)

      // Also send via .ready to guarantee delivery to the active SW
      navigator.serviceWorker.ready.then((ready) => {
        sendIngressPath(ready.active)
      }).catch(() => { /* SW not yet active — non-fatal */ })
    }

    // Check for SW updates every 5 minutes.
    // 60s was too aggressive for HA addon context where updates
    // are infrequent. 5 min balances responsiveness with efficiency.
    // @kcs Audit item #31 — update interval tuning.
    const updateCheckInterval = setInterval(() => {
      registration.update().catch(() => {
        // Silent fail — update check is best-effort
      })
    }, 300_000)

    // Clean up interval on page unload to prevent memory leak
    window.addEventListener("beforeunload", () => {
      clearInterval(updateCheckInterval)
    }, { once: true })

    // Listen for new SW waiting (update available)
    registration.addEventListener("updatefound", () => {
      const newWorker = registration.installing
      if (!newWorker) return

      // Send ingress path to the new SW as soon as it's installing
      if (ip) {
        newWorker.postMessage({ type: "SET_INGRESS_PATH", path: ip })
      }

      newWorker.addEventListener("statechange", () => {
        if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
          // New version available — prompt user (FR-308: don't auto-skipWaiting)
          window.dispatchEvent(
            new CustomEvent<SwUpdateEventDetail>("meitheal-sw-update", {
              detail: { type: "update-available" },
            })
          )
        }
      })
    })

    // Listen for controller change (activation complete)
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      window.dispatchEvent(
        new CustomEvent<SwUpdateEventDetail>("meitheal-sw-update", {
          detail: { type: "update-activated" },
        })
      )
    })

    return registration
  } catch (error) {
    log.error("Registration failed", error)
    return null
  }
}

/**
 * Send skipWaiting message to waiting SW — only call on user confirmation.
 */
export async function activateWaitingSw(): Promise<void> {
  const registration = await navigator.serviceWorker?.getRegistration()
  if (registration?.waiting) {
    registration.waiting.postMessage({ type: "SKIP_WAITING" })
  }
}
