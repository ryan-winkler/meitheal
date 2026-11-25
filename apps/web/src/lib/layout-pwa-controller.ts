// layout-pwa-controller.ts — Extracted from Layout.astro
// Handles: Service Worker registration, install prompt capture,
// app installed tracking, and SW update toast.

import {
  registerServiceWorker,
  activateServiceWorker,
  type SwUpdateEventDetail,
} from "@domains/offline/sw-register"
import { dialogText } from "@lib/dialog-overlay"
import { pageLifecycle } from "@lib/page-lifecycle"
import {
  buildOfflineSyncSummary,
  countOfflineMutations,
  OFFLINE_QUEUE_EVENT,
  replayOfflineMutations,
} from "@lib/pwa-offline-sync"
import { announceStatus, dismissToast, pushToast, showToast } from "@lib/toast"

window.__meithealPwaGlobalAc?.abort()
const globalAc = new AbortController()
window.__meithealPwaGlobalAc = globalAc
const { signal: globalSignal } = globalAc

// Register service worker on page load (or immediately if module loaded after DOMContentLoaded)
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => registerServiceWorker(), { once: true, signal: globalSignal })
} else {
  registerServiceWorker()
}

// Capture install prompt — store globally for install banner + settings
window.addEventListener("beforeinstallprompt", (e: any) => {
  e.preventDefault()
  window.__pwa_install_prompt = e
  window.dispatchEvent(new CustomEvent("meitheal-pwa-installable"))
}, { signal: globalSignal })

// Track installation
window.addEventListener("appinstalled", () => {
  window.__pwa_install_prompt = null
  window.dispatchEvent(new CustomEvent("meitheal-pwa-installed"))
}, { signal: globalSignal })

export async function consumePwaInstallPrompt(): Promise<"accepted" | "dismissed" | "error" | "none"> {
  const prompt = window.__pwa_install_prompt
  if (!prompt) return "none"
  window.__pwa_install_prompt = null
  window.dispatchEvent(new Event("meitheal-pwa-prompt-consumed"))
  let outcome: "accepted" | "dismissed" | "error" = "error"
  try {
    await prompt.prompt()
    outcome = (await prompt.userChoice).outcome
  } catch {
    outcome = "error"
  }
  if (outcome === "accepted") {
    offerPostInstallNotifications()
  }
  return outcome
}

function offerPostInstallNotifications(): void {
  if (typeof window === "undefined" || !("Notification" in window)) return
  if (Notification.permission !== "default") return
  pushToast({
    id: "pwa-enable-notifications",
    type: "info",
    icon: "bell",
    message: "Meitheal installed! Enable task reminders and notifications?",
    duration: 10000,
    action: {
      id: "pwa-enable-notifications-btn",
      label: "Enable notifications",
      primary: true,
      onClick: async () => {
        try {
          const result = await Notification.requestPermission()
          if (result === "granted") {
            showToast("Notifications enabled", "success")
          }
          window.dispatchEvent(new Event("meitheal:notification-permission-changed"))
        } catch {
          // Ignore unsupported browser permission errors
        }
      },
    },
  })
}

export interface SwActivationButtonOptions {
  button: HTMLElement
  target: ServiceWorker | (() => Promise<ServiceWorker | null>)
  signal: AbortSignal
  onBeforeActivate?: () => boolean
  onPendingChange?: (pending: boolean) => void
}

export async function activateSwWithButtonUi({
  button,
  target,
  signal,
  onBeforeActivate,
  onPendingChange,
}: SwActivationButtonOptions): Promise<void> {
  if (button.getAttribute("aria-disabled") === "true") return
  const labelEl = button.querySelector("span") ?? button
  const label = labelEl.textContent
  const pendingText = dialogText("settings.pwa_refresh_pending", "Updating…")
  onPendingChange?.(true)
  button.setAttribute("aria-disabled", "true")
  button.setAttribute("aria-busy", "true")
  labelEl.textContent = pendingText
  announceStatus(pendingText)
  let reloading = false
  try {
    if (onBeforeActivate?.()) return
    const workerOrPromise = typeof target === "function" ? target() : target
    const ready = await activateServiceWorker(workerOrPromise, signal)
    if (signal.aborted) return
    if (ready) {
      reloading = true
      window.location.reload()
      return
    }
    showToast("settings.pwa_refresh_failed", "error")
  } finally {
    if (!reloading) {
      onPendingChange?.(false)
      button.removeAttribute("aria-disabled")
      button.removeAttribute("aria-busy")
      labelEl.textContent = label
      announceStatus("")
    }
  }
}

