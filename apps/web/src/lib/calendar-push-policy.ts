export interface CalendarPushPolicySettings {
  calendar_manual_push_enabled?: boolean | string | null
  calendar_sync_enabled?: boolean | string | null
  calendar_sync_mode?: string | null
  calendar_write_back?: boolean | string | null
  calendar_sync_interval_ms?: number | string | null
  [key: string]: unknown
}

function isExplicitlyFalse(value: unknown): boolean {
  if (value === false) return true
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    return normalized === "false" || normalized === "0" || normalized === "off"
  }
  return false
}

function isExplicitlyTrue(value: unknown): boolean {
  if (value === true) return true
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    return normalized === "true" || normalized === "1" || normalized === "on"
  }
  return false
}

function parseIntervalMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value)
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.max(0, parsed)
  }
  // Default calendar sync interval is 5 minutes when sync is enabled and unspecified
  return 300000
}

/**
 * Returns true when automatic bidirectional calendar sync (with write-back) is active.
 * In this mode, tasks with dates already export automatically on schedule, so manual
 * per-ticket "Push to calendar" controls are redundant and hidden.
 */
export function isAutomaticBidirectionalCalendarSync(settings?: CalendarPushPolicySettings | null): boolean {
  if (!settings) return false
  const syncEnabled = isExplicitlyTrue(settings.calendar_sync_enabled)
  if (!syncEnabled) return false

  const mode = String(settings.calendar_sync_mode ?? "bidirectional").trim().toLowerCase()
  const writeBackEnabled = !isExplicitlyFalse(settings.calendar_write_back)
  const intervalMs = parseIntervalMs(settings.calendar_sync_interval_ms)

  return mode === "bidirectional" && writeBackEnabled && intervalMs > 0
}

/**
 * Determines whether manual "Push to calendar" actions should be shown in task forms
 * and task details.
 *
 * Rules:
 * 1. If the user disabled `calendar_manual_push_enabled`, always hide it.
 * 2. If automatic bidirectional sync with write-back is active, hide it (redundant).
 * 3. Otherwise (manual sync interval = 0, export/write-back off, import-only, or sync off), show it.
 */
export function shouldShowManualCalendarPush(settings?: CalendarPushPolicySettings | null): boolean {
  if (settings && isExplicitlyFalse(settings.calendar_manual_push_enabled)) {
    return false
  }
  if (isAutomaticBidirectionalCalendarSync(settings)) {
    return false
  }
  return true
}

export function describeManualCalendarPushState(settings?: CalendarPushPolicySettings | null): {
  visible: boolean
  reason: string
} {
  if (settings && isExplicitlyFalse(settings.calendar_manual_push_enabled)) {
    return {
      visible: false,
      reason: "Hidden in task forms because manual push is turned off.",
    }
  }
  if (isAutomaticBidirectionalCalendarSync(settings)) {
    return {
      visible: false,
      reason: "Automatically hidden while scheduled bidirectional sync is active.",
    }
  }
  return {
    visible: true,
    reason: "Shown in task forms for on-demand calendar pushes.",
  }
}
