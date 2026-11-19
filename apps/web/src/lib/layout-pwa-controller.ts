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
  if (!globalSignal.aborted) showUpdateToast()
})