// SW update toast — show when new version available (unless user explicitly dismissed this worker)
let offeredWorker: ServiceWorker | undefined
let shownWorker: ServiceWorker | undefined
let dismissedWorker: ServiceWorker | undefined
let toastActivationPending = false
function showUpdateToast() {
  if (!offeredWorker || offeredWorker === dismissedWorker || offeredWorker.state === "redundant" ||
    (shownWorker === offeredWorker && document.getElementById("sw-update-btn"))) return
  const targetWorker = offeredWorker
  shownWorker = targetWorker
  pushToast({
    id: "sw-update",
    type: "info",
    icon: "refresh",
    message: "toast.pwa_update_available",
    persistent: true,
    duration: Infinity,
    onDismiss: () => {
      if (shownWorker === targetWorker) shownWorker = undefined
      if (offeredWorker === targetWorker) dismissedWorker = targetWorker
    },
    action: {
      id: "sw-update-btn",
      label: "toast.pwa_refresh",
      primary: true,
      closeOnClick: false,
      onClick: async (event) => {
        const refresh = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null
        if (!offeredWorker || !refresh) return
        const ac = new AbortController()
        const onPageHide = () => ac.abort()
        window.addEventListener("pagehide", onPageHide, { once: true })
        try {
          await activateSwWithButtonUi({
            button: refresh,
            target: offeredWorker,
            signal: ac.signal,
            onPendingChange: (pending) => { toastActivationPending = pending },
          })
        } finally {
          window.removeEventListener("pagehide", onPageHide)
        }
      },
    },
  })
}

window.addEventListener("meitheal-sw-update", ((e: CustomEvent<SwUpdateEventDetail>) => {
  if (e.detail?.type === "update-activated") {
    if (!toastActivationPending) {
      offeredWorker = undefined
      shownWorker = undefined
      dismissToast("sw-update")
    }
    return
  }
  if (e.detail?.type !== "update-available") return
  const worker = e.detail.worker
  if (offeredWorker !== worker) toastActivationPending = false
  offeredWorker = worker
  worker.addEventListener("statechange", () => {
    if (worker.state === "redundant" && offeredWorker === worker) {
      toastActivationPending = false
      offeredWorker = undefined
      shownWorker = undefined
      dismissToast("sw-update")
    }
  }, { signal: globalSignal })
  if (dismissedWorker !== offeredWorker) showUpdateToast()
}) as EventListener, { signal: globalSignal })
pageLifecycle.onPageLoad(() => {
  if (!globalSignal.aborted) {
    showUpdateToast()
    void flushOfflineOutbox().catch(() => {})
    bindSessionReconnectBanner()
  }
})

// ── Offline Connectivity Indicator & Outbox Replay ──
let pendingOfflineCount = 0
let offlineReplayFailed = false

function syncOfflineBanner() {
  const banner = document.getElementById("meitheal-offline-banner")
  if (!banner) return
  const offline = typeof navigator !== "undefined" && navigator.onLine === false
  banner.hidden = !offline && pendingOfflineCount === 0
  const textEl = document.getElementById("meitheal-offline-banner-text")
  if (textEl) {
    textEl.textContent = offline
      ? buildOfflineSyncSummary(pendingOfflineCount, 0)
      : offlineReplayFailed ? "Offline changes remain saved for review."
        : `Syncing ${pendingOfflineCount} pending offline ${pendingOfflineCount === 1 ? "change" : "changes"}…`
  }
}

async function flushOfflineOutbox(notify = true) {
  const result = await replayOfflineMutations()
  pendingOfflineCount = result.remaining
  offlineReplayFailed = result.failed > 0
  syncOfflineBanner()
  if (result.synced > 0) {
    if (notify) showToast(buildOfflineSyncSummary(0, result.synced), "success")
    document.dispatchEvent(new CustomEvent("meitheal:tasks-changed"))
  }
}

void countOfflineMutations().then((count) => {
  pendingOfflineCount = count
  syncOfflineBanner()
  if (count > 0 && typeof navigator !== "undefined" && navigator.onLine !== false) {
    void flushOfflineOutbox().catch(() => {})
  }
}).catch(() => {})

window.addEventListener(OFFLINE_QUEUE_EVENT, ((e: CustomEvent<{ count?: number }>) => {
  if (typeof e.detail?.count === "number") {
    pendingOfflineCount = e.detail.count
    syncOfflineBanner()
  }
}) as EventListener, { signal: globalSignal })

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    if (event.data?.type === "SYNC_TRIGGERED") {
      void flushOfflineOutbox().catch(() => {})
    }
  }, { signal: globalSignal })
}

