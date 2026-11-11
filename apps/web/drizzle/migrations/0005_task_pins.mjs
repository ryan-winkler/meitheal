const objects = [
  ["task_pins", "table", `CREATE TABLE task_pins (
    owner_id TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    pinned_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, task_id)
  )`],
  ["task_pins_owner_recent_idx", "index", `CREATE INDEX task_pins_owner_recent_idx
    ON task_pins (owner_id, pinned_at DESC, task_id ASC)`],
  ["task_pins_task_idx", "index", "CREATE INDEX task_pins_task_idx ON task_pins (task_id)"],
]

const normalizedSql = sql => sql.replace(/\s+/g, "").toLowerCase()

async function reconcileTaskPinsSchema(db, createMissing) {
  for (const [name, type, sql] of objects) {
    const { rows: [object] } = await db.execute({
      sql: "SELECT type, tbl_name, sql FROM sqlite_schema WHERE name = ?",
      args: [name],
    })
    if (!object && createMissing) {
      await db.execute(sql)
    } else if (object?.type !== type || object.tbl_name !== "task_pins" ||
        typeof object.sql !== "string" || normalizedSql(object.sql) !== normalizedSql(sql)) {
      throw new Error(`Unexpected task pins ${type}: ${name}`)
    }
  }
}

export function applyTaskPinsMigration(tx) {
  return reconcileTaskPinsSchema(tx, true)
}

export function validateTaskPinsSchema(db) {
  return reconcileTaskPinsSchema(db, false)
}
