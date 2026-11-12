// layout-pwa-controller.ts — Extracted from Layout.astro
// Handles: Service Worker registration, install prompt capture,
// app installed tracking, and SW update toast.

import {
  registerServiceWorker,
  activateServiceWorker,
  type SwUpdateEventDetail,
} from "@domains/offline/sw-register"
import { pageLifecycle } from "@lib/page-lifecycle"
import { showToast } from "@lib/toast"

// Register service worker on page load
document.addEventListener("DOMContentLoaded", () => {
  registerServiceWorker()
})

// Capture install prompt — store globally for install banner + settings
window.addEventListener("beforeinstallprompt", (e: any) => {
  e.preventDefault()
  window.__pwa_install_prompt = e
  window.dispatchEvent(new CustomEvent("meitheal-pwa-installable"))
})

// Track installation
window.addEventListener("appinstalled", () => {
  window.__pwa_install_prompt = null
  window.dispatchEvent(new CustomEvent("meitheal-pwa-installed"))
})

// SW update toast — show when new version available
let offeredWorker: ServiceWorker | undefined
function showUpdateToast() {
  if (!offeredWorker || offeredWorker.state === "redundant" || document.getElementById("sw-update-btn")) return
  let container = document.querySelector(".toast-container")
  if (!container) {
    container = document.createElement("div")
    container.id = "toast-container"
    container.className = "toast-container"
    document.body.append(container)
  }
  const toast = document.createElement("div")
  toast.className = "toast info"
  toast.setAttribute("role", "alert")
  toast.innerHTML = `
    <span>🔄 A new version of Meitheal is available.</span>
    <button type="button" id="sw-update-btn"
      style="margin-left:12px;padding:4px 12px;font-size:12px;font-weight:600;color:var(--personal-accent-foreground,var(--palette-on-accent,#07140f));background:var(--accent,#69E3B2);border:none;border-radius:6px;cursor:pointer;"
    >Refresh</button>
  `
  container.appendChild(toast)
  const refresh = toast.querySelector<HTMLButtonElement>("#sw-update-btn")
  const signal = pageLifecycle.signal
  refresh?.addEventListener("click", async () => {
    if (!offeredWorker || refresh.getAttribute("aria-disabled") === "true") return
    const label = refresh.textContent
    refresh.setAttribute("aria-disabled", "true")
    refresh.textContent = window.mI18n?.get("settings.pwa_refresh_pending") ?? "Updating…"
    const ready = await activateServiceWorker(offeredWorker, signal)
    if (signal.aborted) return
    if (ready) {
      window.location.reload()
      return
    }
    refresh.removeAttribute("aria-disabled")
    refresh.textContent = label
    showToast("settings.pwa_refresh_failed", "error")
  }, { signal })
}

window.addEventListener("meitheal-sw-update", ((e: CustomEvent<SwUpdateEventDetail>) => {
  if (e.detail?.type !== "update-available") return
  offeredWorker = e.detail.worker
  showUpdateToast()
}) as EventListener)
pageLifecycle.onPageLoad(showUpdateToast)
