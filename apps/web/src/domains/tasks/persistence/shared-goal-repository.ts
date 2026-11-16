import { createHash } from "node:crypto"
import type { Client } from "@libsql/client"
import { verifyCurrentHAParticipant } from "@domains/ha/current-admin"
import { verifiedIngressUser } from "@lib/verified-ingress-user"

import { boardGrantStillCurrent, currentBoardGrantRevision } from "./board-grant-fence"

export interface SharedGoalProgress {
  id: string
  title: string
  area_id: string | null
  project_count: number
  completed_project_count: number
}

export function sharedGoalProjectionKey(goals: SharedGoalProgress[]): string | undefined {
  return goals.length ? createHash("sha256").update(JSON.stringify(goals)).digest("hex") : undefined
}

export interface SharedGoalScope {
  areaId?: string
  projectId?: string
  goalId?: string
}

export async function listSharedGoals(
  db: Client,
  locals: App.Locals,
  signal: AbortSignal,
  scope: SharedGoalScope,
): Promise<SharedGoalProgress[]> {
  const viewer = verifiedIngressUser(locals)
  if (!viewer || signal.aborted) return []
  const revision = await currentBoardGrantRevision(db)
  if (!revision || await verifyCurrentHAParticipant(viewer.id, signal) !== "allowed") return []
  const goals = await readSharedGoals(db, viewer.id, scope, revision, signal)
  if (signal.aborted || !await boardGrantStillCurrent(db, revision)) return []
  return goals
}

/** Read the share, the receiving Area and all contributing Projects in one snapshot. */
export async function readSharedGoals(
  db: Pick<Client, "execute">,
  userId: string,
  { areaId, projectId, goalId }: SharedGoalScope,
  grantRevision: string,
  signal?: AbortSignal,
): Promise<SharedGoalProgress[]> {
  if (signal?.aborted) return []
  const { rows } = await db.execute({
    sql: `WITH scope(area_id, project_id, goal_id, revision) AS (VALUES (?, ?, ?, ?)),
      visible_boards AS (
        SELECT board.id
        FROM task_boards AS board
        JOIN board_access_grants AS grant ON grant.board_id = board.id
        WHERE grant.principal_type = 'ha_user' AND grant.principal_id = ?
          AND board.state IN ('active', 'archived')
        UNION ALL SELECT 'household'
      ), readable_shares AS (
        SELECT share.goal_id, CASE WHEN COUNT(*) = 1 THEN MIN(share.area_id) END AS area_id
        FROM scope CROSS JOIN board_goal_shares AS share
        JOIN areas AS area ON area.id = share.area_id
        WHERE (scope.area_id IS NULL OR share.area_id = scope.area_id)
          AND (scope.goal_id IS NULL OR share.goal_id = scope.goal_id)
          AND share.receiving_board_id = COALESCE(area.owner_board_id, 'household')
          AND share.receiving_board_id IN (SELECT id FROM visible_boards)
          AND (scope.project_id IS NULL OR EXISTS (
            SELECT 1 FROM projects AS selected
            WHERE selected.id = scope.project_id AND selected.goal_id = share.goal_id
              AND COALESCE(selected.owner_board_id, 'household') IN (SELECT id FROM visible_boards)
              AND (scope.area_id IS NULL OR COALESCE(selected.area_id, (
                SELECT owning_goal.area_id FROM goals AS owning_goal WHERE owning_goal.id = selected.goal_id
              )) = scope.area_id)
          ))
          AND EXISTS (SELECT 1 FROM board_access_epoch WHERE singleton = 1 AND revision = scope.revision)
        GROUP BY share.goal_id
      )
      SELECT goal.id, goal.title, readable_shares.area_id, COUNT(project.id) AS project_count,
             COUNT(project.id) FILTER (WHERE project.status = 'completed') AS completed_project_count
      FROM readable_shares
      JOIN goals AS goal ON goal.id = readable_shares.goal_id
      JOIN task_boards AS owner ON owner.id = COALESCE(goal.owner_board_id, 'household') AND owner.state IN ('active', 'archived')
      LEFT JOIN projects AS project ON project.goal_id = goal.id
        AND COALESCE(project.owner_board_id, 'household') IN (SELECT id FROM visible_boards)
      GROUP BY goal.id, goal.title, readable_shares.area_id
      ORDER BY goal.title COLLATE NOCASE, goal.id`,
    args: [areaId ?? null, projectId ?? null, goalId ?? null, grantRevision, userId],
  })
  if (signal?.aborted) return []
  return rows.map(row => ({
    id: String(row.id),
    title: String(row.title),
    area_id: row.area_id == null ? null : String(row.area_id),
    project_count: Number(row.project_count),
    completed_project_count: Number(row.completed_project_count),
  }))
}
