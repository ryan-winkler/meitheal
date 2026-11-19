import { createHash } from "node:crypto"
import type { Client } from "@libsql/client"
import { BoardAccessService, validateBoardPlacement } from "../board-access-service"
import { requireBoardScope, validateBoardScope, type BoardScope } from "../board-scope"
import { boardOperationClient } from "./board-operation-client"
import { changeBoardGrants } from "./board-grant-fence"
import { ownedPlanning } from "./board-storage"
import { planningVisible } from "./board-work-query"
import { sql, type SqlFragment } from "./sql-fragment"

export interface SharedGoalProgress {
  id: string
  title: string
  area_id: string | null
  project_count: number
  completed_project_count: number
  named?: { description: string | null; status: string; target_date: string | null }
}
export interface SharedGoalScope {
  areaId?: string
  projectId?: string
  goalId?: string
}
export type GoalShareTarget =
  | { kind: "board"; boardId: string }
  | { kind: "area"; boardId: string; areaId: string }
  | { kind: "project"; boardId: string; projectId: string }
/** Writer-side eligibility for a Goal association, never a private Goal-detail projection. */
export function goalEligibility(
  scope: BoardScope,
  goalId: SqlFragment,
  placement: { areaId: SqlFragment; projectId?: SqlFragment }
): SqlFragment {
  requireBoardScope(scope)
  return sql`EXISTS(SELECT 1 FROM goals
    JOIN task_boards AS goal_owner ON (goal_owner.id=goals.owner_board_id OR (goals.owner_board_id IS NULL AND goal_owner.storage_encoding='legacy_null_v1'))
      AND goal_owner.state IN ('active','archived')
    WHERE goals.id=${goalId} AND goals.retired_at IS NULL AND (
      (${ownedPlanning(scope, "goals")} AND ${planningVisible(scope, "goals")}) OR EXISTS(
        SELECT 1 FROM board_goal_shares AS receiving WHERE receiving.goal_id=goals.id AND receiving.receiving_board_id=${scope.boardId}
          AND ((receiving.area_id IS NULL AND receiving.project_id IS NULL) OR receiving.area_id=${placement.areaId} OR receiving.project_id=${placement.projectId ?? sql`${null}`})
          AND (receiving.area_id IS NULL OR EXISTS(SELECT 1 FROM areas WHERE areas.id=receiving.area_id AND ${ownedPlanning(scope, "areas")} AND ${planningVisible(scope, "areas")} AND retired_at IS NULL))
          AND (receiving.project_id IS NULL OR EXISTS(SELECT 1 FROM projects WHERE projects.id=receiving.project_id AND ${ownedPlanning(scope, "projects")} AND ${planningVisible(scope, "projects")} AND retired_at IS NULL))
      )))`
}
type NamedGoalScope = { areaName?: string; projectName?: string }
export function sharedGoalProjectionKey(
  goals: SharedGoalProgress[],
  names?: NamedGoalScope
): string | undefined {
  return goals.length || names?.areaName || names?.projectName
    ? createHash("sha256")
        .update(JSON.stringify([goals, names ?? null]))
        .digest("hex")
    : undefined
}
export async function listSharedGoals(
  db: Client,
  scope: BoardScope,
  filter: SharedGoalScope = {},
  signal?: AbortSignal
): Promise<SharedGoalProgress[]> {
  const tx = await boardOperationClient(db, scope, {
    resource: "goal",
    action: "read"
  }).transaction("read")
  try {
    const result = await readSharedGoals(tx, scope, filter, signal)
    await tx.commit()
    return result
  } finally {
    tx.close()
  }
}

