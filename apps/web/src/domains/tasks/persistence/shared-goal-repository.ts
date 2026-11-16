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
  named?: { description: string | null; status: string; target_date: string | null }
}

type NamedGoalScope = { areaName?: string; projectName?: string }

export function sharedGoalProjectionKey(goals: SharedGoalProgress[], names?: NamedGoalScope): string | undefined {
  return goals.length || names?.areaName || names?.projectName
    ? createHash("sha256").update(JSON.stringify([goals, names ?? null])).digest("hex")
    : undefined
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
        JOIN board_permissions AS policy ON policy.board_id = board.id
        WHERE grant.principal_type = 'ha_user' AND grant.principal_id = ?
          AND board.state IN ('active', 'archived')
        UNION ALL SELECT 'household'
      ), visible_areas AS (
        SELECT area.id FROM areas AS area
        WHERE COALESCE(area.owner_board_id, 'household') IN (SELECT id FROM visible_boards)
      ), visible_projects AS (
        SELECT project.id, project.goal_id, project.status, COALESCE(project.area_id, goal.area_id) AS area_id
        FROM projects AS project LEFT JOIN goals AS goal ON goal.id = project.goal_id
        WHERE COALESCE(project.owner_board_id, 'household') IN (SELECT id FROM visible_boards)
      ), readable_sources AS (
        SELECT share.goal_id, share.area_id, 0 AS named
        FROM scope CROSS JOIN board_goal_shares AS share
        JOIN areas AS area ON area.id = share.area_id
        WHERE (scope.area_id IS NULL OR share.area_id = scope.area_id)
          AND share.receiving_board_id = COALESCE(area.owner_board_id, 'household')
          AND share.area_id IN (SELECT id FROM visible_areas)
        UNION ALL
        SELECT owned.id AS goal_id,
               CASE WHEN owned.area_id IN (SELECT id FROM visible_areas) THEN owned.area_id END AS area_id,
               1 AS named
        FROM scope CROSS JOIN goals AS owned
        WHERE owned.owner_board_id IS NOT NULL AND owned.owner_board_id IN (SELECT id FROM visible_boards)
          AND (scope.area_id IS NULL OR (
            scope.area_id IN (SELECT id FROM visible_areas) AND
            (owned.area_id = scope.area_id OR EXISTS (
              SELECT 1 FROM visible_projects WHERE area_id = scope.area_id AND goal_id = owned.id
            ))
          ))
      ), readable_goals AS (
        SELECT source.goal_id,
               CASE WHEN COUNT(DISTINCT source.area_id) = 1 THEN MIN(source.area_id) END AS area_id,
               MAX(source.named) AS named
        FROM scope CROSS JOIN readable_sources AS source
        WHERE (scope.goal_id IS NULL OR source.goal_id = scope.goal_id)
          AND (scope.project_id IS NULL OR EXISTS (
            SELECT 1 FROM visible_projects AS selected
              WHERE selected.id = scope.project_id AND selected.goal_id = source.goal_id
                AND (scope.area_id IS NULL OR selected.area_id = scope.area_id)
          ))
          AND EXISTS (SELECT 1 FROM board_access_epoch WHERE singleton = 1 AND revision = scope.revision)
        GROUP BY source.goal_id
      )
      SELECT goal.id, goal.title, readable_goals.area_id, COUNT(project.id) AS project_count,
             COUNT(project.id) FILTER (WHERE project.status = 'completed') AS completed_project_count,
             readable_goals.named,
             CASE WHEN readable_goals.named THEN goal.description END AS description,
             CASE WHEN readable_goals.named THEN goal.status END AS status,
             CASE WHEN readable_goals.named THEN goal.target_date END AS target_date
      FROM readable_goals
      JOIN goals AS goal ON goal.id = readable_goals.goal_id
      JOIN task_boards AS owner ON owner.id = COALESCE(goal.owner_board_id, 'household') AND owner.state IN ('active', 'archived')
      LEFT JOIN projects AS project ON project.goal_id = goal.id
        AND COALESCE(project.owner_board_id, 'household') IN (SELECT id FROM visible_boards)
      GROUP BY goal.id, goal.title, readable_goals.area_id, readable_goals.named
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
    ...(row.named === 1 ? { named: {
      description: row.description == null ? null : String(row.description),
      status: String(row.status),
      target_date: row.target_date == null ? null : String(row.target_date),
    } } : {}),
  }))
}

export async function readNamedGoalScope(
  db: Client,
  locals: App.Locals,
  signal: AbortSignal,
  scope: SharedGoalScope,
): Promise<NamedGoalScope> {
  const viewer = verifiedIngressUser(locals)
  if (!viewer || signal.aborted) return {}
  const revision = await currentBoardGrantRevision(db)
  if (!revision || await verifyCurrentHAParticipant(viewer.id, signal) !== "allowed") return {}
  const { rows: [names] } = await db.execute({
    sql: `WITH scoped_boards AS (
          SELECT board.id FROM task_boards AS board
          JOIN board_access_grants AS grant ON grant.board_id = board.id
          JOIN board_permissions AS policy ON policy.board_id = board.id
          WHERE board.state IN ('active', 'archived') AND grant.principal_type = 'ha_user' AND grant.principal_id = ?
        )
        SELECT (SELECT name FROM areas WHERE id = ? AND owner_board_id IN (SELECT id FROM scoped_boards)) AS area_name,
               (SELECT title FROM projects WHERE id = ? AND owner_board_id IN (SELECT id FROM scoped_boards)) AS project_name
        WHERE EXISTS (SELECT 1 FROM board_access_epoch WHERE singleton = 1 AND revision = ?)`,
    args: [viewer.id, scope.areaId ?? null, scope.projectId ?? null, revision],
  })
  if (signal.aborted || !await boardGrantStillCurrent(db, revision)) return {}
  return {
    ...(typeof names?.area_name === "string" ? { areaName: names.area_name } : {}),
    ...(typeof names?.project_name === "string" ? { projectName: names.project_name } : {}),
  }
}

export function serializeBoardGoal({ named, ...goal }: SharedGoalProgress) {
  return named ? { ...goal, ...named, named: true } : { ...goal, status: "shared", shared: true }
}
