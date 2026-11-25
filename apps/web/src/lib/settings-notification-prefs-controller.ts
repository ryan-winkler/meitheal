/**
 * Controller for "Your Notification Preferences (This Browser)" in Settings > People & Notifications.
 */
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_PREFS_CHANGE_EVENT,
  loadNotificationPreferences,
  playNotificationSound,
  saveNotificationPreferences,
  type ToastDurationChoice,
} from "./notification-preferences"
import { pushToast } from "./toast"

export function initNotificationPrefsSettings(signal: AbortSignal): void {
  const card = document.getElementById("user-notif-prefs-card")
  if (!card || card.dataset.bound === "true") return
  card.dataset.bound = "true"

  const toastsToggle = card.querySelector<HTMLInputElement>("#user-notif-toasts-toggle")
  const browserToggle = card.querySelector<HTMLInputElement>("#user-notif-browser-toggle")
  const durationSelect = card.querySelector<HTMLSelectElement>("#user-notif-duration-select")
  const swipeToggle = card.querySelector<HTMLInputElement>("#user-notif-swipe-toggle")
  const soundToggle = card.querySelector<HTMLInputElement>("#user-notif-sound-toggle")
  const testBtn = card.querySelector<HTMLButtonElement>("#user-notif-test-btn")
  const resetBtn = card.querySelector<HTMLButtonElement>("#user-notif-reset-btn")
  const statusEl = card.querySelector<HTMLElement>("#user-notif-status")

  const syncFromStorage = () => {
    const prefs = loadNotificationPreferences()
    if (toastsToggle) toastsToggle.checked = prefs.toastsEnabled
    if (browserToggle) browserToggle.checked = prefs.browserNotificationsEnabled
    if (durationSelect) durationSelect.value = String(prefs.toastDurationMs)
    if (swipeToggle) swipeToggle.checked = prefs.swipeToDismiss
    if (soundToggle) soundToggle.checked = prefs.soundEnabled
  }

  const announce = (msg: string) => {
    if (statusEl) statusEl.textContent = msg
  }

  syncFromStorage()

  toastsToggle?.addEventListener("change", () => {
    saveNotificationPreferences({ toastsEnabled: toastsToggle.checked })
    announce(toastsToggle.checked ? "In-app notifications enabled for this browser." : "Non-critical in-app toasts muted. Errors and Undo actions stay visible.")
  }, { signal })

  browserToggle?.addEventListener("change", () => {
    saveNotificationPreferences({ browserNotificationsEnabled: browserToggle.checked })
    announce(browserToggle.checked ? "Browser due-date reminders enabled." : "Browser due-date reminders muted on this device.")
  }, { signal })

  durationSelect?.addEventListener("change", () => {
    const num = Number(durationSelect.value)
    const toastDurationMs: ToastDurationChoice =
      num === 0 || num === 3000 || num === 5000 || num === 8000 ? num : 5000
    saveNotificationPreferences({ toastDurationMs })
    announce(toastDurationMs === 0 ? "Notifications stay visible until dismissed." : `Toast display duration set to ${toastDurationMs / 1000} seconds.`)
  }, { signal })

  swipeToggle?.addEventListener("change", () => {
    saveNotificationPreferences({ swipeToDismiss: swipeToggle.checked })
    announce(swipeToggle.checked ? "Swipe-to-dismiss enabled." : "Swipe-to-dismiss disabled.")
  }, { signal })

  soundToggle?.addEventListener("change", () => {
    saveNotificationPreferences({ soundEnabled: soundToggle.checked })
    if (soundToggle.checked) {
      playNotificationSound("info")
      announce("Notification sound enabled.")
    } else {
      announce("Notification sound muted.")
    }
  }, { signal })

  testBtn?.addEventListener("click", () => {
    const prefs = loadNotificationPreferences()
    pushToast({
      id: "user-notif-preview",
      message: "Sample notification — your browser preferences are active.",
      type: "info",
      persistent: prefs.toastDurationMs === 0,
      dedupe: false,
      action: !prefs.toastsEnabled
        ? { label: "Dismiss", onClick: () => {} }
        : undefined,
    })
    announce("Sent a sample notification.")
  }, { signal })

  resetBtn?.addEventListener("click", () => {
    saveNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES)
    syncFromStorage()
    announce("Restored default browser notification preferences.")
  }, { signal })

  window.addEventListener(NOTIFICATION_PREFS_CHANGE_EVENT, syncFromStorage, { signal })
  signal.addEventListener("abort", () => {
    delete card.dataset.bound
  }, { once: true })
}
