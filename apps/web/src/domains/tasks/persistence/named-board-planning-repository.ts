import { isOrganizationFeatureAvailable as available } from "../../../lib/organization-request-context"
import { DEFAULT_GROUP_COLOR } from "../../../lib/board-workspace"
import { randomUUID } from "node:crypto"
import type { Client, Transaction } from "@libsql/client"
import { readBoardPillars, saveBoardPillarChange, type BoardPillarChange } from "../../pillars/named-board-pillar-service"
import { acquireWriteTransaction } from "../../../../scripts/database-client.mjs"
import { changeBoardGrants, readBoardGrantRevision } from "./board-grant-fence"
import { selectNamedBoardAccess, type BoardActor } from "./named-board-repository"

type PlanningAccess = NonNullable<Awaited<ReturnType<typeof selectNamedBoardAccess>>>
type ProjectStatus = "active" | "completed" | "archived"
type VisibilityChange =
  | { action: "goal-share"; id: string; areaId: string; enabled: boolean }
  | { action: "retire"; entity: "area" | "goal" | "project" | "routine"; id: string }

type Change = BoardPillarChange | VisibilityChange
  | { action: "area"; title: string; id?: string; icon?: string; color?: string }
  | { action: "goal"; title: string; description: string; areaId: string; id?: string }
  | { action: "project"; title: string; description: string; areaId: string; goalId: string | null }
  | { action: "project-edit"; id: string; title: string; description: string }
  | { action: "project-goal"; id: string; goalId: string | null }
  | { action: "project-status"; id: string; status: ProjectStatus }
  | { action: "routine"; title: string; description: string; areaId: string; cadence: "daily" | "weekly"; id?: string; projectId?: string | null }

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
  const [areas, projects, goals, destinations, linkable, shares, routines] = await tx.batch([
    {
      sql: `SELECT id, name, icon, color FROM areas WHERE owner_board_id = ? AND retired_at IS NULL ORDER BY position, name, id`,
      args: [board.id],
    },
    {
      sql: `WITH readable AS (${readable})
        SELECT project.id, project.title, project.description, project.status, project.goal_id,
          (SELECT area.id FROM areas AS area
            WHERE area.id = project.area_id AND area.retired_at IS NULL AND COALESCE(area.owner_board_id, 'household') IN (SELECT id FROM readable)) AS area_id
        FROM projects AS project WHERE project.owner_board_id = ? AND project.retired_at IS NULL ORDER BY project.position, project.title, project.id`,
      args: [...args, board.id],
    },
    {
      sql: `WITH readable AS (${readable})
        SELECT goal.id, goal.title, goal.description,
          (SELECT area.id FROM areas AS area
            WHERE area.id = goal.area_id AND area.retired_at IS NULL AND COALESCE(area.owner_board_id, 'household') IN (SELECT id FROM readable)) AS area_id
        FROM goals AS goal WHERE goal.owner_board_id = ? AND goal.retired_at IS NULL ORDER BY goal.title, goal.id`,
      args: [...args, board.id],
    },
    {
      sql: `WITH readable AS (${readable})
        SELECT area.id, area.name, board.name AS board_name
        FROM areas AS area JOIN task_boards AS board ON board.id = COALESCE(area.owner_board_id, 'household')
        WHERE area.retired_at IS NULL AND ? = 'owner' AND board.id IN (SELECT id FROM readable)
        ORDER BY board.name COLLATE NOCASE, area.name COLLATE NOCASE, area.id`,
      args: [...args, board.role],
    },
    {
      sql: `WITH readable AS (${readable}), eligible_goals AS (
        SELECT goal.id, goal.title, NULL AS shared_area_id FROM goals AS goal
        WHERE goal.retired_at IS NULL AND COALESCE(goal.owner_board_id, 'household') IN (SELECT id FROM readable)
        UNION ALL
        SELECT goal.id, goal.title, area.id AS shared_area_id FROM board_goal_shares AS share
        JOIN goals AS goal ON goal.id = share.goal_id
        JOIN task_boards AS owner ON owner.id = COALESCE(goal.owner_board_id, 'household') AND owner.state IN ('active', 'archived')
        JOIN areas AS area ON area.id = share.area_id AND COALESCE(area.owner_board_id, 'household') = share.receiving_board_id
        WHERE goal.retired_at IS NULL AND area.retired_at IS NULL AND area.owner_board_id = ? AND share.receiving_board_id IN (SELECT id FROM readable)
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
        WHERE goal.owner_board_id = ? AND goal.retired_at IS NULL AND ? = 'owner' ORDER BY share.goal_id, share.area_id`,
      args: [...args, board.id, board.role],
    },
    {
      sql: `SELECT routine.id, routine.name, routine.cadence, json_extract(routine.template_json, '$.area_id') AS area_id,
          json_extract(routine.template_json, '$.description') AS description,
          json_extract(routine.template_json, '$.project_id') AS project_id,
          EXISTS (SELECT 1 FROM tasks AS completion WHERE completion.task_board_id = routine.owner_board_id
            AND completion.source_template_id = routine.id AND completion.status = 'complete'
            AND completion.due_date = CASE WHEN routine.cadence = 'weekly' THEN ? ELSE ? END) AS complete
        FROM task_templates AS routine JOIN areas AS area ON area.id = json_extract(routine.template_json, '$.area_id')
        WHERE routine.owner_board_id = ? AND routine.is_routine = 1 AND routine.retired_at IS NULL
          AND area.owner_board_id = routine.owner_board_id AND area.retired_at IS NULL
        ORDER BY routine.position, routine.name, routine.id`,
      args: [namedRoutinePeriod("weekly"), namedRoutinePeriod("daily"), board.id],
    },
  ])
  const pillars = available("pillars") ? await readBoardPillars(tx, board.id) : []
  if (!available("principles")) for (const pillar of pillars) pillar.principles = []
  return {
    areas: areas!.rows.filter(() => available("groups")).map(area => ({ id: String(area.id), name: String(area.name), icon: String(area.icon), color: String(area.color) })),
    projects: projects!.rows.filter(() => available("projects")).map(project => ({
      id: String(project.id), title: String(project.title), description: String(project.description ?? ""),
      status: String(project.status), areaId: typeof project.area_id === "string" ? project.area_id : null,
      goalId: linkable!.rows.some(goal => goal.id === project.goal_id && (goal.shared_area_id === null || goal.shared_area_id === project.area_id))
        ? String(project.goal_id) : null,
    })),
    goals: goals!.rows.filter(() => available("goals")).map(goal => ({
      id: String(goal.id), title: String(goal.title), description: String(goal.description ?? ""), areaId: typeof goal.area_id === "string" ? goal.area_id : null,
    })),
    pillars,
    destinations: destinations!.rows.filter(() => available("groups")).map(area => ({ id: String(area.id), name: String(area.name), board: String(area.board_name) })),
    linkableGoals: linkable!.rows.filter(() => available("goals")).map(goal => ({
      id: String(goal.id), title: String(goal.title), sharedAreaId: typeof goal.shared_area_id === "string" ? goal.shared_area_id : null,
    })),
    routines: routines!.rows.filter(() => available("routines")).map(routine => ({
      id: String(routine.id), name: String(routine.name), cadence: String(routine.cadence),
      projectId: available("projects") && typeof routine.project_id === "string" ? routine.project_id : null,
      areaId: String(routine.area_id), complete: routine.complete === 1, description: String(routine.description ?? ""),
      period: namedRoutinePeriod(String(routine.cadence)),
    })),
    shares: shares!.rows.filter(() => available("goals")).map(share => ({
      goalId: String(share.goal_id), areaId: String(share.area_id),
      areaName: typeof share.area_name === "string" ? share.area_name : null,
    })),
  }
}

