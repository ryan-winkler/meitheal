/**
 * safe-html — XSS prevention utilities for innerHTML interpolation
 *
 * Domain: Cross-cutting / Security
 * Purpose: Prevent stored-XSS when rendering server-sourced strings into innerHTML
 *
 * Usage:
 *   import { escapeHtml, sanitizeCssColor } from '@lib/safe-html'
 *   el.innerHTML = `<span>${escapeHtml(userInput)}</span>`
 *   el.innerHTML = `<span style="background: ${sanitizeCssColor(color)}"></span>`
 *
 * KCS: All innerHTML interpolations of server-sourced data MUST use escapeHtml().
 * Direct textContent assignment is preferred when no HTML structure is needed.
 */

/** HTML-escape a string for safe innerHTML interpolation */
export function escapeHtml(str: unknown): string {
  const s = String(str ?? "")
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** Serialize JSON without allowing an embedded value to end its script element. */
export function serializeForScript(data: unknown): string {
  return (JSON.stringify(data) ?? "null").replace(/</g, "\\u003c")
}

/**
 * Sanitize a CSS color value to prevent CSS injection in inline styles.
 * Allows hex colors, rgb/rgba/hsl/hsla functions, CSS custom properties,
 * and named colors. Returns "transparent" for invalid values.
 */
const CSS_COLOR_RE = /^(#[0-9A-Fa-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([^)]*\)|var\(--[a-zA-Z0-9_-]+(?:\s*,\s*[^)]+)?\)|[a-zA-Z]{1,30})$/

export function sanitizeCssColor(value: unknown): string {
  const s = String(value ?? "").trim()
  return CSS_COLOR_RE.test(s) ? s : "transparent"
}
