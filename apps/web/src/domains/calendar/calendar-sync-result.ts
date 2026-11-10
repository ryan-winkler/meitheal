import type { CalendarSyncCounts } from "./calendar-bridge"

/** Keep unavailable/skipped calendars distinct from successful empty calendars. */
export function calendarSyncResult(entities: string[], results: PromiseSettledResult<CalendarSyncCounts>[]) {
  const counts = { created: 0, updated: 0, total: 0 }
  const failures: Array<{ entity_id: string; error: string }> = []
  results.forEach((result, index) => {
    if (result.status === "rejected" || result.value.skipped) {
      failures.push({ entity_id: entities[index]!, error: result.status === "rejected"
        ? "Calendar sync failed; check integration status and server logs"
        : result.value.skipped! })
    } else {
      counts.created += result.value.created
      counts.updated += result.value.updated
      counts.total += result.value.total
    }
  })
  return {
    ok: failures.length === 0,
    partial: failures.length > 0 && failures.length < entities.length,
    message: failures.length ? `Calendar sync incomplete: ${failures.length} calendar(s) failed or skipped`
      : `Calendar sync complete: ${counts.created} created, ${counts.updated} updated from ${counts.total} events`,
    ...counts,
    entities,
    failures,
  }
}
