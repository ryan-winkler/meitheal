/** Canonical reaction storage shared by CLI migration and web initialization. */
export const taskReactionStorageSql = [
    `CREATE TABLE IF NOT EXISTS task_reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      comment_id INTEGER CHECK (comment_id > 0),
      owner_key TEXT NOT NULL,
      content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 16),
      author TEXT NOT NULL,
      FOREIGN KEY (comment_id, task_id) REFERENCES comments(id, task_id) ON DELETE CASCADE
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS task_reactions_owner_content_idx
      ON task_reactions(task_id, COALESCE(comment_id, 0), owner_key, content)`,
    "CREATE INDEX IF NOT EXISTS task_reactions_task_page_idx ON task_reactions(task_id, comment_id, id)",
    "CREATE INDEX IF NOT EXISTS task_reactions_comment_idx ON task_reactions(comment_id, task_id) WHERE comment_id IS NOT NULL",
  ]
