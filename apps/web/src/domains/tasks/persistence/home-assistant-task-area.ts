import type { Client, Transaction } from "@libsql/client"
import type { HomeAssistantAreaSelection } from "../../../lib/home-assistant-area-access"
import { canAdvanceTaskTimestampMs, nextTaskTimestampMs, taskTimestampMs } from "./task-timestamp"

export function setTaskHomeAssistantArea(taskId: string, areaId: string | null) {
  return areaId === null
    ? { sql: "DELETE FROM home_assistant_task_areas WHERE task_id = ?", args: [taskId] }
    : {
      sql: `INSERT INTO home_assistant_task_areas (task_id, area_id) VALUES (?, ?)
        ON CONFLICT (task_id) DO UPDATE SET area_id = excluded.area_id`,
      args: [taskId, areaId],
    }
}

export async function findTaskHomeAssistantArea(db: Pick<Client, "execute">, taskId: string): Promise<string | null> {
  const { rows: [row] } = await db.execute({
    sql: "SELECT area_id FROM home_assistant_task_areas WHERE task_id = ?",
    args: [taskId],
  })
  return typeof row?.area_id === "string" ? row.area_id : null
}


export function readHomeAssistantAreaPolicyRevision(revision: string) {
  return {
    sql: `SELECT 1 FROM organization_access_policies WHERE scope = 'feature' AND scope_id = 'home_assistant_area'
      AND board_id = '' AND revision = ? AND audience <> 'nobody'`,
    args: [revision],
  }
}


export async function editTaskHomeAssistantArea(
  tx: Transaction, taskId: string, boardId: string | null, version: number, selection: HomeAssistantAreaSelection,
) {
  if (!(await tx.execute(readHomeAssistantAreaPolicyRevision(selection.revision))).rows.length) {
    return { ok: false, errorCode: "denied" } as const
  }
  const { rows: [task] } = await tx.execute({
    sql: `UPDATE tasks SET updated_at = ${nextTaskTimestampMs("updated_at")}
      WHERE id = ? AND task_board_id IS ? AND ${taskTimestampMs("updated_at")} = ?
        AND (${canAdvanceTaskTimestampMs("updated_at")})
      RETURNING updated_at AS version`,
    args: [Date.now(), taskId, boardId, version],
  })
  if (!task) return { ok: false, errorCode: "stale" } as const
  await tx.execute(setTaskHomeAssistantArea(taskId, selection.id))
  return { ok: true, value: { version: Number(task.version) } } as const
}

export function homeAssistantTaskAreaCondition(filter: { id: string; revision: string }) {
  const policy = readHomeAssistantAreaPolicyRevision(filter.revision)
  return {
    sql: `EXISTS (${policy.sql}) AND EXISTS (
      SELECT 1 FROM home_assistant_task_areas WHERE task_id = tasks.id AND area_id = ?
    )`,
    args: [...policy.args, filter.id],
  }
}
