const objects = [
  ["task_drafts", "table", "task_drafts", `CREATE TABLE task_drafts (
    owner_id TEXT NOT NULL PRIMARY KEY,
    draft_id TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
    save_attempt_id TEXT NOT NULL,
    save_digest TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`],
  ["task_draft_receipts", "table", "task_draft_receipts", `CREATE TABLE task_draft_receipts (
    published_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    draft_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    attempt_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    task_id TEXT NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    published_at INTEGER NOT NULL,
    UNIQUE (owner_id, draft_id, revision),
    UNIQUE (owner_id, attempt_id)
  )`],
  ["task_draft_receipts_latest_idx", "index", "task_draft_receipts", `CREATE INDEX task_draft_receipts_latest_idx
    ON task_draft_receipts (owner_id, published_seq DESC)`],
]

const normalizedSql = sql => sql.replace(/\s+/g, "").toLowerCase()

async function reconcileTaskDraftSchema(db, createMissing) {
  for (const [name, type, table, sql] of objects) {
    const { rows: [object] } = await db.execute({
      sql: "SELECT type, tbl_name, sql FROM sqlite_schema WHERE name = ?",
      args: [name],
    })
    if (!object && createMissing) {
      await db.execute(sql)
    } else if (object?.type !== type || object.tbl_name !== table ||
        typeof object.sql !== "string" || normalizedSql(object.sql) !== normalizedSql(sql)) {
      throw new Error(`Unexpected task drafts ${type}: ${name}`)
    }
  }
}

export function applyTaskDraftsMigration(tx) {
  return reconcileTaskDraftSchema(tx, true)
}

export function validateTaskDraftsSchema(db) {
  return reconcileTaskDraftSchema(db, false)
}
