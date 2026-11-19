import type { Client } from "@libsql/client"
import { boardGrantStillCurrent, currentBoardGrantRevision } from "./board-grant-fence"

/** Preserve a conditional Household no-op only after independently verifying current retirement.
 * Never converts a continuity lock or a named-task authority change into success. */
export async function isCurrentRetiredHouseholdResult(db: Client, error: unknown, taskId?: string): Promise<boolean> {
  if (!error || typeof error !== "object" || !("status" in error) || error.status !== 409) return false
  const revision = await currentBoardGrantRevision(db)
  if (!revision) return false
  const { rows: [row] } = await db.execute(taskId === undefined
    ? "SELECT state FROM task_boards WHERE id = 'household'"
    : { sql: "SELECT board.state FROM task_boards board JOIN tasks task ON task.id = ? AND task.task_board_id IS NULL WHERE board.id = 'household'", args: [taskId] })
  return row?.state === "retired" && await boardGrantStillCurrent(db, revision)
}
