type TaskClockColumn = "created_at" | "updated_at" | "t.updated_at" | "task.updated_at" | "tasks.updated_at" | "confirmation.updated_at"

/** Normalize the epoch and legacy ISO values stored by task writers. */
export function taskTimestampMs(column: TaskClockColumn): string {
  return `MAX(0, COALESCE(CASE
    WHEN typeof(${column}) IN ('integer', 'real') AND ${column} <= 9007199254740991
      THEN CAST(${column} AS INTEGER)
    WHEN typeof(${column}) = 'text'
      AND substr(${column}, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND date(substr(${column}, 1, 10), '+0 days') = substr(${column}, 1, 10)
      THEN CAST(strftime('%s', ${column}) AS INTEGER) * 1000
        + CAST(substr(strftime('%f', ${column}), 4, 3) AS INTEGER)
  END, 0))`
}

export function nextTaskTimestampMs(column: TaskClockColumn): string {
  return `MIN(9007199254740991, MAX(${taskTimestampMs(column)} + 1, ?))`
}
