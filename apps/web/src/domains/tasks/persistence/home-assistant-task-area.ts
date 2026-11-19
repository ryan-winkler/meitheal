import type { Client, Transaction } from "@libsql/client"
import type { BoardScope } from "../board-scope"
import { validateBoardScope } from "../board-scope"
import { validateBoardFeature } from "../board-access-service"
import { taskOwnedBy } from "./board-storage"
import { sql, sourceSql } from "./sql-fragment"
import type { HomeAssistantAreaSelection } from "../../../lib/home-assistant-area-access"
import { taskTimestampMs } from "./task-timestamp"

export function setTaskHomeAssistantArea(scope: BoardScope, taskId: string, areaId: string | null) {
  return sql`INSERT INTO home_assistant_task_areas (task_id, area_id)
    SELECT id, ${areaId} FROM tasks WHERE id = ${taskId} AND ${taskOwnedBy(scope)}
    ON CONFLICT (task_id) DO UPDATE SET area_id = excluded.area_id, revision = home_assistant_task_areas.revision + 1 RETURNING revision`
}

export async function findTaskHomeAssistantArea(db: Pick<Client, "execute">, scope: BoardScope, taskId: string) {
  if (!await validateBoardFeature(scope, db, "home_assistant_area")) return null
  const { rows: [row] } = await db.execute(sql`SELECT area_id, revision FROM home_assistant_task_areas WHERE task_id = ${taskId}
    AND EXISTS (SELECT 1 FROM tasks WHERE tasks.id = home_assistant_task_areas.task_id AND ${taskOwnedBy(scope)})`)
  return { id: typeof row?.area_id === "string" ? row.area_id : null, locationRevision: Number(row?.revision ?? 0) }
}

export function readHomeAssistantAreaPolicyRevision(revision: string) {
  return { sql: "SELECT 1 FROM organization_access_policies WHERE scope = 'feature' AND scope_id = 'home_assistant_area' AND board_id = '' AND revision = ? AND audience <> 'nobody'", args: [revision] }
}

export async function editTaskHomeAssistantArea(tx: Transaction, scope: BoardScope, taskId: string, version: number, locationRevision: number, selection: HomeAssistantAreaSelection) {
  if (!(await validateBoardScope(scope, tx, { resource: "task", action: "edit" })).ok || !await validateBoardFeature(scope, tx, "home_assistant_area") ||
    !(await tx.execute(readHomeAssistantAreaPolicyRevision(selection.revision))).rows.length) return { ok: false, errorCode: "denied" } as const
  const { rows: [task] } = await tx.execute(sql`SELECT ${sourceSql(taskTimestampMs("updated_at"))} AS version FROM tasks WHERE id = ${taskId} AND ${taskOwnedBy(scope)}`)
  if (!task) return { ok: false, errorCode: "unavailable" } as const
  const previous = await findTaskHomeAssistantArea(tx, scope, taskId)
  if (!previous) return { ok: false, errorCode: "denied" } as const
  if (Number(task.version) !== version || previous.locationRevision !== locationRevision || locationRevision >= Number.MAX_SAFE_INTEGER) return { ok: false, errorCode: "stale" } as const
  const { rows: [updated] } = await tx.execute(setTaskHomeAssistantArea(scope, taskId, selection.id))
  return { ok: true, value: { version, locationRevision: Number(updated!.revision) } } as const
}

export function homeAssistantTaskAreaCondition(filter: { id: string; revision: string }) {
  const policy = readHomeAssistantAreaPolicyRevision(filter.revision)
  return { sql: `EXISTS (${policy.sql}) AND EXISTS (SELECT 1 FROM home_assistant_task_areas WHERE task_id = tasks.id AND area_id = ?)`, args: [...policy.args, filter.id] }
}
