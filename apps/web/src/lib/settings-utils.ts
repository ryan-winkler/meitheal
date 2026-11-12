/**
 * Shared utilities for settings domain controllers.
 *
 * Extracted from the monolithic settings-controller.ts to provide
 * reusable save/load and CSS sanitization helpers.
 */
import { createClientLogger } from "@lib/client-logger"
import { showToast } from "@lib/toast"
import { settingsStore } from "@lib/settings-store"

export const log = createClientLogger("settings")

// ───── Settings API helpers ─────

export function saveSetting(key: string, value: unknown): Promise<void> {
  return settingsStore.saveSetting(key, value)
}

export class PartialSettingsSave extends Error {}

/** Use the existing single-key API in order and stop on the first rejection. */
export async function saveSettings(changes: Record<string, unknown>): Promise<void> {
  let saved = false
  try {
    for (const [key, value] of Object.entries(changes)) {
      await saveSetting(key, value)
      saved = true
    }
  } catch (cause) {
    if (saved) throw new PartialSettingsSave("Some settings were saved", { cause })
    throw cause
  }
}

export function showSettingsSaveError(error: unknown): void {
  if (error instanceof DOMException && error.name === "AbortError") return
  log.warn("Settings action failed", error)
  showToast(error instanceof PartialSettingsSave ? "settings.save_partial" : "settings.save_error", "error")
}

/** Keep failed settings actions editable and restore their original button. */
export function settingsAction(handler: (event: Event) => unknown): (event: Event) => Promise<void> {
  return async event => {
    const button = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null
    if (button?.disabled) return
    const label = button?.innerHTML
    if (button) button.disabled = true
    try { await handler(event) } catch (error) { showSettingsSaveError(error) }
    finally {
      if (button) {
        button.disabled = false
        if (label !== undefined) button.innerHTML = label
      }
    }
  }
}



/** Load all settings from the API */
export async function loadAllSettings(): Promise<Record<string, unknown>> {
  try {
    return await settingsStore.load()
  } catch (e) {
    log.error("Failed to load settings from API", e)
    return {}
  }
}

// ───── CSS sanitization ─────

/** Max custom theme CSS file size in bytes */
export const MAX_THEME_SIZE = 51200 // 50KB

/** Dangerous CSS patterns to strip from imported themes */
const DANGEROUS_CSS_PATTERNS = [
  /@import\b[^;]*;/gi,
  /url\s*\([^)]*\)/gi,
  /expression\s*\([^)]*\)/gi,
  /javascript\s*:/gi,
  /behavior\s*:/gi,
  /-moz-binding\s*:/gi,
  /<script/gi,
  /<\/style/gi,
  /<\/script/gi,
]

/** Sanitize CSS content by stripping dangerous patterns */
export function sanitizeCSS(css: string): string {
  let safe = css
  for (const pattern of DANGEROUS_CSS_PATTERNS) {
    safe = safe.replace(pattern, "/* [removed] */")
  }
  return safe
}
