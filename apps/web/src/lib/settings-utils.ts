/**
 * Shared utilities for settings domain controllers.
 *
 * Extracted from the monolithic settings-controller.ts to provide
 * reusable save/load and CSS sanitization helpers.
 */
import { createClientLogger } from "@lib/client-logger"
import { pageLifecycle } from "@lib/page-lifecycle"
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
    const savedNodes = button ? Array.from(button.childNodes).map(n => n.cloneNode(true)) : null
    if (button) button.disabled = true
    try { await handler(event) } catch (error) { showSettingsSaveError(error) }
    finally {
      if (button) {
        button.disabled = false
        if (savedNodes) button.replaceChildren(...savedNodes)
      }
    }
  }
}



export const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null

export function domEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Trigger a client-side file download from text/JSON content. */
export function downloadBlob(content: BlobPart, mimeType: string, filename: string, appendToBody = false): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }))
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  if (appendToBody) document.body.append(link)
  link.click()
  if (appendToBody) link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Defer work until a Settings section is shown, optionally on each reveal. */
export function whenSectionVisible(target: Element | null, run: () => void, repeatOnReveal = false): void {
  if (!target) return
  const section = target.closest<HTMLElement>("[data-settings-shell-section]")
  let visible = !section?.hidden
  if (visible) run()
  if (!section || (visible && !repeatOnReveal)) return
  const observer = new MutationObserver(() => {
    const revealed = !section.hidden && !visible
    visible = !section.hidden
    if (revealed) {
      if (!repeatOnReveal) observer.disconnect()
      run()
    }
  })
  observer.observe(section, { attributes: true, attributeFilter: ["hidden"] })
  pageLifecycle.signal.addEventListener("abort", () => observer.disconnect(), { once: true })
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
