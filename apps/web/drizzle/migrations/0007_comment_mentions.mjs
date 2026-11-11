const objects = [
  ["comment_mentions", "table", "comment_mentions", `CREATE TABLE comment_mentions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    comment_id INTEGER NOT NULL,
    recipient_key TEXT NOT NULL CHECK (length(recipient_key) = 32),
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1)),
    FOREIGN KEY (comment_id, task_id) REFERENCES comments(id, task_id) ON DELETE CASCADE,
    UNIQUE (comment_id, recipient_key)
  )`],
  ["comment_mentions_recipient_idx", "index", "comment_mentions", "CREATE INDEX comment_mentions_recipient_idx ON comment_mentions(recipient_key, id DESC)"],
  ["comment_mentions_age_idx", "index", "comment_mentions", "CREATE INDEX comment_mentions_age_idx ON comment_mentions(created_at)"],
  ["comment_mention_attempts", "table", "comment_mention_attempts", `CREATE TABLE comment_mention_attempts (
    task_id TEXT NOT NULL,
    owner_key TEXT NOT NULL,
    attempt_key TEXT NOT NULL,
    body_digest TEXT NOT NULL,
    comment_id INTEGER NOT NULL,
    issued_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, owner_key, attempt_key)
  )`],
  ["comment_mention_attempts_age_idx", "index", "comment_mention_attempts", "CREATE INDEX comment_mention_attempts_age_idx ON comment_mention_attempts(issued_at)"],
]

const normalizedSql = sql => sql.replace(/\s+/g, "").toLowerCase()

async function reconcileCommentMentionsSchema(db, createMissing) {
  for (const [name, type, table, sql] of objects) {
    const { rows: [object] } = await db.execute({
      sql: "SELECT type, tbl_name, sql FROM sqlite_schema WHERE name = ?",
      args: [name],
    })
    if (!object && createMissing) {
      await db.execute(sql)
    } else if (object?.type !== type || object.tbl_name !== table ||
        typeof object.sql !== "string" || normalizedSql(object.sql) !== normalizedSql(sql)) {
      throw new Error(`Unexpected comment mentions ${type}: ${name}`)
    }
  }
}

export function applyCommentMentionsMigration(tx) {
  return reconcileCommentMentionsSchema(tx, true)
}

export function validateCommentMentionsSchema(db) {
  return reconcileCommentMentionsSchema(db, false)
}
