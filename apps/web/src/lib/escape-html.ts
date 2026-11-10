/**
 * HTML escaping utility — prevents XSS in innerHTML interpolations.
 *
 * @domain security
 * @bounded-context xss-prevention
 *
 * @kcs Use this function whenever interpolating user-supplied data into HTML
 * strings that will be assigned to innerHTML. Prefer textContent or DOM API
 * (createElement) where possible, but when innerHTML is unavoidable (e.g.
 * rendering search results with mixed HTML), escape all user data.
 *
 * Characters escaped: & < > " ' ` to their HTML entity equivalents.
 */

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
}

const ESCAPE_REGEX = /[&<>"'`]/g

/**
 * Escape HTML special characters in a string.
 * Returns the escaped string safe for innerHTML interpolation.
 */
export function escapeHtml(str: unknown): string {
  const s = String(str ?? "")
  return s.replace(ESCAPE_REGEX, (char) => ESCAPE_MAP[char] ?? char)
}
