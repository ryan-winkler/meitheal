import test from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  normalizeNotificationPreferences,
  resolveToastDurationMs,
  shouldDisplayToast,
} from "./notification-preferences"

test("normalizeNotificationPreferences falls back cleanly on invalid inputs", () => {
  assert.deepEqual(normalizeNotificationPreferences(null), DEFAULT_NOTIFICATION_PREFERENCES)
  assert.deepEqual(
    normalizeNotificationPreferences({
      toastsEnabled: false,
      browserNotificationsEnabled: false,
      toastDurationMs: 8000,
      swipeToDismiss: false,
      soundEnabled: true,
    }),
    {
      toastsEnabled: false,
      browserNotificationsEnabled: false,
      toastDurationMs: 8000,
      swipeToDismiss: false,
      soundEnabled: true,
    },
  )
  assert.equal(normalizeNotificationPreferences({ toastDurationMs: 99999 }).toastDurationMs, 5000)
})

test("shouldDisplayToast never suppresses error, persistent, or actionable toasts", () => {
  const muted = { ...DEFAULT_NOTIFICATION_PREFERENCES, toastsEnabled: false }
  assert.equal(shouldDisplayToast(muted, { type: "success" }), false)
  assert.equal(shouldDisplayToast(muted, { type: "info" }), false)
  assert.equal(shouldDisplayToast(muted, { type: "error" }), true)
  assert.equal(shouldDisplayToast(muted, { type: "success", persistent: true }), true)
  assert.equal(shouldDisplayToast(muted, { type: "success", hasAction: true }), true)
})

test("resolveToastDurationMs respects manual dismiss, explicit durations, and severity buffers", () => {
  const manual = { ...DEFAULT_NOTIFICATION_PREFERENCES, toastDurationMs: 0 as const }
  assert.equal(resolveToastDurationMs(manual, { type: "success" }), Infinity)

  const brief = { ...DEFAULT_NOTIFICATION_PREFERENCES, toastDurationMs: 3000 as const }
  assert.equal(resolveToastDurationMs(brief, { type: "success" }), 3000)
  assert.equal(resolveToastDurationMs(brief, { type: "warning" }), 4000)
  assert.equal(resolveToastDurationMs(brief, { type: "error" }), 5000)
  assert.equal(resolveToastDurationMs(brief, { type: "info", persistent: true }), Infinity)
})
