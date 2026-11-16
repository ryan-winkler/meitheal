import { randomUUID } from "node:crypto"
import type { Client, Transaction } from "@libsql/client"
import { acquireWriteTransaction } from "../../../../scripts/database-client.mjs"
import { changeBoardGrants, readBoardGrantRevision } from "./board-grant-fence"
import { selectNamedBoardAccess, type BoardActor } from "./named-board-repository"

type PlanningAccess = NonNullable<Awaited<ReturnType<typeof selectNamedBoardAccess>>>
type ProjectStatus = "active" | "completed" | "archived"
type Change =
  | { action: "area"; title: string; id?: string }
  | { action: "goal"; title: string; description: string; areaId: string; id?: string }
  | { action: "project"; title: string; description: string; areaId: string; goalId: string | null }
  | { action: "project-edit"; id: string; title: string; description: string }
  | { action: "project-status"; id: string; status: ProjectStatus }
  | { action: "goal-share"; id: string; areaId: string; enabled: boolean }
  | { action: "routine"; title: string; description: string; areaId: string; cadence: "daily" | "weekly" }
  | { action: "pillar"; title: string; description: string; id?: string }

function readableBoards(userId: string) {
  return {
    sql: `SELECT board.id FROM task_boards AS board
      JOIN board_access_grants AS grant ON grant.board_id = board.id
      JOIN board_permissions AS permission ON permission.board_id = board.id
      WHERE grant.principal_type = 'ha_user' AND grant.principal_id = ?
        AND board.state IN ('active', 'archived')
      UNION ALL SELECT 'household'`,
    args: [userId],
  }
}

export function namedRoutinePeriod(cadence: string, now = new Date()) {
  const date = new Date(now)
  if (cadence === "weekly") date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7)
  return date.toISOString().slice(0, 10)
}

