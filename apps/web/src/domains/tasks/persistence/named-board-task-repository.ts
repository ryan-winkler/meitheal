import { randomUUID } from "node:crypto"
import type { Client, Transaction } from "@libsql/client"
import { isActiveAgentToken } from "@domains/auth"
import { acquireWriteTransaction } from "../../../../scripts/database-client.mjs"
import { isClosedStatus, isDoneStatus, normalizeStatus, STATUS } from "../../../lib/status-config"
import { boardGrantStillCurrent, currentBoardGrantRevision, readBoardGrantRevision } from "./board-grant-fence"
import { namedRoutinePeriod, readNamedBoardPlanning } from "./named-board-planning-repository"
import { permitsBoardTaskAction, selectNamedBoardAccess, type BoardActor, type TaskBoardAction } from "./named-board-repository"
import { canAdvanceTaskTimestampMs, nextTaskTimestampMs, taskTimestampMs } from "./task-timestamp"

type Outcome<T> = { ok: true; value: T } | { ok: false; errorCode: "unavailable" | "denied" | "stale" }
type NamedTaskContent = { title: string; description: string }
type NamedTaskPlacement = {
  laneId?: string
  areaId?: string
  projectId?: string
  goalId?: string
}

const unavailable = { ok: false, errorCode: "unavailable" } as const
const denied = { ok: false, errorCode: "denied" } as const
const stale = { ok: false, errorCode: "stale" } as const