window.addEventListener("offline", () => {
  syncOfflineBanner()
  announceStatus("Offline mode active")
}, { signal: globalSignal })

window.addEventListener("online", () => {
  syncOfflineBanner()
  announceStatus("Back online")
  void runIngressSessionKeepalive(true)
  void flushOfflineOutbox().catch(() => {})
}, { signal: globalSignal })

// ── HA Ingress Session Keepalive & Reconnect Recovery ──
// Supervisor's ingress_session cookie expires after ~1 hour in standalone PWAs
// because HA's frontend shell is not mounted. Periodically validate the same-origin
// session while active/resuming so users do not hit "You don't have access".
const KEEPALIVE_INTERVAL_MS = 15 * 60 * 1000
const KEEPALIVE_MIN_GAP_MS = 60 * 1000
let lastKeepaliveAt = 0

async function runIngressSessionKeepalive(force = false): Promise<boolean> {
  const ingressPath = window.__ingress_path
  if (!ingressPath || typeof navigator !== "undefined" && navigator.onLine === false) return true
  const now = Date.now()
  if (!force && now - lastKeepaliveAt < KEEPALIVE_MIN_GAP_MS) return true
  lastKeepaliveAt = now

  // Best-effort same-origin Supervisor session refresh (sliding 1-hour window)
  try {
    await fetch(`${window.location.origin}/api/hassio/ingress/validate_session`, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
    })
  } catch {
    // Ignore when running outside Supervisor or offline
  }

  // Verify Meitheal ingress reachability through the ingress proxy
  try {
    const res = await fetch("/api/health", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
    })
    if (res.ok) {
      hideSessionReconnectBanner()
      return true
    }
    const isAppJson = /\bjson\b/i.test(res.headers.get("content-type") || "")
    if ((res.status === 401 || res.status === 403) && !isAppJson) {
      showSessionReconnectBanner()
      return false
    }
  } catch {
    // Network blip; handled by offline banner
  }
  return true
}

function showSessionReconnectBanner() {
  const banner = document.getElementById("meitheal-session-reconnect-banner")
  if (banner) banner.hidden = false
}

function hideSessionReconnectBanner() {
  const banner = document.getElementById("meitheal-session-reconnect-banner")
  if (banner) banner.hidden = true
}

function bindSessionReconnectBanner() {
  const retryBtn = document.getElementById("meitheal-session-retry-btn")
  if (retryBtn && retryBtn.dataset.bound !== "1") {
    retryBtn.dataset.bound = "1"
    retryBtn.addEventListener("click", async () => {
      retryBtn.setAttribute("aria-busy", "true")
      const ok = await runIngressSessionKeepalive(true)
      retryBtn.removeAttribute("aria-busy")
      if (ok) {
        hideSessionReconnectBanner()
        showToast("Session restored", "success")
      }
    }, { signal: globalSignal })
  }
  const reconnectLink = document.getElementById("meitheal-session-reconnect-link") as HTMLAnchorElement | null
  if (reconnectLink && window.__ingress_path) {
    // Target same-origin Home Assistant root (not the ingress-prefixed URL) to renew ingress_session cookie
    reconnectLink.href = `${window.location.origin}/`
  }
}

window.addEventListener("meitheal:ingress-session-expired", () => {
  showSessionReconnectBanner()
}, { signal: globalSignal })

window.addEventListener("meitheal:work-access-stale", () => {
  pushToast({
    id: "work-access-stale",
    type: "warning",
    icon: "refresh",
    message: "Work access updated in another session.",
    duration: 8000,
    action: {
      id: "work-access-stale-refresh-btn",
      label: "Refresh",
      primary: true,
      onClick: () => window.location.reload(),
    },
  })
}, { signal: globalSignal })

if (window.__ingress_path) {
  const keepaliveTimer = window.setInterval(() => {
    if (!document.hidden) void runIngressSessionKeepalive(false)
  }, KEEPALIVE_INTERVAL_MS)
  globalSignal.addEventListener("abort", () => window.clearInterval(keepaliveTimer), { once: true })

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void runIngressSessionKeepalive(false)
  }, { signal: globalSignal })
  window.addEventListener("focus", () => {
    if (!document.hidden) void runIngressSessionKeepalive(false)
  }, { signal: globalSignal })
}

syncOfflineBanner()
bindSessionReconnectBanner()