export async function readNamedBoardPlanning(tx: Transaction, actor: BoardActor, board: PlanningAccess) {
  if (actor.kind !== "ha_user") return null
  const { sql: readable, args } = readableBoards(actor.id)
  const [areas, projects, goals, pillars, destinations, linkable, shares, routines] = await tx.batch([
    {
      sql: `SELECT id, name FROM areas WHERE owner_board_id = ? ORDER BY position, name, id`,
      args: [board.id],
    },
    {
      sql: `WITH readable AS (${readable})
        SELECT project.id, project.title, project.description, project.status,
          (SELECT area.id FROM areas AS area
            WHERE area.id = project.area_id AND COALESCE(area.owner_board_id, 'household') IN (SELECT id FROM readable)) AS area_id
        FROM projects AS project WHERE project.owner_board_id = ? ORDER BY project.position, project.title, project.id`,
      args: [...args, board.id],
    },
    {
      sql: `WITH readable AS (${readable})
        SELECT goal.id, goal.title, goal.description,
          (SELECT area.id FROM areas AS area
            WHERE area.id = goal.area_id AND COALESCE(area.owner_board_id, 'household') IN (SELECT id FROM readable)) AS area_id
        FROM goals AS goal WHERE goal.owner_board_id = ? ORDER BY goal.title, goal.id`,
      args: [...args, board.id],
    },
    {
      sql: `SELECT id, name, manifesto FROM pillars WHERE owner_board_id = ? AND is_active = 1 ORDER BY position, id`,
      args: [board.id],
    },
    {
      sql: `WITH readable AS (${readable})
        SELECT area.id, area.name, board.name AS board_name
        FROM areas AS area JOIN task_boards AS board ON board.id = COALESCE(area.owner_board_id, 'household')
        WHERE ? = 'owner' AND board.id IN (SELECT id FROM readable)
        ORDER BY board.name COLLATE NOCASE, area.name COLLATE NOCASE, area.id`,
      args: [...args, board.role],
    },
    {
      sql: `WITH readable AS (${readable}), eligible_goals AS (
        SELECT goal.id, goal.title, NULL AS shared_area_id FROM goals AS goal
        WHERE COALESCE(goal.owner_board_id, 'household') IN (SELECT id FROM readable)
        UNION ALL
        SELECT goal.id, goal.title, area.id AS shared_area_id FROM board_goal_shares AS share
        JOIN goals AS goal ON goal.id = share.goal_id
        JOIN task_boards AS owner ON owner.id = COALESCE(goal.owner_board_id, 'household') AND owner.state IN ('active', 'archived')
        JOIN areas AS area ON area.id = share.area_id AND COALESCE(area.owner_board_id, 'household') = share.receiving_board_id
        WHERE area.owner_board_id = ? AND share.receiving_board_id IN (SELECT id FROM readable)
          AND owner.id NOT IN (SELECT id FROM readable)
        )
        SELECT id, title, shared_area_id FROM eligible_goals WHERE ? = 'owner' ORDER BY title COLLATE NOCASE, id`,
      args: [...args, board.id, board.role],
    },
    {
      sql: `WITH readable AS (${readable})
        SELECT share.goal_id, share.area_id,
          CASE WHEN share.receiving_board_id IN (SELECT id FROM readable) THEN area.name END AS area_name
        FROM board_goal_shares AS share JOIN goals AS goal ON goal.id = share.goal_id JOIN areas AS area ON area.id = share.area_id
        WHERE goal.owner_board_id = ? AND ? = 'owner' ORDER BY share.goal_id, share.area_id`,
      args: [...args, board.id, board.role],
    },
    {
      sql: `SELECT routine.id, routine.name, routine.cadence, json_extract(routine.template_json, '$.area_id') AS area_id,
          EXISTS (SELECT 1 FROM tasks AS completion WHERE completion.task_board_id = routine.owner_board_id
            AND completion.source_template_id = routine.id AND completion.status = 'complete'
            AND completion.due_date = CASE WHEN routine.cadence = 'weekly' THEN ? ELSE ? END) AS complete
        FROM task_templates AS routine WHERE routine.owner_board_id = ? AND routine.is_routine = 1
        ORDER BY routine.position, routine.name, routine.id`,
      args: [namedRoutinePeriod("weekly"), namedRoutinePeriod("daily"), board.id],
    },
  ])
  return {
    areas: areas!.rows.map(area => ({ id: String(area.id), name: String(area.name) })),
    projects: projects!.rows.map(project => ({
      id: String(project.id), title: String(project.title), description: String(project.description ?? ""),
      status: String(project.status), areaId: typeof project.area_id === "string" ? project.area_id : null,
    })),
    goals: goals!.rows.map(goal => ({
      id: String(goal.id), title: String(goal.title), description: String(goal.description ?? ""), areaId: typeof goal.area_id === "string" ? goal.area_id : null,
    })),
    pillars: pillars!.rows.map(pillar => ({ id: String(pillar.id), name: String(pillar.name), manifesto: String(pillar.manifesto ?? "") })),
    destinations: destinations!.rows.map(area => ({ id: String(area.id), name: String(area.name), board: String(area.board_name) })),
    linkableGoals: linkable!.rows.map(goal => ({
      id: String(goal.id), title: String(goal.title), sharedAreaId: typeof goal.shared_area_id === "string" ? goal.shared_area_id : null,
    })),
    routines: routines!.rows.map(routine => ({
      id: String(routine.id), name: String(routine.name), cadence: String(routine.cadence),
      areaId: String(routine.area_id), complete: routine.complete === 1,
    })),
    shares: shares!.rows.map(share => ({
      goalId: String(share.goal_id), areaId: String(share.area_id),
      areaName: typeof share.area_name === "string" ? share.area_name : null,
    })),
  }
}

export class NamedBoardPlanningRepository {
  constructor(private readonly db: Client, private readonly markerPath?: string) {}

  async save(ownerId: string, boardId: string, input: Change): Promise<boolean> {
    if (input.action === "goal-share") {
      const outcome = await changeBoardGrants(this.db, async (tx, revision) => {
        if (!revision || !await this.ownsActiveBoard(tx, ownerId, boardId, revision)) return { unchanged: false }
        return await this.apply(tx, ownerId, boardId, input) ? { next: true } : { unchanged: false }
      }, this.markerPath)
      return outcome.status !== "locked" && outcome.result
    }
    const revision = await readBoardGrantRevision(this.markerPath)
    if (!revision) return false
    const tx = await acquireWriteTransaction(this.db)
    try {
      if (!await this.ownsActiveBoard(tx, ownerId, boardId, revision)) return false
      if (!await this.apply(tx, ownerId, boardId, input)) return false
      if (await readBoardGrantRevision(this.markerPath) !== revision) return false
      await tx.commit()
      return true
    } finally {
      tx.close()
    }
  }

  private async ownsActiveBoard(tx: Transaction, ownerId: string, boardId: string, revision: string) {
    const board = await selectNamedBoardAccess(tx, { kind: "ha_user", id: ownerId }, revision, boardId)
    return board?.role === "owner" && board.state === "active"
  }

