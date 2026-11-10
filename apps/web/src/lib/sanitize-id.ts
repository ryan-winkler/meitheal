/**
 * Safe ID Validator — Path Traversal Prevention
 *
 * Validates that an identifier is safe for use in filesystem operations
 * and database queries. Rejects path traversal sequences and control characters.
 *
 * Bounded context: lib (shared utility)
 *
 * @domain validation
 */

/** Safe identifier pattern: alphanumeric, hyphens, underscores only */
const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/

/**
 * Validate that a string is a safe identifier (no path traversal).
 * Returns null if valid, or a descriptive error string.
 */
export function validateSafeId(value: unknown, field = "id"): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return `${field} is required`
  }
  if (value.includes("..") || value.includes("/") || value.includes("\\")) {
    return `${field} contains invalid path characters`
  }
  if (!SAFE_ID_RE.test(value)) {
    return `${field} must be alphanumeric (hyphens and underscores allowed)`
  }
  return null
}

/**
 * Sanitize a string for safe inclusion in log messages.
 * Replaces control characters and newlines to prevent log injection.
 */
export function sanitizeForLog(value: string, maxLen = 200): string {
  return value
    .replace(/[\x00-\x1f\x7f]/g, "")
    .slice(0, maxLen)
}
