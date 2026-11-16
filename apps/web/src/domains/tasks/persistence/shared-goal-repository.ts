import { constants } from "node:fs"
import { open } from "node:fs/promises"
import type { Client } from "@libsql/client"
import { verifyCurrentHAParticipant } from "@domains/ha/current-admin"
import { verifiedIngressUser } from "@lib/verified-ingress-user"

const boardGrantPath = "/data/meitheal-board-grants.json"

export interface SharedGoalProgress {
  id: string
  title: string
  area_id: string | null
  project_count: number
  completed_project_count: number
}

/** An absent or expired copy outside the database only disables named access. */
async function readBoardGrantRevision(path: string): Promise<string | null> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > 160) return null
      const data = JSON.parse(await file.readFile("utf8")) as { epoch?: unknown }
      const value = data?.epoch
      return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) ? value : null
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

export interface SharedGoalScope {
  areaId?: string
  projectId?: string
}

export async function listSharedGoals(
  db: Client,
  locals: App.Locals,
  signal: AbortSignal,
  scope: SharedGoalScope,
): Promise<SharedGoalProgress[]> {
  const viewer = verifiedIngressUser(locals)
  if (!viewer || signal.aborted) return []
  const revision = await readBoardGrantRevision(boardGrantPath)
  if (!revision || await verifyCurrentHAParticipant(viewer.id, signal) !== "allowed") return []
  const goals = await readSharedGoals(db, viewer.id, scope, revision, signal)
  if (signal.aborted || await readBoardGrantRevision(boardGrantPath) !== revision) return []
  return goals
}

/** Read the share, the receiving Area and all contributing Projects in one snapshot. */
export async function readSharedGoals(
  db: Pick<Client, "execute">,
  userId: string,
  { areaId, projectId }: SharedGoalScope,
  grantRevision: string,
  signal?: AbortSignal,
): Promise<SharedGoalProgress[]> {
  if (signal?.aborted) return []
  const { rows } = await db.execute({
    sql: `WITH scope(area_id, project_id, revision) AS (VALUES (?, ?, ?)),
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
          AND share.receiving_board_id = COALESCE(area.owner_board_id, 'household')
          AND share.receiving_board_id IN (SELECT id FROM visible_boards)
          AND (scope.project_id IS NULL OR EXISTS (
            SELECT 1 FROM projects AS selected
            WHERE selected.id = scope.project_id AND selected.goal_id = share.goal_id
              AND COALESCE(selected.owner_board_id, 'household') IN (SELECT id FROM visible_boards)
              AND (scope.area_id IS NULL OR selected.area_id = scope.area_id)
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
    args: [areaId ?? null, projectId ?? null, grantRevision, userId],
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
