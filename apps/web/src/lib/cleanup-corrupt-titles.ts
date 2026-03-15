/**
 * Cleanup Corrupt Titles — One-time migration + duplicate purge
 *
 * @domain tasks
 * @bounded-context data-integrity
 *
 * Fixes corrupt task titles caused by HA todo/calendar sync loop
 * writing concatenated summary strings like
 * "📋 MTH-82: 📋 MTH-81: ... actual title — DUE — DUE"
 *
 * Phase 1: Delete duplicate tasks — tasks whose titles contain
 *   recursive MTH-NN prefixes are loop-created clones of the
 *   original task. Safe to delete because the original task
 *   (with the real title) still exists.
 * Phase 2: Sanitize remaining titles — strip any leftover prefix
 *   or suffix corruption patterns.
 *
 * Called from ha-startup.ts on first connect. Idempotent — safe to re-run.
 *
 * @kcs The corruption pattern is:
 * 1. Recursive "📋 MTH-NN: " prefixes (outbound sync formatted summary
 *    re-imported as new inbound task, then re-exported, each cycle adding
 *    another prefix layer)
 * 2. Trailing "— DUE" repetitions (due date indicator appended per cycle)
 * 3. The actual title is buried inside the concatenation
 */

import {
  ensureSchema,
  getPersistenceClient,
} from "@domains/tasks/persistence/store"

/**
 * Sanitize a single title string by stripping corruption patterns.
 */
export function sanitizeTodoTitle(summary: string): string {
  // Strip recursive "📋 MTH-NN: " or "🎯 MTH-NN: " or "📖 MTH-NN: " prefixes
  let clean = summary.replace(/^([📋🎯📖✅⚡]\s*MTH-\d+:\s*)+/g, "")
  // Also handle plain "MTH-NN: MTH-NN: " without emoji
  clean = clean.replace(/^(MTH-\d+:\s*)+/g, "")
  // Strip trailing "— DUE" repetitions (iterative to avoid ReDoS)
  while (/\s*—\s*DUE\s*$/i.test(clean)) {
    clean = clean.replace(/\s*—\s*DUE\s*$/i, "")
  }
  // Strip "Task MTH-NN is due. Open in Meitheal:..." notification text from description leaking into title
  clean = clean.replace(/\s*Task MTH-\d+ is due\.\s*Open in Meitheal:?.*/i, "")
  return clean.trim() || summary
}

/**
 * Run cleanup of corrupt titles and duplicate tasks in the tasks table.
 * Returns stats: { purged: number, cleaned: number }
 *
 * Phase 1 — Purge duplicates: delete tasks whose titles start with
 *   recursive MTH-NN prefixes (they are loop-created clones).
 * Phase 2 — Sanitize: fix remaining tasks with minor corruption.
 */
export async function cleanupCorruptTitles(): Promise<number> {
  await ensureSchema()
  const client = getPersistenceClient()

  // Phase 1: Delete loop-created duplicate tasks
  // These have titles like "📋 MTH-86: 📋 MTH-85: ... actual title"
  // The pattern: TWO OR MORE "📋 MTH-NN:" prefixes = definitely a loop duplicate.
  // A single prefix might be legitimate, but multiple nested is always corruption.
  const duplicates = await client.execute(
    `SELECT id FROM tasks WHERE
      title LIKE '%MTH-%:%MTH-%:%MTH-%:%'`,
  )

  let purged = 0
  for (const row of duplicates.rows) {
    const id = row.id as string
    // Also clean up sync confirmations for these tasks
    await client.execute({
      sql: "DELETE FROM todo_sync_confirmations WHERE task_id = ?",
      args: [id],
    })
    await client.execute({
      sql: "DELETE FROM calendar_confirmations WHERE task_id = ?",
      args: [id],
    }).catch(() => { /* table may not exist */ })
    await client.execute({
      sql: "DELETE FROM tasks WHERE id = ?",
      args: [id],
    })
    purged++
  }

  // Phase 2: Find remaining tasks with corruption patterns in their titles
  const result = await client.execute(
    `SELECT id, title FROM tasks WHERE
      title LIKE '%MTH-%:%MTH-%:%'
      OR title LIKE '%— DUE — DUE%'
      OR title LIKE '%📋 MTH-%'`,
  )

  let cleaned = 0
  for (const row of result.rows) {
    const id = row.id as string
    const oldTitle = row.title as string
    const newTitle = sanitizeTodoTitle(oldTitle)

    if (newTitle !== oldTitle) {
      await client.execute({
        sql: "UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?",
        args: [newTitle, Date.now(), id],
      })
      cleaned++
    }
  }

  return purged + cleaned
}
