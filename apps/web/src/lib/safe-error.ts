/**
 * Safe Error Message — prevents stack trace leakage in API responses
 *
 * Extracts only the error message (not the stack trace) from caught errors.
 * Use this in API route catch blocks instead of `String(error)` which
 * exposes internal implementation details to clients.
 *
 * @domain observability
 * @kcs All API error responses MUST use safeErrorMessage() — never String(error)
 */

/**
 * Extract a user-safe message from an error.
 * Returns only the `.message` property — never the stack trace.
 * Falls back to a generic message for non-Error values.
 */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "An unexpected error occurred"
}
