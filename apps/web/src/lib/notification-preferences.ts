/**
 * Per-User Browser Notification Preferences & Sound Chime
 *
 * Stores local per-browser notification settings (toast visibility, duration,
 * swipe-to-dismiss, browser desktop notifications, and synthesized alert sound)
 * without polluting workspace-wide server settings.
 *
 * Bounded context: UI Infrastructure / Notifications
 */

import { currentTaskApiContext } from "./task-api"

export type ToastDurationChoice = 0 | 3000 | 5000 | 8000

export interface NotificationPreferences {
  toastsEnabled: boolean
  browserNotificationsEnabled: boolean
  toastDurationMs: ToastDurationChoice
  swipeToDismiss: boolean
  soundEnabled: boolean
}

const STORAGE_KEY_PREFIX = "meitheal:notification-prefs:v2:"

function notificationPreferencesKey(): string | undefined {
  const actor = currentTaskApiContext()?.actorKey
  if (actor) return STORAGE_KEY_PREFIX + actor
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  toastsEnabled: true,
  browserNotificationsEnabled: true,
  toastDurationMs: 5000,
  swipeToDismiss: true,
  soundEnabled: false,
}

const VALID_DURATIONS = new Set<number>([0, 3000, 5000, 8000])

export function normalizeNotificationPreferences(raw: unknown): NotificationPreferences {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES }
  }
  const obj = raw as Record<string, unknown>
  const durationNum = typeof obj.toastDurationMs === "number"
    ? obj.toastDurationMs
    : Number(obj.toastDurationMs)
  const toastDurationMs: ToastDurationChoice = VALID_DURATIONS.has(durationNum)
    ? (durationNum as ToastDurationChoice)
    : DEFAULT_NOTIFICATION_PREFERENCES.toastDurationMs

  return {
    toastsEnabled: typeof obj.toastsEnabled === "boolean"
      ? obj.toastsEnabled
      : DEFAULT_NOTIFICATION_PREFERENCES.toastsEnabled,
    browserNotificationsEnabled: typeof obj.browserNotificationsEnabled === "boolean"
      ? obj.browserNotificationsEnabled
      : DEFAULT_NOTIFICATION_PREFERENCES.browserNotificationsEnabled,
    toastDurationMs,
    swipeToDismiss: typeof obj.swipeToDismiss === "boolean"
      ? obj.swipeToDismiss
      : DEFAULT_NOTIFICATION_PREFERENCES.swipeToDismiss,
    soundEnabled: typeof obj.soundEnabled === "boolean"
      ? obj.soundEnabled
      : DEFAULT_NOTIFICATION_PREFERENCES.soundEnabled,
  }
}

export function loadNotificationPreferences(): NotificationPreferences {
  if (typeof window === "undefined") return { ...DEFAULT_NOTIFICATION_PREFERENCES }
  try {
    const key = notificationPreferencesKey()
    const raw = key && window.localStorage.getItem(key)
    if (!raw) return { ...DEFAULT_NOTIFICATION_PREFERENCES }
    return normalizeNotificationPreferences(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES }
  }
}

export function saveNotificationPreferences(
  patch: Partial<NotificationPreferences>,
): boolean {
  if (typeof window === "undefined") return false
  const key = notificationPreferencesKey()
  if (!key) return false
  const next = normalizeNotificationPreferences({
    ...loadNotificationPreferences(),
    ...patch,
  })
  try {
    window.localStorage.setItem(key, JSON.stringify(next))
    return true
  } catch {
    return false
  }
}

/**
 * Determine if a toast should be displayed given the user's preferences.
 * Errors, persistent notices, and actionable toasts (Undo / Retry) are never suppressed.
 */
export function shouldDisplayToast(
  prefs: NotificationPreferences,
  opts: { type: "success" | "error" | "warning" | "info"; persistent?: boolean; hasAction?: boolean },
): boolean {
  if (prefs.toastsEnabled) return true
  if (opts.type === "error" || opts.persistent || opts.hasAction) return true
  return false
}

/**
 * Resolve effective toast auto-dismiss duration from preferences and toast type.
 * Returns `Infinity` when user chooses manual dismiss (`0`) or toast is persistent.
 */
export function resolveToastDurationMs(
  prefs: NotificationPreferences,
  opts: { type: "success" | "error" | "warning" | "info"; explicitDuration?: number; persistent?: boolean },
): number {
  if (opts.persistent || opts.explicitDuration === Infinity) return Infinity
  if (prefs.toastDurationMs === 0) return Infinity
  if (typeof opts.explicitDuration === "number" && Number.isFinite(opts.explicitDuration)) {
    return opts.explicitDuration
  }
  const base = prefs.toastDurationMs
  if (opts.type === "error") return base + 2000
  if (opts.type === "warning") return base + 1000
  return base
}

let sharedAudioCtx: AudioContext | null = null

/**
 * Play a gentle, local-first synthesized chime via Web Audio API.
 * Uses zero external sound files and silently ignores browser autoplay blocks.
 */
export function playNotificationSound(
  kind: "success" | "error" | "warning" | "info" = "info",
): void {
  if (typeof window === "undefined") return
  const AudioCtx =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioCtx) return
  try {
    if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
      sharedAudioCtx = new AudioCtx()
    }
    if (sharedAudioCtx.state === "suspended") {
      void sharedAudioCtx.resume().catch(() => {})
    }
    const ctx = sharedAudioCtx
    const now = ctx.currentTime
    const tones: readonly [number, number][] =
      kind === "error"
        ? [[330, 0], [262, 0.11]]
        : kind === "warning"
          ? [[440, 0], [392, 0.11]]
          : kind === "success"
            ? [[523.25, 0], [659.25, 0.09]]
            : [[493.88, 0], [587.33, 0.09]]

    for (const [freq, offset] of tones) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = "sine"
      osc.frequency.setValueAtTime(freq, now + offset)
      gain.gain.setValueAtTime(0.0001, now + offset)
      gain.gain.exponentialRampToValueAtTime(0.08, now + offset + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.16)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + offset)
      osc.stop(now + offset + 0.18)
    }
  } catch {
    /* ignore autoplay / audio device errors */
  }
}
