import type { Client } from "@libsql/client"
import { projectPublicTaskFields } from "../task-projection"
import { scopeAssignedTo, validateBoardScope, type BoardScope } from "../board-scope"
import { validateBoardPlacement } from "../board-access-service"
import { boardOperationClient } from "./board-operation-client"
import { scopedTaskRead } from "./board-work-query"
import { ownedPlanning } from "./board-storage"
import { taskTimestampMs } from "./task-timestamp"
import { sql, sourceSql } from "./sql-fragment"

export type TaskAssignmentReceipt = {
  id: string, eventId: string, assignedAt: number, task: Record<string, unknown>,
  placement: { areaId: string | null, projectId: string | null },
  bindingRefs: readonly { id: string, generation: number }[],
}

/** Commit evidence for this actor's own hand-back. It never grants a task read. */
export async function readTaskAssignmentReceipt(db: Client, scope: BoardScope, eventId: string, taskId: string): Promise<TaskAssignmentReceipt | null> {
  const tx = await boardOperationClient(db, scope, { resource: "task", action: "assign" }).transaction("read")
  try {
    const { rows: [row] } = await tx.execute(sql`SELECT response_payload, updated_at FROM integration_attempts
      WHERE attempt_id = ${eventId} AND task_id = ${taskId} AND integration IN ('mcp.handback','task.reassignment') AND status = 'completed'`)
    if (!row || typeof row.response_payload !== "string") return null
    let saved: Record<string, unknown>
    try { saved = JSON.parse(row.response_payload) } catch { return null }
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return null
    const proof = saved._authority as Record<string, unknown> | undefined
    const snapshot = saved.task as Record<string, unknown> | undefined
    if (!proof || !snapshot || proof.version !== 1 || proof.operation !== "assign" || proof.boardId !== scope.boardId ||
      proof.principalKind !== scope.principal.kind || proof.principalId !== scope.principal.id || saved.id !== taskId || snapshot.id !== taskId) return null
    const assigned = scopeAssignedTo(scope)
    if (assigned !== undefined && proof.oldAssignedTo !== assigned) return null
    if (!Array.isArray(proof.bindingRefs) || !proof.bindingRefs.every(item => item && typeof item.id === "string" && Number.isSafeInteger(item.generation) && item.generation >= 1)) return null
    const placement = proof.placement as { areaId: string | null, projectId: string | null } | undefined
    if (!placement || placement.areaId !== null && typeof placement.areaId !== "string" || placement.projectId !== null && typeof placement.projectId !== "string") return null
    const inspect = async (reader: Pick<Client, "execute">) => {
      const { rows: [task] } = await reader.execute(scopedTaskRead(scope, sql`SELECT assigned_to, area_id, project_id, ${sourceSql(taskTimestampMs("updated_at"))} AS version
        FROM scoped_tasks WHERE id = ${taskId}`))
      let effectiveArea = typeof task?.area_id === "string" ? task.area_id : null
      if (typeof task?.project_id === "string") {
        const { rows: [project] } = await reader.execute(sql`SELECT area_id FROM projects WHERE id = ${task.project_id} AND ${ownedPlanning(scope, "projects")}`)
        if (!project) return false
        if (typeof project.area_id === "string") effectiveArea = project.area_id
      }
      return task && effectiveArea === placement.areaId && (task.project_id ?? null) === placement.projectId && task.assigned_to === saved.assigned_to && Number(task.version) === proof.taskVersion &&
        await validateBoardPlacement(scope, reader, {
          areaId: typeof task.area_id === "string" ? task.area_id : null, projectId: typeof task.project_id === "string" ? task.project_id : null,
        })
    }
    if (!await inspect(tx)) return null
    await tx.commit()
    if (!await inspect(db) || !(await validateBoardScope(scope, db, { resource: "task", action: "assign" })).ok) return null
    return { id: taskId, eventId, assignedAt: Number(row.updated_at), task: projectPublicTaskFields(snapshot), placement, bindingRefs: proof.bindingRefs as { id: string, generation: number }[] }
  } finally { tx.close() }
}
