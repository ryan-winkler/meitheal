/**
 * Controller for "Your Notification Preferences (This Browser)" in Settings > People & Notifications.
 */
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  loadNotificationPreferences,
  playNotificationSound,
  saveNotificationPreferences,
  type NotificationPreferences,
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

  const save = (patch: Partial<NotificationPreferences>) => {
    const saved = saveNotificationPreferences(patch)
    syncFromStorage()
    announce(saved
      ? window.mI18n?.get("settings.browser_notifications_saved") ?? "Notification preferences saved."
      : window.mI18n?.get("settings.browser_notifications_save_failed") ?? "Could not save notification preferences in this browser.")
    return saved
  }

  toastsToggle?.addEventListener("change", () => {
    save({ toastsEnabled: toastsToggle.checked })
  }, { signal })

  browserToggle?.addEventListener("change", () => {
    save({ browserNotificationsEnabled: browserToggle.checked })
  }, { signal })

  durationSelect?.addEventListener("change", () => {
    const num = Number(durationSelect.value)
    const toastDurationMs: ToastDurationChoice =
      num === 0 || num === 3000 || num === 5000 || num === 8000 ? num : 5000
    save({ toastDurationMs })
  }, { signal })

  swipeToggle?.addEventListener("change", () => {
    save({ swipeToDismiss: swipeToggle.checked })
  }, { signal })

  soundToggle?.addEventListener("change", () => {
    if (save({ soundEnabled: soundToggle.checked }) && soundToggle.checked) playNotificationSound("info")
  }, { signal })

  testBtn?.addEventListener("click", () => {
    const prefs = loadNotificationPreferences()
    pushToast({
      id: "user-notif-preview",
      message: window.mI18n?.get("settings.browser_notifications_sample") ?? "Sample notification",
      type: "info",
      persistent: prefs.toastDurationMs === 0,
      dedupe: false,
      action: !prefs.toastsEnabled
        ? { label: "Dismiss", onClick: () => {} }
        : undefined,
    })
  }, { signal })

  resetBtn?.addEventListener("click", () => {
    save(DEFAULT_NOTIFICATION_PREFERENCES)
  }, { signal })

  window.addEventListener("storage", syncFromStorage, { signal })
  signal.addEventListener("abort", () => {
    delete card.dataset.bound
  }, { once: true })
}
