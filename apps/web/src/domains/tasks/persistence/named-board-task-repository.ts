import { randomUUID } from "node:crypto"
import type { Client, Transaction } from "@libsql/client"
import { isClosedStatus, isDoneStatus, normalizeStatus, STATUS } from "../../../lib/status-config"
import { readBoardGrantRevision } from "./board-grant-fence"
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

/** Named ticket writes keep the Board grant, placement and task version in the same transaction. */
export class NamedBoardTaskRepository {
  constructor(private readonly db: Client, private readonly markerPath?: string) {}

  async create(actor: BoardActor, boardId: string, content: NamedTaskContent, placement: NamedTaskPlacement) {
    const id = randomUUID()
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
            WHERE planning.id = ? AND (planning.owner_board_id IS NULL OR EXISTS (
              SELECT 1 FROM board_access_grants AS grant JOIN task_boards AS target_board ON target_board.id = grant.board_id
              JOIN board_permissions AS policy ON policy.board_id = target_board.id
              WHERE grant.board_id = planning.owner_board_id AND target_board.state IN ('active', 'archived')
                AND grant.principal_type = ? AND grant.principal_id = ?
            ))`,
          args: [target, actor.kind, actor.id],
        })
        if (!rows.length) return unavailable
      }

      const { rows: [ticket] } = await tx.execute({
        sql: `UPDATE task_boards SET ticket_high_water = ticket_high_water + 1
          WHERE id = ? AND ticket_high_water < 9007199254740991
          RETURNING ticket_prefix || '-' || ticket_high_water AS key`,
        args: [boardId],
      })
      if (!ticket) return unavailable

      const now = Date.now()
      await tx.execute({
        sql: `INSERT INTO tasks (id, title, description, status, area_id, task_board_id,
          board_column_id, ticket_ref, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, '__meitheal_no_area__', ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, content.title, content.description, lane.status, boardId,
          lane.id, String(ticket.key), id, id, now, now],
      })
      if (areaId || projectId || goalId) {
        await tx.execute({
          sql: "INSERT INTO board_task_planning (task_id, area_id, project_id, goal_id) VALUES (?, ?, ?, ?)",
          args: [id, areaId ?? null, projectId ?? null, goalId ?? null],
        })
      }
      return { ok: true, value: { id, ticket: String(ticket.key), version: now } }
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
    const tx = await this.db.transaction("write")
    try {
      const access = await selectNamedBoardAccess(tx, actor, revision, boardId)
      if (!access) return unavailable
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
