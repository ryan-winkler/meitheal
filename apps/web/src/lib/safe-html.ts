/**
 * safe-html — XSS prevention utilities for innerHTML interpolation
 *
 * Domain: Cross-cutting / Security
 * Purpose: Prevent stored-XSS when rendering server-sourced strings into innerHTML
 *
 * Usage:
 *   import { escapeHtml } from '@lib/safe-html'
 *   el.innerHTML = `<span>${escapeHtml(userInput)}</span>`
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
