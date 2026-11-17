import type { Client, Transaction } from "@libsql/client"
import type { HomeAssistantAreaSelection } from "../../../lib/home-assistant-area-access"
import { taskTimestampMs } from "./task-timestamp"

export function setTaskHomeAssistantArea(taskId: string, areaId: string | null) {
  return {
    sql: `INSERT INTO home_assistant_task_areas (task_id, area_id) VALUES (?, ?)
      ON CONFLICT (task_id) DO UPDATE SET area_id = excluded.area_id, revision = home_assistant_task_areas.revision + 1
      RETURNING revision`,
    args: [taskId, areaId],
  }
}

export async function findTaskHomeAssistantArea(db: Pick<Client, "execute">, taskId: string) {
  const { rows: [row] } = await db.execute({
    sql: "SELECT area_id, revision FROM home_assistant_task_areas WHERE task_id = ?",
    args: [taskId],
  })
  return { id: typeof row?.area_id === "string" ? row.area_id : null, locationRevision: Number(row?.revision ?? 0) }
}

export function readHomeAssistantAreaPolicyRevision(revision: string) {
  return {
    sql: `SELECT 1 FROM organization_access_policies WHERE scope = 'feature' AND scope_id = 'home_assistant_area'
      AND board_id = '' AND revision = ? AND audience <> 'nobody'`,
    args: [revision],
  }
}


export async function editTaskHomeAssistantArea(
  tx: Transaction, taskId: string, boardId: string | null, version: number, locationRevision: number, selection: HomeAssistantAreaSelection,
) {
  if (!(await tx.execute(readHomeAssistantAreaPolicyRevision(selection.revision))).rows.length) {
    return { ok: false, errorCode: "denied" } as const
  }
  const { rows: [task] } = await tx.execute({
    sql: `SELECT ${taskTimestampMs("updated_at")} AS version FROM tasks WHERE id = ? AND task_board_id IS ?`,
    args: [taskId, boardId],
  })
  if (!task) return { ok: false, errorCode: "unavailable" } as const
  const previous = await findTaskHomeAssistantArea(tx, taskId)
  if (Number(task.version) !== version || previous.locationRevision !== locationRevision ||
    locationRevision >= Number.MAX_SAFE_INTEGER) return { ok: false, errorCode: "stale" } as const
  const { rows: [updated] } = await tx.execute(setTaskHomeAssistantArea(taskId, selection.id))
  return { ok: true, value: { version, locationRevision: Number(updated!.revision) } } as const
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
