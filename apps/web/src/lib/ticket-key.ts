/**
 * Ticket Key — Human-readable task identifiers (MTH-1, MTH-42, etc.)
 *
 * The ticket key is a display-layer concept. Internally, tasks still use UUIDs
 * as primary keys. The ticket_number column provides a stable, sequential,
 * human-friendly reference for each task.
 */

/** Project prefix for human-readable ticket keys */
const TICKET_PREFIX = "MTH";

/** Format a ticket number as a human-readable key: MTH-1, MTH-42, etc. */
export function formatTicketKey(
  ticketNumber: number | null | undefined,
): string | null {
  if (ticketNumber == null || ticketNumber <= 0) return null;
  return `${TICKET_PREFIX}-${ticketNumber}`;
}

/** Extract the numeric portion from a ticket key string (e.g. "MTH-42" → 42) */
export function parseTicketKey(key: string): number | null {
  const match = key.match(new RegExp(`^${TICKET_PREFIX}-(\\d+)$`, "i"));
  return match ? parseInt(match[1]!, 10) : null;
}
