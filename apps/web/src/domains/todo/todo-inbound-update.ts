import type { Client } from "@libsql/client"
import { deferralTerminalStatusesSql } from "../tasks/persistence/task-deferral-status"
import { nextTaskTimestampMs, taskTimestampMs } from "../tasks/persistence/task-timestamp"
import type { MeithealStatus } from "./todo-status-mapper"

/** Apply an inbound update and its confirmation against the same live link. */
export async function applyInboundTodoUpdate(
  client: Client,
  input: {
    confirmationId: string
    taskId: string
    entityId: string
    uid: string
    title: string
    status: MeithealStatus
    openEcho: boolean
    due: string | null
    description: string | null
    payload: string
  },
): Promise<boolean> {
  const taskVersion = taskTimestampMs("tasks.updated_at")
  const link = [input.confirmationId, input.taskId, input.entityId, input.uid]
  const matchingLink = "confirmation_id = ? AND task_id = ? AND ha_entity_id = ? AND ha_todo_uid = ?"
  const [task] = await client.batch([
    {
      sql: `UPDATE tasks SET
              title = ?,
              status = CASE WHEN ? AND deferred_at IS NOT NULL AND lower(status) NOT IN ${deferralTerminalStatusesSql}
                THEN status ELSE ? END,
              due_date = ?,
              description = COALESCE(?, description),
              deferral_revision = CASE WHEN ${taskVersion} = 9007199254740991
                THEN lower(hex(randomblob(16))) ELSE deferral_revision END,
              updated_at = ${nextTaskTimestampMs("tasks.updated_at")}
            WHERE id = ?
              AND EXISTS (
                SELECT 1 FROM todo_sync_confirmations confirmation
                WHERE ${matchingLink} AND ${taskVersion} <= ${taskTimestampMs("confirmation.updated_at")}
              )`,
      args: [input.title, input.openEcho ? 1 : 0, input.status, input.due, input.description, Date.now(), input.taskId, ...link],
    },
    {
      sql: `UPDATE todo_sync_confirmations
            SET payload = ?, updated_at = (SELECT updated_at FROM tasks WHERE id = ?)
            WHERE changes() > 0 AND ${matchingLink}`,
      args: [input.payload, input.taskId, ...link],
    },
  ], "write")
  return task?.rowsAffected === 1
}