/** One admitted snapshot. Only contributing Projects the current actor can read enter totals. */
export async function readSharedGoals(
  db: Pick<Client, "execute">,
  scope: BoardScope,
  filter: SharedGoalScope = {},
  signal?: AbortSignal
): Promise<SharedGoalProgress[]> {
  requireBoardScope(scope)
  if (
    signal?.aborted ||
    !(await validateBoardScope(scope, db, { resource: "goal", action: "read" })).ok
  )
    return []
  const access = new BoardAccessService(db as Client)
  const { rows: boards } = await db.execute(
    "SELECT id FROM task_boards WHERE state IN ('active','archived') ORDER BY id"
  )
  const projects: Array<{
    id: string
    goalId: string | null
    areaId: string | null
    status: string
    boardId: string
  }> = []
  for (const board of boards) {
    const resolved = await access.resolveInTransaction(
      scope.principal,
      String(board.id),
      { resource: "project", action: "read" },
      db,
      scope.authorityRevision
    )
    if (!resolved.ok) continue
    const { rows } = await db.execute(
      sql`SELECT id,goal_id,area_id,status FROM projects WHERE ${ownedPlanning(resolved.scope, "projects")} AND ${planningVisible(resolved.scope, "projects")} AND retired_at IS NULL`
    )
    for (const row of rows)
      projects.push({
        id: String(row.id),
        goalId: typeof row.goal_id === "string" ? row.goal_id : null,
        areaId: typeof row.area_id === "string" ? row.area_id : null,
        status: String(row.status),
        boardId: resolved.scope.boardId
      })
  }
  const { rows: goals } =
    await db.execute(sql`SELECT goals.id,goals.title,goals.description,goals.status,goals.target_date,goals.area_id,
    COALESCE(goals.owner_board_id,legacy.id) AS source_board_id,
    (${ownedPlanning(scope, "goals")} AND ${planningVisible(scope, "goals")}) AS locally_owned
    FROM goals LEFT JOIN task_boards AS legacy ON legacy.storage_encoding='legacy_null_v1'
    JOIN task_boards AS owner ON owner.id=COALESCE(goals.owner_board_id,legacy.id) AND owner.state IN ('active','archived')
    WHERE goals.retired_at IS NULL AND ((${ownedPlanning(scope, "goals")} AND ${planningVisible(scope, "goals")})
      OR EXISTS(SELECT 1 FROM board_goal_shares AS share WHERE share.goal_id=goals.id AND share.receiving_board_id=${scope.boardId}))
    ORDER BY goals.title COLLATE NOCASE,goals.id`)
  const { rows: shares } = await db.execute(
    sql`SELECT goal_id,area_id,project_id FROM board_goal_shares WHERE receiving_board_id=${scope.boardId}`
  )
  const result: SharedGoalProgress[] = []
  for (const goal of goals) {
    const id = String(goal.id)
    if (filter.goalId && filter.goalId !== id) continue
    const contributions = projects.filter((project) => project.goalId === id)
    const selectedProjects = contributions.filter((project) => project.boardId === scope.boardId)
    const validShares = []
    for (const share of shares.filter((share) => share.goal_id === id)) {
      if (share.area_id !== null) {
        const { rows } = await db.execute(
          sql`SELECT id FROM areas WHERE id=${String(share.area_id)} AND ${ownedPlanning(scope, "areas")} AND ${planningVisible(scope, "areas")} AND retired_at IS NULL`
        )
        if (!rows.length) continue
      }
      if (share.project_id !== null) {
        const { rows } = await db.execute(
          sql`SELECT id FROM projects WHERE id=${String(share.project_id)} AND ${ownedPlanning(scope, "projects")} AND ${planningVisible(scope, "projects")} AND retired_at IS NULL`
        )
        if (!rows.length) continue
      }
      validShares.push(share)
    }
    const owned = goal.locally_owned === 1
    if (!owned && !validShares.length) continue
    if (filter.areaId) {
      if (!(await validateBoardPlacement(scope, db, { areaId: filter.areaId }))) continue
      const relevant =
        (owned && goal.area_id === filter.areaId) ||
        validShares.some(
          (share) =>
            share.area_id === filter.areaId ||
            (share.project_id !== null &&
              projects.some(
                (project) =>
                  project.id === share.project_id &&
                  project.areaId === filter.areaId &&
                  project.boardId === scope.boardId
              ))
        ) ||
        selectedProjects.some((project) => project.areaId === filter.areaId)
      if (!relevant) continue
    }
    if (
      filter.projectId &&
      !validShares.some((share) => share.project_id === filter.projectId) &&
      !selectedProjects.some((project) => project.id === filter.projectId)
    )
      continue
    result.push({
      id,
      title: String(goal.title),
      area_id: filter.areaId ?? (owned && typeof goal.area_id === "string" ? goal.area_id : null),
      project_count: contributions.length,
      completed_project_count: contributions.filter((project) => project.status === "completed")
        .length,
      ...(owned
        ? {
            named: {
              description: goal.description === null ? null : String(goal.description),
              status: String(goal.status),
              target_date: goal.target_date === null ? null : String(goal.target_date)
            }
          }
        : {})
    })
  }
  if (
    signal?.aborted ||
    !(await validateBoardScope(scope, db, { resource: "goal", action: "read" })).ok
  )
    return []
  return result
}

