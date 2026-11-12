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
import { buildIngressPagePath } from "@lib/page-shell-links"

const log = createClientLogger("offline", "sw-register")

// --- Types ---

export type SwUpdateEventDetail =
  | { type: "update-available"; worker: ServiceWorker }
  | { type: "update-activated" }

/**
 * Check whether the current context supports PWA features.
 * Service workers require a secure context (HTTPS or localhost).
 */
export function isPwaSupported(): boolean {
  if (typeof window === "undefined") return false
  return window.isSecureContext && "serviceWorker" in navigator
}

function appWorkerScope(): URL {
  return new URL(buildIngressPagePath("/"), location.origin)
}

/** A broader Home Assistant registration can also match the App URL. */
export async function getAppServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isPwaSupported()) return null
  const scope = appWorkerScope()
  const registration = await navigator.serviceWorker.getRegistration(scope.href)
  if (registration?.scope !== scope.href) return null
  const script = new URL("sw.js", scope).href
  const workers = [registration.installing, registration.waiting, registration.active]
  return workers.some(Boolean) && workers.every(worker => !worker || worker.scriptURL === script) ? registration : null
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

      // A waiting worker may predate this page's registration call.
      sendIngressPath(registration.waiting)

      // Also send via .ready to guarantee delivery to the active SW
      navigator.serviceWorker.ready.then((ready) => {
        if (ready.scope === registration.scope) sendIngressPath(ready.active)
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

    const offerUpdate = (worker: ServiceWorker) => {
      if (!navigator.serviceWorker.controller) return
      window.dispatchEvent(new CustomEvent<SwUpdateEventDetail>("meitheal-sw-update", {
        detail: { type: "update-available", worker },
      }))
    }

    let observedWorker: ServiceWorker | null = null
    function observeInstallingWorker() {
      const newWorker = registration.installing
      if (!newWorker || observedWorker === newWorker) return
      observedWorker = newWorker

      // Send ingress path to the new SW as soon as it's installing
      if (ip) {
        newWorker.postMessage({ type: "SET_INGRESS_PATH", path: ip })
      }

      newWorker.addEventListener("statechange", () => {
        if (newWorker.state === "installed") offerUpdate(newWorker)
      })
    }
    registration.addEventListener("updatefound", observeInstallingWorker)
    observeInstallingWorker()
    if (registration.waiting) offerUpdate(registration.waiting)

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
 * Start the selected update and wait for it to finish activating and control this page.
 */
export function activateServiceWorker(
  selected: ServiceWorker | Promise<ServiceWorker | null>,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  const workers = navigator.serviceWorker
  return new Promise(resolve => {
    const listeners = new AbortController()
    const timer = window.setTimeout(() => finish(false), 15_000)

    function finish(ready: boolean) {
      window.clearTimeout(timer)
      listeners.abort()
      resolve(ready)
    }

    signal.addEventListener("abort", () => finish(false), { once: true, signal: listeners.signal })
    void Promise.resolve(selected).then(worker => {
      if (listeners.signal.aborted) return
      if (!worker || worker.scriptURL !== new URL("sw.js", appWorkerScope()).href) return finish(false)
      let requested = false

      const check = () => {
        if (worker.state === "redundant") return finish(false)
        if (worker.state === "activated" && workers.controller === worker) return finish(true)
        if (worker.state !== "installed" || requested) return
        requested = true
        try {
          worker.postMessage({ type: "SKIP_WAITING" })
        } catch {
          finish(false)
        }
      }

      worker.addEventListener("statechange", check, { signal: listeners.signal })
      workers.addEventListener("controllerchange", check, { signal: listeners.signal })
      check()
    }, () => finish(false))
  })
}
