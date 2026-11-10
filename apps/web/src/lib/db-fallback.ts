/**
 * DB Fallback Utility — 503 + Retry-After on database unavailability
 *
 * Wraps API endpoint handlers with graceful database error handling.
 * When SQLite/LibSQL is unavailable, returns a proper 503 response
 * with Retry-After header instead of a raw 500.
 *
 * HA Compatibility:
 *   - Works within HA Supervisor ingress — 503 is passed through correctly
 *   - Client-side sync engine handles offline via IndexedDB automatically
 *
 * @domain infrastructure
 * @bounded-context api
 */

import { logApiError } from "./api-logger";

/** Known database error patterns that indicate unavailability (not bugs) */
const DB_UNAVAILABLE_PATTERNS = [
  "SQLITE_IOERR",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_READONLY",
  "database is locked",
  "unable to open database",
  "ENOENT",
  "EACCES",
] as const;

/**
 * Check if an error indicates database unavailability (vs a bug).
 */
export function isDbUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return DB_UNAVAILABLE_PATTERNS.some((pattern) =>
    message.includes(pattern),
  );
}

/**
 * Create a 503 response for database unavailability.
 * Includes Retry-After header (default: 10 seconds).
 */
export function db503Response(
  component: string,
  error: unknown,
  retryAfterSeconds = 10,
): Response {
  logApiError(component, "Database unavailable", error);

  return new Response(
    JSON.stringify({
      error: "Database temporarily unavailable",
      retry_after: retryAfterSeconds,
    }),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSeconds),
      },
    },
  );
}