/** The caller authorizes the effect and establishes its lane in the current writer transaction. */
export async function insertNamedTask(tx: Transaction, input: {
  boardId: string
  laneId: string
  status: string
  content: NamedTaskContent
  assignedTo?: string
  routine?: { templateId: string; period: string }
}) {
  const { rows: [ticket] } = await tx.execute({
    sql: `UPDATE task_boards SET ticket_high_water = ticket_high_water + 1
      WHERE id = ? AND ticket_high_water < 9007199254740991
      RETURNING ticket_prefix || '-' || ticket_high_water AS key`,
    args: [input.boardId],
  })
  if (!ticket) return null

  const id = randomUUID()
  const now = Date.now()
  await tx.execute({
    sql: `INSERT INTO tasks (id, title, description, status, area_id, task_board_id, assigned_to,
      board_column_id, ticket_ref, idempotency_key, request_id, created_at, updated_at, source_template_id, due_date, task_kind)
      VALUES (?, ?, ?, ?, '__meitheal_no_area__', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, input.content.title, input.content.description, input.status, input.boardId,
      input.assignedTo ?? null, input.laneId, String(ticket.key), id, id, now, now,
      input.routine?.templateId ?? null, input.routine?.period ?? null, input.routine ? "routine_instance" : "standard_action"],
  })
  return { id, ticket: String(ticket.key), version: now }
}

/** Named ticket writes keep the Board grant, placement and task version in the same transaction. */
export class NamedBoardTaskRepository {
  constructor(private readonly db: Client, private readonly markerPath?: string) {}

  async view(actor: BoardActor, boardId: string, offset = 0) {
    const revision = await currentBoardGrantRevision(this.db, this.markerPath)
    if (!revision) return null
    const tx = await this.db.transaction("read")
    try {
      const access = await selectNamedBoardAccess(tx, actor, revision, boardId)
      if (!access || (actor.kind === "agent" && !await isActiveAgentToken(tx, actor.id, "tasks:read"))) return null
      const [lanes, tasks, members, intakes, agents] = await tx.batch([
        {
          sql: "SELECT id, label, key FROM kanban_lanes WHERE board_id = ? ORDER BY position, id",
          args: [boardId],
        },
        {
          sql: `SELECT id, title, description, status, ticket_ref, board_column_id AS lane_id,
              assigned_to, source_template_id IS NOT NULL AS routine, ${taskTimestampMs("updated_at")} AS version
            FROM tasks WHERE task_board_id = ?
            ORDER BY created_at DESC, id DESC LIMIT 51 OFFSET ?`,
          args: [boardId, offset],
        },
        {
          sql: `SELECT principal_id, role, deny_completion, deny_deletion
            FROM board_access_grants WHERE board_id = ? AND principal_type = 'ha_user' AND ? = 'owner'
            ORDER BY principal_id`,
          args: [boardId, access.role],
        },
        {
          sql: "SELECT id, label, enabled FROM board_intakes WHERE board_id = ? AND ? = 'owner' ORDER BY label COLLATE NOCASE, id",
          args: [boardId, access.role],
        },
        {
          sql: `SELECT principal_id FROM board_access_grants
            WHERE board_id = ? AND principal_type = 'agent' AND ? = 'owner' ORDER BY principal_id`,
          args: [boardId, access.role],
        },
      ])
      const planning = await readNamedBoardPlanning(tx, actor, access)
      if (!await boardGrantStillCurrent(this.db, revision, this.markerPath)) return null
      return {
        board: access,
        planning,
        lanes: lanes!.rows.map(lane => ({ id: String(lane.id), label: String(lane.label), key: String(lane.key) })),
        tasks: tasks!.rows.slice(0, 50).map(task => ({
          id: String(task.id), title: String(task.title), description: String(task.description ?? ""),
          status: String(task.status), ticket: String(task.ticket_ref), laneId: String(task.lane_id),
          assignedTo: typeof task.assigned_to === "string" ? task.assigned_to : null,
          routine: task.routine === 1, version: Number(task.version),
        })),
        nextOffset: tasks!.rows.length > 50 ? offset + 50 : null,
        agents: agents!.rows.map(agent => String(agent.principal_id)),
        intakes: intakes!.rows.map(intake => ({
          id: String(intake.id), label: String(intake.label), enabled: intake.enabled === 1,
        })),
        members: members!.rows.map(member => ({
          id: String(member.principal_id), role: String(member.role),
          denyCompletion: member.deny_completion === 1, denyDeletion: member.deny_deletion === 1,
        })),
      }
    } finally {
      tx.close()
    }
  }

  async create(actor: BoardActor, boardId: string, content: NamedTaskContent, placement: NamedTaskPlacement) {
    return this.mutate(actor, boardId, "create", async (tx, allows) => {
      const lane = await this.readLane(tx, boardId, placement.laneId)
      if (!lane) return unavailable
      if (isDoneStatus(lane.status) && !allows("complete")) return denied

      const { areaId, projectId, goalId } = placement
      const scopes = [["areas", areaId], ["projects", projectId], ["goals", goalId]] as const
      for (const [table, target] of scopes) {
        if (!target) continue
        const { rows } = await tx.execute({
          sql: `SELECT 1 FROM ${table} AS planning
            WHERE planning.id = ? AND planning.retired_at IS NULL AND (planning.owner_board_id IS NULL OR EXISTS (
              SELECT 1 FROM board_access_grants AS grant JOIN task_boards AS target_board ON target_board.id = grant.board_id
              JOIN board_permissions AS policy ON policy.board_id = target_board.id
              WHERE grant.board_id = planning.owner_board_id AND target_board.state IN ('active', 'archived')
                AND grant.principal_type = ? AND grant.principal_id = ?
            ))`,
          args: [target, actor.kind, actor.id],
        })
        if (!rows.length) return unavailable
      }

      const task = await insertNamedTask(tx, { boardId, laneId: lane.id, content, status: lane.status })
      if (!task) return unavailable
      if (areaId || projectId || goalId) {
        await tx.execute({
          sql: "INSERT INTO board_task_planning (task_id, area_id, project_id, goal_id) VALUES (?, ?, ?, ?)",
          args: [task.id, areaId ?? null, projectId ?? null, goalId ?? null],
        })
      }
      return { ok: true, value: task }
    })
  }

  async completeRoutine(actor: BoardActor, boardId: string, routineId: string, requestedPeriod?: string) {
    return this.mutate(actor, boardId, "complete", async (tx, allows) => {
      if (!allows("create")) return denied
      const { rows: [routine] } = await tx.execute({
        sql: `SELECT routine.name, routine.cadence, area.id AS area_id,
            json_extract(routine.template_json, '$.description') AS description,
            (SELECT id FROM kanban_lanes WHERE board_id = ? AND key = 'complete' LIMIT 1) AS lane_id
          FROM task_templates AS routine
          JOIN areas AS area ON json_extract(routine.template_json, '$.area_id') = area.id
            AND area.owner_board_id = routine.owner_board_id AND area.retired_at IS NULL
          WHERE routine.id = ? AND routine.owner_board_id = ? AND routine.is_routine = 1 AND routine.retired_at IS NULL`,
        args: [boardId, routineId, boardId],
      })
      if (!routine || typeof routine.lane_id !== "string") return unavailable
      const period = namedRoutinePeriod(String(routine.cadence))
      if (requestedPeriod !== undefined && requestedPeriod !== period) return stale
      const { rows: [existing] } = await tx.execute({
        sql: `SELECT id, status FROM tasks WHERE task_board_id = ? AND source_template_id = ? AND due_date = ? LIMIT 1`,
        args: [boardId, routineId, period],
      })
      if (existing) {
        if (existing.status !== STATUS.COMPLETE) return stale
        return { ok: true, value: { id: String(existing.id) } }
      }
      const task = await insertNamedTask(tx, {
        boardId, laneId: routine.lane_id, status: STATUS.COMPLETE,
        content: { title: String(routine.name), description: String(routine.description ?? "") },
        routine: { templateId: routineId, period },
      })
      if (!task) return unavailable
      await tx.execute({
        sql: "INSERT INTO board_task_planning (task_id, area_id) VALUES (?, ?)",
        args: [task.id, String(routine.area_id)],
      })
      return { ok: true, value: { id: task.id } }
    })
  }

  async edit(actor: BoardActor, boardId: string, id: string, version: number, content: NamedTaskContent) {
    return this.mutate(actor, boardId, "edit", async tx => {
      const { rows: [updated] } = await tx.execute({
        sql: `UPDATE tasks SET title = ?, description = ?, updated_at = ${nextTaskTimestampMs("updated_at")}
          WHERE id = ? AND task_board_id = ? AND ${taskTimestampMs("updated_at")} = ?
            AND (${canAdvanceTaskTimestampMs("updated_at")})
          RETURNING updated_at AS version`,
        args: [content.title, content.description, Date.now(), id, boardId, version],
      })
      return updated ? { ok: true, value: { version: Number(updated.version) } } : stale
    })
  }

  async move(actor: BoardActor, boardId: string, id: string, laneId: string, version: number) {
    return this.mutate(actor, boardId, "move", async (tx, allows) => {
      const { rows: [current] } = await tx.execute({
        sql: `SELECT status, board_column_id, ${taskTimestampMs("updated_at")} AS version
          FROM tasks WHERE id = ? AND task_board_id = ?`,
        args: [id, boardId],
      })
      if (!current) return unavailable
      const lane = await this.readLane(tx, boardId, laneId)
      if (!lane) return unavailable
      const previousStatus = String(current.status)
      const wasDone = isDoneStatus(previousStatus)
      if (!wasDone && isClosedStatus(previousStatus) && !allows("restore")) return denied
      const becomesDone = isDoneStatus(lane.status)
      if (wasDone !== becomesDone && !allows(becomesDone ? "complete" : "reopen")) return denied
      if (current.version !== version) return stale
      if (lane.id === current.board_column_id) return { ok: true, value: { version } }

      const { rows: [updated] } = await tx.execute({
        sql: `UPDATE tasks SET status = ?, board_column_id = ?, kanban_position = NULL,
            updated_at = ${nextTaskTimestampMs("updated_at")}
          WHERE id = ? AND task_board_id = ? AND (${canAdvanceTaskTimestampMs("updated_at")})
          RETURNING updated_at AS version`,
        args: [lane.status, lane.id, Date.now(), id, boardId],
      })
      return updated ? { ok: true, value: { version: Number(updated.version) } } : stale
    })
  }

  async delete(actor: BoardActor, boardId: string, id: string, version: number) {
    return this.mutate(actor, boardId, "delete", async tx => {
      const { rows: [task] } = await tx.execute({
        sql: "SELECT source_template_id FROM tasks WHERE id = ? AND task_board_id = ?",
        args: [id, boardId],
      })
      if (task?.source_template_id != null) return denied
      const { rows } = await tx.execute({
        sql: `DELETE FROM tasks WHERE id = ? AND task_board_id = ? AND ${taskTimestampMs("updated_at")} = ?
          AND NOT EXISTS (SELECT 1 FROM tasks AS child WHERE child.parent_id = tasks.id)
          RETURNING id`,
        args: [id, boardId, version],
      })
      return rows.length ? { ok: true, value: true } : stale
    })
  }

  private async mutate<T>(actor: BoardActor, boardId: string, action: TaskBoardAction,
    operation: (tx: Transaction, allows: (effect: TaskBoardAction) => boolean) => Promise<Outcome<T>>): Promise<Outcome<T>> {
    const revision = await readBoardGrantRevision(this.markerPath)
    if (!revision) return unavailable
    const tx = await acquireWriteTransaction(this.db)
    try {
      const access = await selectNamedBoardAccess(tx, actor, revision, boardId)
      if (!access || (actor.kind === "agent" &&
        !await isActiveAgentToken(tx, actor.id, action === "delete" ? "tasks:delete" : "tasks:write"))) return unavailable
      const allows = (effect: TaskBoardAction) => permitsBoardTaskAction(access, effect)
      if (!allows(action)) return denied
      const result = await operation(tx, allows)
      if (result.ok) {
        if (await readBoardGrantRevision(this.markerPath) !== revision) return unavailable
        await tx.commit()
      }
      return result
    } finally {
      tx.close()
    }
  }

  private async readLane(tx: Transaction, boardId: string, laneId: string | undefined) {
    const { rows: [row] } = await tx.execute({
      sql: `SELECT id, key FROM kanban_lanes WHERE board_id = ? AND (? IS NULL OR id = ?)
        ORDER BY position, id LIMIT 1`,
      args: [boardId, laneId ?? null, laneId ?? null],
    })
    if (!row || typeof row.id !== "string" || typeof row.key !== "string") return null
    const status = normalizeStatus(row.key)
    if (status !== STATUS.PENDING && status !== STATUS.ACTIVE && status !== STATUS.COMPLETE && status !== STATUS.BACKLOG) return null
    return { id: row.id, status }
  }
}
