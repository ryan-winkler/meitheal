/**
 * Input Validation Utilities — Shared Guards
 *
 * Reusable validation functions for API request handling.
 * All validators return a descriptive error string or null if valid.
 *
 * Bounded context: lib (shared utility)
 *
 * @domain validation
 */

/** UUID v4 format regex (case-insensitive) */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate that a string is a valid UUID v4 format.
 * Returns error message or null if valid.
 */
export function validateUuid(value: unknown, field = "id"): string | null {
  if (typeof value !== "string") return `${field} must be a string`;
  if (!UUID_RE.test(value)) return `${field} must be a valid UUID`;
  return null;
}

/** Canonical status values — matches status-config.ts */
const CANONICAL_STATUSES = new Set(["backlog", "pending", "active", "complete"]);

/**
 * Validate that a status value is in the canonical set.
 * Returns error message or null if valid.
 */
export function validateStatus(value: unknown): string | null {
  if (typeof value !== "string") return "status must be a string";
  if (!CANONICAL_STATUSES.has(value)) {
    return `Invalid status "${value}". Must be one of: ${[...CANONICAL_STATUSES].join(", ")}`;
  }
  return null;
}

/**
 * Validate priority is a number between 1-5.
 */
export function validatePriority(value: unknown): string | null {
  if (value === undefined || value === null) return null; // optional
  const num = typeof value === "string" ? parseInt(value, 10) : value;
  if (typeof num !== "number" || isNaN(num)) return "priority must be a number";
  if (num < 1 || num > 5) return "priority must be between 1 and 5";
  return null;
}

/**
 * Validate that a string is a non-empty trimmed title.
 */
export function validateTitle(value: unknown): string | null {
  if (typeof value !== "string") return "title must be a string";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "title cannot be empty";
  if (trimmed.length > 500) return "title must be 500 characters or fewer";
  return null;
}

/**
 * Validate a date string — accepts ISO 8601 and YYYY-MM-DD formats.
 */
export function validateDateString(value: unknown, field = "date"): string | null {
  if (value === undefined || value === null || value === "") return null; // optional
  if (typeof value !== "string") return `${field} must be a string`;
  const d = new Date(value);
  if (isNaN(d.getTime())) return `${field} must be a valid date`;
  return null;
}

/**
 * Batch validate multiple fields. Returns the first error found, or null.
 */
export function firstError(...errors: (string | null)[]): string | null {
  return errors.find((e) => e !== null) ?? null;
}