export async function readNamedGoalScope(
  db: Client,
  scope: BoardScope,
  filter: SharedGoalScope,
  signal?: AbortSignal
): Promise<NamedGoalScope> {
  if (signal?.aborted) return {}
  const tx = await boardOperationClient(db, scope, {
    resource: "goal",
    action: "read"
  }).transaction("read")
  try {
    const result: NamedGoalScope = {}
    if (filter.areaId) {
      const {
        rows: [area]
      } = await tx.execute(
        sql`SELECT name FROM areas WHERE id=${filter.areaId} AND ${ownedPlanning(scope, "areas")} AND ${planningVisible(scope, "areas")} AND retired_at IS NULL`
      )
      if (typeof area?.name === "string") result.areaName = area.name
    }
    if (filter.projectId) {
      const {
        rows: [project]
      } = await tx.execute(
        sql`SELECT title FROM projects WHERE id=${filter.projectId} AND ${ownedPlanning(scope, "projects")} AND ${planningVisible(scope, "projects")} AND retired_at IS NULL`
      )
      if (typeof project?.title === "string") result.projectName = project.title
    }
    await tx.commit()
    return result
  } finally {
    tx.close()
  }
}
export function serializeBoardGoal({ named, ...goal }: SharedGoalProgress) {
  return named ? { ...goal, ...named, named: true } : { ...goal, status: "shared", shared: true }
}

export async function changeGoalShare(
  db: Client,
  source: BoardScope,
  goalId: string,
  target: GoalShareTarget,
  enabled: boolean
) {
  requireBoardScope(source)
  if (!["ha_user", "local_operator"].includes(source.principal.kind))
    return { status: "unchanged", result: "unavailable" } as const
  const recipient = await new BoardAccessService(db).resolve(source.principal, target.boardId, {
    resource: "board",
    action: "manage"
  })
  if (!recipient.ok) return { status: "unchanged", result: "unavailable" } as const
  return changeBoardGrants(db, async (tx, epoch) => {
    if (epoch !== source.authorityRevision || epoch !== recipient.scope.authorityRevision)
      return { unchanged: "stale" as const }
    for (const [scope, resource, action] of [
      [source, "board", "manage"],
      [source, "goal", "edit"],
      [recipient.scope, "board", "manage"]
    ] as const) {
      if (!(await validateBoardScope(scope, tx, { resource, action })).ok)
        return { unchanged: "unavailable" as const }
    }
    const { rows: goals } = await tx.execute(
      sql`SELECT id FROM goals WHERE id=${goalId} AND ${ownedPlanning(source, "goals")} AND ${planningVisible(source, "goals")} AND retired_at IS NULL`
    )
    if (!goals.length) return { unchanged: "unavailable" as const }
    const areaId = target.kind === "area" ? target.areaId : null
    const projectId = target.kind === "project" ? target.projectId : null
    if (areaId) {
      const { rows } = await tx.execute(
        sql`SELECT id FROM areas WHERE id=${areaId} AND ${ownedPlanning(recipient.scope, "areas")} AND ${planningVisible(recipient.scope, "areas")} AND retired_at IS NULL`
      )
      if (!rows.length) return { unchanged: "unavailable" as const }
    }
    if (projectId) {
      const { rows } = await tx.execute(
        sql`SELECT id FROM projects WHERE id=${projectId} AND ${ownedPlanning(recipient.scope, "projects")} AND ${planningVisible(recipient.scope, "projects")} AND retired_at IS NULL`
      )
      if (!rows.length) return { unchanged: "unavailable" as const }
    }
    const result = await tx.execute(
      enabled
        ? sql`INSERT OR IGNORE INTO board_goal_shares(goal_id,receiving_board_id,area_id,project_id) VALUES (${goalId},${target.boardId},${areaId},${projectId})`
        : sql`DELETE FROM board_goal_shares WHERE goal_id=${goalId} AND receiving_board_id=${target.boardId} AND area_id IS ${areaId} AND project_id IS ${projectId}`
    )
    return result.rowsAffected ? { next: "saved" as const } : { unchanged: "saved" as const }
  })
}