  private async apply(tx: Transaction, ownerId: string, boardId: string, input: Change) {
    const id = randomUUID()
    const now = Date.now()
    switch (input.action) {
      case "area": {
        const result = input.id ? await tx.execute({
          sql: "UPDATE areas SET name = ?, updated_at = ? WHERE id = ? AND owner_board_id = ?",
          args: [input.title, now, input.id, boardId],
        }) : await tx.execute({
          sql: "INSERT INTO areas (id, owner_board_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          args: [id, boardId, input.title, now, now],
        })
        return result.rowsAffected > 0
      }
      case "goal": {
        const result = input.id ? await tx.execute({
          sql: "UPDATE goals SET title = ?, description = ?, updated_at = ? WHERE id = ? AND owner_board_id = ? AND area_id = ?",
          args: [input.title, input.description, now, input.id, boardId, input.areaId],
        }) : await tx.execute({
          sql: `INSERT INTO goals (id, owner_board_id, title, description, area_id, created_at, updated_at)
            SELECT ?, ?, ?, ?, area.id, ?, ? FROM areas AS area WHERE area.id = ? AND area.owner_board_id = ?`,
          args: [id, boardId, input.title, input.description, now, now, input.areaId, boardId],
        })
        return result.rowsAffected > 0
      }
      case "project": {
        const readable = readableBoards(ownerId)
        const result = await tx.execute({
          sql: `WITH readable AS (${readable.sql})
            INSERT INTO projects (id, owner_board_id, title, description, area_id, goal_id, created_at, updated_at)
            SELECT ?, ?, ?, ?, area.id, ?, ?, ? FROM areas AS area
            WHERE area.id = ? AND area.owner_board_id = ? AND (? IS NULL OR EXISTS (
              SELECT 1 FROM goals AS goal
              JOIN task_boards AS owner ON owner.id = COALESCE(goal.owner_board_id, 'household') AND owner.state IN ('active', 'archived')
              WHERE goal.id = ? AND (owner.id IN (SELECT id FROM readable) OR EXISTS (
                SELECT 1 FROM board_goal_shares AS share
                WHERE share.goal_id = goal.id AND share.area_id = area.id AND share.receiving_board_id = area.owner_board_id
              ))
            ))`,
          args: [...readable.args, id, boardId, input.title, input.description, input.goalId, now, now,
            input.areaId, boardId, input.goalId, input.goalId],
        })
        return result.rowsAffected > 0
      }
      case "project-edit": {
        const result = await tx.execute({
          sql: "UPDATE projects SET title = ?, description = ?, updated_at = ? WHERE id = ? AND owner_board_id = ?",
          args: [input.title, input.description, now, input.id, boardId],
        })
        return result.rowsAffected > 0
      }
      case "project-status": {
        const result = await tx.execute({
          sql: "UPDATE projects SET status = ?, updated_at = ? WHERE id = ? AND owner_board_id = ?",
          args: [input.status, now, input.id, boardId],
        })
        return result.rowsAffected > 0
      }
      case "goal-share": {
        const readable = readableBoards(ownerId)
        const result = input.enabled ? await tx.execute({
          sql: `WITH readable AS (${readable.sql})
            INSERT OR IGNORE INTO board_goal_shares (goal_id, area_id, receiving_board_id)
            SELECT goal.id, area.id, COALESCE(area.owner_board_id, 'household')
            FROM goals AS goal CROSS JOIN areas AS area
            WHERE goal.id = ? AND goal.owner_board_id = ? AND area.id = ?
              AND COALESCE(area.owner_board_id, 'household') IN (SELECT id FROM readable)`,
          args: [...readable.args, input.id, boardId, input.areaId],
        }) : await tx.execute({
          sql: `DELETE FROM board_goal_shares WHERE goal_id = ? AND area_id = ?
            AND EXISTS (SELECT 1 FROM goals WHERE id = ? AND owner_board_id = ?)`,
          args: [input.id, input.areaId, input.id, boardId],
        })
        return result.rowsAffected > 0
      }
      case "routine": {
        const result = await tx.execute({
          sql: `INSERT INTO task_templates (id, owner_board_id, name, template_json, is_routine, cadence, created_at, updated_at)
            SELECT ?, ?, ?, ?, 1, ?, ?, ? FROM areas AS area WHERE area.id = ? AND area.owner_board_id = ?`,
          args: [id, boardId, input.title, JSON.stringify({
            title: input.title, description: input.description, area_id: input.areaId,
          }), input.cadence, now, now, input.areaId, boardId],
        })
        return result.rowsAffected > 0
      }
      case "pillar": {
        const result = input.id ? await tx.execute({
          sql: "UPDATE pillars SET name = ?, manifesto = ?, updated_at = ? WHERE id = ? AND owner_board_id = ?",
          args: [input.title, input.description, now, input.id, boardId],
        }) : await tx.execute({
          sql: "INSERT INTO pillars (id, slug, owner_board_id, name, manifesto, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: [id, "~" + id, boardId, input.title, input.description, now, now],
        })
        return result.rowsAffected > 0
      }
    }
  }
}