export class NamedBoardPlanningRepository {
  constructor(private readonly db: Client, private readonly markerPath?: string) {}

  async save(ownerId: string, boardId: string, input: Change): Promise<boolean> {
    if (((input.action === "project-goal" || input.action === "project" && input.goalId !== null) && !available("goals")) ||
      (input.action === "pillar-link" && input.entityType === "goal" && !available("goals")) ||
      (input.action === "pillar-link" && input.entityType === "routine" && !available("routines"))) return false
    if (input.action === "goal-share" || input.action === "retire") {
      const outcome = await this.saveVisibility(ownerId, boardId, input)
      return outcome.status !== "locked" && outcome.result === "saved"
    }
    const feature = input.action === "area" ? "groups"
      : input.action.startsWith("project") ? "projects"
      : input.action.startsWith("goal") ? "goals"
      : input.action.startsWith("routine") ? "routines"
      : input.action === "pillar-principle" ? "principles" : "pillars"
    if (!available(feature)) return false
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

  async saveVisibility(ownerId: string, boardId: string, input: VisibilityChange) {
    return changeBoardGrants<"saved" | "unavailable" | "children">(this.db, async (tx, revision) => {
      if (!revision || !await this.ownsActiveBoard(tx, ownerId, boardId, revision)) return { unchanged: "unavailable" }
      const effect = input.action === "goal-share"
        ? await this.setGoalShare(tx, ownerId, boardId, input)
        : await this.retire(tx, boardId, input)
      if (effect === "changed") return { next: "saved" }
      return { unchanged: effect === "unchanged" ? "saved" : effect }
    }, this.markerPath)
  }

  private async retire(tx: Transaction, boardId: string, input: Extract<VisibilityChange, { action: "retire" }>) {
    if (input.entity === "area") {
      const { rows } = await tx.execute({
        sql: `SELECT 1 FROM areas AS area WHERE area.id = ? AND area.owner_board_id = ? AND area.retired_at IS NULL AND (
          EXISTS (SELECT 1 FROM projects WHERE area_id = area.id AND owner_board_id = area.owner_board_id AND retired_at IS NULL)
          OR EXISTS (SELECT 1 FROM goals WHERE area_id = area.id AND owner_board_id = area.owner_board_id AND retired_at IS NULL)
          OR EXISTS (SELECT 1 FROM task_templates WHERE owner_board_id = area.owner_board_id AND retired_at IS NULL
            AND is_routine = 1 AND json_extract(CASE WHEN json_valid(template_json) THEN template_json END, '$.area_id') = area.id)
        )`,
        args: [input.id, boardId],
      })
      if (rows.length) return "children"
    }
    const table = { area: "areas", goal: "goals", project: "projects", routine: "task_templates" }[input.entity]
    const now = Date.now()
    const result = await tx.execute({
      sql: `UPDATE ${table} SET retired_at = ?, updated_at = ?
        WHERE id = ? AND owner_board_id = ? AND retired_at IS NULL`,
      args: [now, now, input.id, boardId],
    })
    if (result.rowsAffected) return "changed"
    const { rows } = await tx.execute({
      sql: `SELECT 1 FROM ${table} WHERE id = ? AND owner_board_id = ? AND retired_at IS NOT NULL`,
      args: [input.id, boardId],
    })
    return rows.length ? "unchanged" : "unavailable"
  }

  private async setGoalShare(tx: Transaction, ownerId: string, boardId: string, input: Extract<VisibilityChange, { action: "goal-share" }>) {
    const { rows: [goal] } = await tx.execute({
      sql: "SELECT id FROM goals WHERE id = ? AND owner_board_id = ? AND retired_at IS NULL",
      args: [input.id, boardId],
    })
    if (!goal) return "unavailable"
    if (!input.enabled) {
      const result = await tx.execute({
        sql: "DELETE FROM board_goal_shares WHERE goal_id = ? AND area_id = ?",
        args: [input.id, input.areaId],
      })
      return result.rowsAffected ? "changed" : "unchanged"
    }
    const readable = readableBoards(ownerId)
    const { rows: [target] } = await tx.execute({
      sql: `WITH readable AS (${readable.sql}) SELECT COALESCE(area.owner_board_id, 'household') AS board_id
        FROM areas AS area WHERE area.id = ? AND area.retired_at IS NULL
          AND COALESCE(area.owner_board_id, 'household') IN (SELECT id FROM readable)`,
      args: [...readable.args, input.areaId],
    })
    if (!target) return "unavailable"
    const result = await tx.execute({
      sql: "INSERT OR IGNORE INTO board_goal_shares (goal_id, area_id, receiving_board_id) VALUES (?, ?, ?)",
      args: [input.id, input.areaId, String(target.board_id)],
    })
    return result.rowsAffected ? "changed" : "unchanged"
  }

  private async canLinkGoal(tx: Transaction, ownerId: string, goalId: string | null, areaId: string) {
    if (!goalId) return true
    const readable = readableBoards(ownerId)
    const { rows } = await tx.execute({
      sql: `WITH readable AS (${readable.sql})
        SELECT 1 FROM goals AS goal
        JOIN task_boards AS owner ON owner.id = COALESCE(goal.owner_board_id, 'household') AND owner.state IN ('active', 'archived')
        WHERE goal.id = ? AND goal.retired_at IS NULL AND (owner.id IN (SELECT id FROM readable) OR EXISTS (
          SELECT 1 FROM board_goal_shares AS share
          JOIN areas AS area ON area.id = share.area_id AND area.retired_at IS NULL
          WHERE share.goal_id = goal.id AND share.area_id = ? AND share.receiving_board_id = area.owner_board_id
        ))`,
      args: [...readable.args, goalId, areaId],
    })
    return rows.length > 0
  }

  private async ownsActiveBoard(tx: Transaction, ownerId: string, boardId: string, revision: string) {
    const board = await selectNamedBoardAccess(tx, { kind: "ha_user", id: ownerId }, revision, boardId)
    return board?.role === "owner" && board.state === "active"
  }

  private async apply(tx: Transaction, ownerId: string, boardId: string, input: Exclude<Change, VisibilityChange>) {
    const id = randomUUID()
    const now = Date.now()
    switch (input.action) {
      case "area": {
        const result = input.id ? await tx.execute({
          sql: "UPDATE areas SET name = ?, icon = COALESCE(?, icon), color = COALESCE(?, color), updated_at = ? WHERE id = ? AND owner_board_id = ? AND retired_at IS NULL",
          args: [input.title, input.icon ?? null, input.color ?? null, now, input.id, boardId],
        }) : await tx.execute({
          sql: "INSERT INTO areas (id, owner_board_id, name, icon, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: [id, boardId, input.title, input.icon ?? "📁", input.color ?? DEFAULT_GROUP_COLOR, now, now],
        })
        return result.rowsAffected > 0
      }
      case "goal": {
        const result = input.id ? await tx.execute({
          sql: "UPDATE goals SET title = ?, description = ?, updated_at = ? WHERE id = ? AND owner_board_id = ? AND retired_at IS NULL AND area_id = ?",
          args: [input.title, input.description, now, input.id, boardId, input.areaId],
        }) : await tx.execute({
          sql: `INSERT INTO goals (id, owner_board_id, title, description, area_id, created_at, updated_at)
            SELECT ?, ?, ?, ?, area.id, ?, ? FROM areas AS area WHERE area.id = ? AND area.owner_board_id = ? AND area.retired_at IS NULL`,
          args: [id, boardId, input.title, input.description, now, now, input.areaId, boardId],
        })
        return result.rowsAffected > 0
      }
      case "project": {
        if (!await this.canLinkGoal(tx, ownerId, input.goalId, input.areaId)) return false
        const result = await tx.execute({
          sql: `INSERT INTO projects (id, owner_board_id, title, description, area_id, goal_id, created_at, updated_at)
            SELECT ?, ?, ?, ?, area.id, ?, ?, ? FROM areas AS area
            WHERE area.id = ? AND area.owner_board_id = ? AND area.retired_at IS NULL`,
          args: [id, boardId, input.title, input.description, input.goalId, now, now, input.areaId, boardId],
        })
        return result.rowsAffected > 0
      }
      case "project-goal": {
        const { rows: [project] } = await tx.execute({
          sql: "SELECT area_id FROM projects WHERE id = ? AND owner_board_id = ? AND retired_at IS NULL",
          args: [input.id, boardId],
        })
        if (!project || !await this.canLinkGoal(tx, ownerId, input.goalId, String(project.area_id ?? ""))) return false
        const result = await tx.execute({
          sql: "UPDATE projects SET goal_id = ?, updated_at = ? WHERE id = ? AND owner_board_id = ?",
          args: [input.goalId, now, input.id, boardId],
        })
        return result.rowsAffected > 0
      }
      case "project-edit": {
        const result = await tx.execute({
          sql: "UPDATE projects SET title = ?, description = ?, updated_at = ? WHERE id = ? AND owner_board_id = ? AND retired_at IS NULL",
          args: [input.title, input.description, now, input.id, boardId],
        })
        return result.rowsAffected > 0
      }
      case "project-status": {
        const result = await tx.execute({
          sql: "UPDATE projects SET status = ?, updated_at = ? WHERE id = ? AND owner_board_id = ? AND retired_at IS NULL",
          args: [input.status, now, input.id, boardId],
        })
        return result.rowsAffected > 0
      }
      case "routine": {
        let projectId = input.projectId ?? null
        if (input.id && input.projectId === undefined) {
          const { rows: [previous] } = await tx.execute({
            sql: "SELECT json_extract(template_json, '$.project_id') AS project_id FROM task_templates WHERE id = ? AND owner_board_id = ? AND is_routine = 1 AND retired_at IS NULL",
            args: [input.id, boardId],
          })
          if (!previous) return false
          projectId = typeof previous.project_id === "string" ? previous.project_id : null
        }
        if (projectId) {
          if (!available("projects")) return false
          const { rows: [project] } = await tx.execute({
            sql: "SELECT id FROM projects WHERE id = ? AND owner_board_id = ? AND area_id = ? AND status = 'active' AND retired_at IS NULL",
            args: [projectId, boardId, input.areaId],
          })
          if (!project) return false
        }
        const template = JSON.stringify({ title: input.title, description: input.description, area_id: input.areaId, project_id: projectId })
        const result = input.id ? await tx.execute({
          sql: `UPDATE task_templates SET name = ?, template_json = ?, updated_at = ?
            WHERE id = ? AND owner_board_id = ? AND is_routine = 1 AND retired_at IS NULL
              AND json_extract(template_json, '$.area_id') = ?`,
          args: [input.title, template, now, input.id, boardId, input.areaId],
        }) : await tx.execute({
          sql: `INSERT INTO task_templates (id, owner_board_id, name, template_json, is_routine, cadence, created_at, updated_at)
            SELECT ?, ?, ?, ?, 1, ?, ?, ? FROM areas AS area WHERE area.id = ? AND area.owner_board_id = ? AND area.retired_at IS NULL`,
          args: [id, boardId, input.title, template, input.cadence, now, now, input.areaId, boardId],
        })
        return result.rowsAffected > 0
      }
      case "pillar":
      case "pillar-principle":
      case "pillar-link":
        return saveBoardPillarChange(tx, boardId, input)

    }
  }
}
