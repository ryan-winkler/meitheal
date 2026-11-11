import { taskTimestampMs, type TaskClockColumn } from "../../../../drizzle/task-activity-sql.mjs"

export { taskTimestampMs }

export function nextTaskTimestampMs(column: TaskClockColumn): string {
  return `MIN(9007199254740991, MAX(${taskTimestampMs(column)} + 1, ?))`
}

/** A metadata edit must advance a real version, never repair a malformed one. */
export function canAdvanceTaskTimestampMs(column: TaskClockColumn): string {
  const parsed = `(CAST(strftime('%s', ${column}) AS INTEGER) * 1000
    + CAST(substr(strftime('%f', ${column}), 4, 3) AS INTEGER))`
  return `CASE
    WHEN typeof(${column}) IN ('integer', 'real') THEN
      ${column} >= 0 AND CAST(${column} AS INTEGER) < 9007199254740991
    WHEN typeof(${column}) = 'text' THEN
      substr(${column}, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND date(substr(${column}, 1, 10), '+0 days') = substr(${column}, 1, 10)
      AND strftime('%s', ${column}) IS NOT NULL
      AND ${parsed} >= 0 AND ${parsed} < 9007199254740991
    ELSE 0 END`
}
