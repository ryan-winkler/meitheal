/**
 * Shared utilities for settings domain controllers.
 *
 * Extracted from the monolithic settings-controller.ts to provide
 * reusable save/load and CSS sanitization helpers.
 */
import { createClientLogger } from "@lib/client-logger"
import { settingsStore } from "@lib/settings-store"
import { showToast } from "@lib/toast"

export const log = createClientLogger("settings")

// ───── Settings API helpers ─────

/** Save a single setting to the API via settingsStore */
export async function saveSetting(key: string, value: unknown): Promise<void> {
  await settingsStore.saveSetting(key, value)
}

export function showSettingsError(): void {
  showToast("Could not save changes. Your edits are still here; try again.", "error")
}

/** Catch settings action failures without losing the form or its retry control. */
export function settingsAction(handler: (event: Event) => unknown): (event: Event) => Promise<void> {
  return async (event) => {
    const target = event.currentTarget
    const button = target instanceof HTMLButtonElement ? target
      : event instanceof SubmitEvent && event.submitter instanceof HTMLButtonElement ? event.submitter : null
    const original = button?.innerHTML
    try {
      await handler(event)
    } catch {
      showSettingsError()
      if (button) {
        button.disabled = false
        if (original !== undefined) button.innerHTML = original
      }
    }
  }
}

/** Check transport and application failures for settings-related mutations. */
export async function settingsRequest(path: string, options?: RequestInit): Promise<Response> {
  const response = await fetch(path, options)
  if (!response.ok) throw new Error(`Settings request failed: ${response.status}`)
  const payload = await response.clone().json()
  if (payload?.ok === false) throw new Error("Settings request was rejected")
  return response
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
