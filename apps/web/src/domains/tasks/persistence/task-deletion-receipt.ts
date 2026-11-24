import type { Client } from "@libsql/client"
import { projectPublicTaskFields } from "../task-projection"
import { scopeAssignedTo, type BoardScope } from "../board-scope"
import { validateBoardPlacement } from "../board-access-service"
import { boardOperationClient } from "./board-operation-client"
import { sql, sourceSql } from "./sql-fragment"
import { ownedPlanning } from "./board-storage"

export type TaskDeletionReceipt = {
  id: string, eventId: string, deletedAt: number, task: Record<string, unknown>,
  placement: { areaId: string | null, projectId: string | null },
  bindingRefs: readonly { id: string, generation: number }[],
}

/** Internal commit evidence. No authority metadata is returned through task/event transports. */
export async function readTaskDeletionReceipt(db: Client, scope: BoardScope, eventId: string, taskId: string): Promise<TaskDeletionReceipt | null> {
  const tx = await boardOperationClient(db, scope, { resource: "task", action: "delete" }).transaction("read")
  try {
    const { rows: [row] } = await tx.execute(sql`SELECT payload, created_at FROM domain_events
      WHERE event_id = ${eventId} AND task_id = ${taskId} AND event_type = 'task.deleted' LIMIT 1`)
    if (!row || typeof row.payload !== "string") return null
    let payload: Record<string, unknown>
    try { payload = JSON.parse(row.payload) } catch { return null }
    const authority = payload?._authority
    if (!authority || typeof authority !== "object" || Array.isArray(authority)) return null
    const proof = authority as Record<string, unknown>
    if (proof.version !== 1 || proof.operation !== "delete" || proof.boardId !== scope.boardId ||
      proof.principalKind !== scope.principal.kind || proof.principalId !== scope.principal.id || payload.id !== taskId) return null
    const assigned = scopeAssignedTo(scope)
    if (assigned !== undefined && proof.oldAssignedTo !== assigned) return null
    const recorded = proof.placement as { areaId?: unknown, projectId?: unknown } | undefined
    if (!recorded && proof.oldProjectId != null) return null
    if (recorded && (recorded.areaId !== null && typeof recorded.areaId !== "string" || recorded.projectId !== null && typeof recorded.projectId !== "string" || recorded.areaId !== proof.oldAreaId || recorded.projectId !== proof.oldProjectId)) return null
    const areaId = typeof recorded?.areaId === "string" ? recorded.areaId : typeof proof.oldAreaId === "string" ? proof.oldAreaId : null
    const projectId = typeof recorded?.projectId === "string" ? recorded.projectId : typeof proof.oldProjectId === "string" ? proof.oldProjectId : null
    for (const [table, id] of [["areas", areaId], ["projects", projectId]] as const) {
      if (id && !(await tx.execute(sql`SELECT 1 FROM ${sourceSql(table)} WHERE id = ${id} AND ${ownedPlanning(scope, table)}`)).rows.length) return null
    }
    if (!await validateBoardPlacement(scope, tx, { areaId }) || !await validateBoardPlacement(scope, tx, { projectId })) return null
    if (!Array.isArray(proof.bindingRefs) || !proof.bindingRefs.every(item => item && typeof item === "object" &&
      typeof item.id === "string" && Number.isSafeInteger(item.generation) && item.generation >= 1)) return null
    await tx.commit()
    return { id: taskId, eventId, deletedAt: Number(row.created_at), task: projectPublicTaskFields(payload), placement: { areaId, projectId }, bindingRefs: proof.bindingRefs as { id: string, generation: number }[] }
  } finally { tx.close() }
}
