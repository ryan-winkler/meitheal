// layout-pwa-controller.ts — Extracted from Layout.astro
// Handles: Service Worker registration, install prompt capture,
// app installed tracking, and SW update toast.

import {
  registerServiceWorker,
  activateWaitingSw,
} from "@domains/offline/sw-register"

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
window.addEventListener("meitheal-sw-update", ((e: CustomEvent) => {
  if (e.detail?.type !== "update-available") return
  const tc = document.querySelector(".toast-container")
  if (!tc) return
  const toast = document.createElement("div")
  toast.className = "toast info"
  toast.setAttribute("role", "alert")
  toast.innerHTML = `
    <span>🔄 A new version of Meitheal is available.</span>
    <button type="button" id="sw-update-btn"
      style="margin-left:12px;padding:4px 12px;font-size:12px;font-weight:600;color:#fff;background:var(--accent,#6366F1);border:none;border-radius:6px;cursor:pointer;"
    >Refresh</button>
  `
  tc.appendChild(toast)
  document
    .getElementById("sw-update-btn")
    ?.addEventListener("click", async () => {
      await activateWaitingSw()
      window.location.reload()
    })
}) as EventListener)
