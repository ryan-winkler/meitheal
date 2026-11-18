import { isOrganizationFeatureAvailable as available } from "../../../lib/organization-request-context"
import { namedKanbanPages } from "../../../lib/named-board-kanban-data"
import { randomUUID } from "node:crypto"
import type { Client, Transaction } from "@libsql/client"
import { isActiveAgentToken } from "@domains/auth"
import { acquireWriteTransaction } from "../../../../scripts/database-client.mjs"
import type { HomeAssistantAreaFilter, HomeAssistantAreaSelection } from "../../../lib/home-assistant-area-access"
import type { BoardWorkspaceSelection } from "../../../lib/board-workspace"
import { isClosedStatus, isDoneStatus, normalizeStatus, STATUS, STATUS_CONFIG } from "../../../lib/status-config"
import { boardGrantStillCurrent, currentBoardGrantRevision, readBoardGrantRevision } from "./board-grant-fence"
import { homeAssistantTaskAreaCondition, editTaskHomeAssistantArea, findTaskHomeAssistantArea, readHomeAssistantAreaPolicyRevision, setTaskHomeAssistantArea } from "./home-assistant-task-area"
import { namedRoutinePeriod, readNamedBoardPlanning } from "./named-board-planning-repository"
import { permitsBoardTaskAction, selectNamedBoardAccess, type BoardActor, type TaskBoardAction } from "./named-board-repository"
import { canAdvanceTaskTimestampMs, nextTaskTimestampMs, taskTimestampMs } from "./task-timestamp"

type Outcome<T> = { ok: true; value: T } | { ok: false; errorCode: "unavailable" | "denied" | "stale"; reason?: "routine-date" }
type NamedTaskContent = { title: string; description: string; dueDate?: string | null }
type NamedTaskPlacement = {
  laneId?: string
  areaId?: string
  projectId?: string
  goalId?: string
  local?: boolean
  homeAssistantArea?: HomeAssistantAreaSelection
}

const scopedTaskJoin = `LEFT JOIN board_task_planning AS placement ON placement.task_id = tasks.id
  LEFT JOIN projects AS project ON project.id = placement.project_id
    AND project.owner_board_id = tasks.task_board_id AND project.retired_at IS NULL`

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
      input.routine?.templateId ?? null, input.routine?.period ?? input.content.dueDate ?? null, input.routine ? "routine_instance" : "standard_action"],
  })
  return { id, ticket: String(ticket.key), version: now }
}

/** Named ticket writes keep the Board grant, placement and task version in the same transaction. */
export class NamedBoardTaskRepository {
  constructor(private readonly db: Client, private readonly markerPath?: string) {}

  async routineLibrary(actor: BoardActor) {
    if (actor.kind !== "ha_user" || !available("routines")) return []
    const revision = await currentBoardGrantRevision(this.db, this.markerPath)
    if (!revision) return []
    const now = new Date()
    const { rows } = await this.db.execute({
      sql: `SELECT routine.id, routine.name, routine.cadence,
          board.id AS board_id, board.name AS board_name,
          CASE WHEN routine.cadence = 'weekly' THEN ? ELSE ? END AS period,
          EXISTS (SELECT 1 FROM tasks AS occurrence WHERE occurrence.task_board_id = board.id
            AND occurrence.source_template_id = routine.id AND occurrence.status = 'complete'
            AND occurrence.due_date = CASE WHEN routine.cadence = 'weekly' THEN ? ELSE ? END) AS complete,
          (access.role IN ('owner', 'member') AND access.deny_completion = 0
            AND permissions.deny_completion = 0 AND (project.id IS NULL OR project.status = 'active')) AS can_complete
        FROM task_templates AS routine
        JOIN task_boards AS board ON board.id = routine.owner_board_id AND board.state = 'active'
        JOIN board_access_grants AS access ON access.board_id = board.id
          AND access.principal_type = 'ha_user' AND access.principal_id = ?
        JOIN board_permissions AS permissions ON permissions.board_id = board.id
        JOIN areas AS area ON area.id = json_extract(routine.template_json, '$.area_id')
          AND area.owner_board_id = board.id AND area.retired_at IS NULL
        LEFT JOIN projects AS project ON project.id = json_extract(routine.template_json, '$.project_id')
          AND project.owner_board_id = board.id AND project.area_id = area.id AND project.retired_at IS NULL
        WHERE routine.is_routine = 1 AND routine.retired_at IS NULL AND board.id <> 'household'
          AND (json_extract(routine.template_json, '$.project_id') IS NULL OR project.id IS NOT NULL)
          AND EXISTS (SELECT 1 FROM board_access_epoch WHERE singleton = 1 AND revision = ?)
        ORDER BY board.name COLLATE NOCASE, routine.position, routine.name, routine.id LIMIT 101`,
      args: [namedRoutinePeriod("weekly", now), namedRoutinePeriod("daily", now),
        namedRoutinePeriod("weekly", now), namedRoutinePeriod("daily", now), actor.id, revision],
    })
    if (!await boardGrantStillCurrent(this.db, revision, this.markerPath)) return []
    return rows.map(row => ({
      id: String(row.id), name: String(row.name), cadence: String(row.cadence), period: String(row.period),
      boardId: String(row.board_id), boardName: String(row.board_name),
      complete: row.complete === 1, canComplete: row.can_complete === 1,
    }))
  }

  async dueWork(actor: BoardActor, day: string) {
    if (actor.kind !== "ha_user") return []
    const revision = await currentBoardGrantRevision(this.db, this.markerPath)
    if (!revision) return []
    const { rows } = await this.db.execute({
      sql: `SELECT task.id, task.title, task.due_date, board.id AS board_id, board.name AS board_name
        FROM board_access_grants AS grant_row
        JOIN task_boards AS board ON board.id = grant_row.board_id
        JOIN board_permissions AS permissions ON permissions.board_id = board.id
        JOIN tasks AS task ON task.task_board_id = board.id
        WHERE grant_row.principal_type = 'ha_user' AND grant_row.principal_id = ?
          AND board.id <> 'household' AND board.state = 'active'
          AND task.due_date > '' AND task.due_date <= ? AND task.deferred_at IS NULL
          AND task.status NOT IN ('complete', 'archived')
          AND EXISTS (SELECT 1 FROM board_access_epoch WHERE singleton = 1 AND revision = ?)
        ORDER BY task.due_date, task.id LIMIT 31`,
      args: [actor.id, day, revision],
    })
    if (!await boardGrantStillCurrent(this.db, revision, this.markerPath)) return []
    return rows.map(row => ({
      id: String(row.id), title: String(row.title), dueDate: String(row.due_date),
      boardId: String(row.board_id), boardName: String(row.board_name),
    }))
  }

  async view(actor: BoardActor, boardId: string, offset = 0, selection?: BoardWorkspaceSelection, location?: HomeAssistantAreaFilter, kanban?: { params: URLSearchParams; timezone?: string }) {
    const revision = await currentBoardGrantRevision(this.db, this.markerPath)
    if (!revision) return null
    const tx = await this.db.transaction("read")
    try {
      const access = await selectNamedBoardAccess(tx, actor, revision, boardId)
      if (!access || (actor.kind === "agent" && !await isActiveAgentToken(tx, actor.id, "tasks:read"))) return null
      const context = selection ? await this.readWorkspaceContext(tx, boardId, selection) : undefined
      if (context === null) return null
      const taskFilter = selection?.ticketId ? "AND tasks.id = ?"
        : context?.project ? "AND project.id = ?"
        : context?.area ? "AND CASE WHEN project.id IS NOT NULL THEN project.area_id ELSE placement.area_id END = ?"
        : ""
      const locationFilter = location && !selection?.ticketId ? homeAssistantTaskAreaCondition(location) : null
      const filterId = selection?.ticketId ?? context?.project?.id ?? context?.area?.id
      const kanbanLanes = kanban ? await tx.execute({
        sql: "SELECT id, key FROM kanban_lanes WHERE board_id = ? ORDER BY position, id", args: [boardId],
      }) : null
      const index = kanban ? await tx.execute({
        sql: `SELECT tasks.id, tasks.title, tasks.status, tasks.board_column_id, tasks.assigned_to,
            tasks.due_date, tasks.task_kind, tasks.source_template_id,
            ${kanban.params.get("search") ? "lower(tasks.title || ' ' || COALESCE(tasks.description, ''))" : "lower(tasks.title)"} AS search,
            CASE WHEN project.id IS NOT NULL THEN project.area_id ELSE placement.area_id END AS area_id
          FROM tasks ${scopedTaskJoin}
          WHERE tasks.task_board_id = ? ${taskFilter} ${locationFilter ? "AND " + locationFilter.sql : ""}
          ORDER BY tasks.created_at DESC, tasks.id DESC`,
        args: [boardId, ...(taskFilter ? [filterId!] : []), ...(locationFilter?.args ?? [])],
      }) : null
      const pages = kanban && index && kanbanLanes ? namedKanbanPages(index.rows.map(row => ({
        id: String(row.id), laneId: String(row.board_column_id), title: String(row.title), search: String(row.search),
        status: String(row.status), assignedTo: String(row.assigned_to ?? ""), areaId: String(row.area_id ?? ""),
        dueDate: typeof row.due_date === "string" ? row.due_date : null,
        routine: row.task_kind === "routine_instance" && row.source_template_id != null,
      })), kanban.params, kanbanLanes.rows.map(row => ({ id: String(row.id), key: String(row.key) })), kanban.timezone) : undefined
      const visibleIds = pages?.flatMap(page => page.ids)
      const [lanes, tasks, members, intakes, agents] = await tx.batch([
        {
          sql: "SELECT id, label, key FROM kanban_lanes WHERE board_id = ? ORDER BY position, id",
          args: [boardId],
        },
        {
          sql: `SELECT tasks.id, tasks.title, tasks.description, tasks.status, tasks.ticket_ref,
              tasks.board_column_id AS lane_id, tasks.assigned_to, tasks.due_date,
              (tasks.task_kind = 'routine_instance' AND tasks.source_template_id IS NOT NULL) AS routine,
              ${selection?.ticketId || kanban ? "ticket_area.id AS area_id, project.id AS project_id," : ""}
              ${taskTimestampMs("tasks.updated_at")} AS version
            FROM tasks ${taskFilter || kanban ? scopedTaskJoin : ""}
            ${selection?.ticketId || kanban ? `LEFT JOIN areas AS ticket_area
              ON ticket_area.id = CASE WHEN project.id IS NOT NULL THEN project.area_id ELSE placement.area_id END
                AND ticket_area.owner_board_id = tasks.task_board_id AND ticket_area.retired_at IS NULL` : ""}
            WHERE tasks.task_board_id = ? ${taskFilter} ${locationFilter ? "AND " + locationFilter.sql : ""}
            ${visibleIds ? "AND tasks.id IN (SELECT value FROM json_each(?))" : ""}
            ORDER BY tasks.created_at DESC, tasks.id DESC ${kanban ? "" : "LIMIT 51 OFFSET ?"}`,
          args: [boardId, ...(taskFilter ? [filterId!] : []), ...(locationFilter?.args ?? []),
            ...(visibleIds ? [JSON.stringify(visibleIds)] : []), ...(kanban ? [] : [selection?.ticketId ? 0 : offset])],
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
      if (selection?.ticketId && !tasks!.rows.length) return null
      const closedStatuses = STATUS_CONFIG.filter(status => status.isDone).flatMap(status => [status.canonical, ...status.aliases])
        .concat(["archived", "cancelled", "canceled"])
      const summary = context?.project ? await this.readProjectTaskSummary(tx, boardId, context.project.id, closedStatuses) : null
      const planning = !selection || selection.planning ? await readNamedBoardPlanning(tx, actor, access) : null
      if (!await boardGrantStillCurrent(this.db, revision, this.markerPath)) return null
      return {
        board: access,
        planning,
        ...(context ? { context, summary } : {}),
        lanes: lanes!.rows.map(lane => ({ id: String(lane.id), label: String(lane.label), key: String(lane.key) })),
        ...(pages ? { kanbanPages: pages } : {}),
        tasks: (kanban ? tasks!.rows : tasks!.rows.slice(0, 50)).map(task => ({
          id: String(task.id), title: String(task.title), description: String(task.description ?? ""),
          status: String(task.status), ticket: String(task.ticket_ref), laneId: String(task.lane_id),
          assignedTo: typeof task.assigned_to === "string" ? task.assigned_to : null,
          dueDate: typeof task.due_date === "string" ? task.due_date : null,
          routine: task.routine === 1, version: Number(task.version),
          ...(selection?.ticketId || kanban ? {
            placement: {
              areaId: typeof task.area_id === "string" ? task.area_id : null,
              projectId: typeof task.project_id === "string" ? task.project_id : null,
            },
          } : {}),
        })),
        nextOffset: !kanban && tasks!.rows.length > 50 ? offset + 50 : null,
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

  private async readProjectTaskSummary(tx: Transaction, boardId: string, projectId: string, closedStatuses: string[]) {
    const { rows: [summary] } = await tx.execute({
      sql: `WITH open_tasks AS (
          SELECT tasks.id, tasks.title, tasks.created_at, tasks.blocked_by, tasks.status FROM tasks
          JOIN board_task_planning AS placement ON placement.task_id = tasks.id
          WHERE tasks.task_board_id = ? AND placement.project_id = ?
            AND lower(tasks.status) NOT IN (SELECT value FROM json_each(?))
        )
        SELECT COUNT(*) AS count,
          (SELECT id FROM open_tasks WHERE blocked_by IS NULL AND status <> 'stalled' ORDER BY created_at DESC, id DESC LIMIT 1) AS next_id,
          (SELECT title FROM open_tasks WHERE blocked_by IS NULL AND status <> 'stalled' ORDER BY created_at DESC, id DESC LIMIT 1) AS next_title
        FROM open_tasks`,
      args: [boardId, projectId, JSON.stringify(closedStatuses)],
    })
    return {
      count: Number(summary?.count ?? 0),
      next: typeof summary?.next_id === "string" ? { id: summary.next_id, title: String(summary.next_title) } : null,
    }
  }

  private async readWorkspaceContext(tx: Transaction, boardId: string, selection: BoardWorkspaceSelection) {
    const { projectId, areaId } = selection
    const { rows: [project] } = projectId ? await tx.execute({
      sql: `SELECT project.id, project.title, project.status, area.id AS area_id
        FROM projects AS project LEFT JOIN areas AS area
          ON area.id = project.area_id AND area.owner_board_id = ? AND area.retired_at IS NULL
        WHERE project.id = ? AND project.owner_board_id = ? AND project.retired_at IS NULL`,
      args: [boardId, projectId, boardId],
    }) : { rows: [] }
    if (projectId && !project) return null
    if (project && areaId && project.area_id !== areaId) return null
    const effectiveAreaId = areaId ?? project?.area_id
    const { rows: [area] } = typeof effectiveAreaId === "string" ? await tx.execute({
      sql: "SELECT id, name FROM areas WHERE id = ? AND owner_board_id = ? AND retired_at IS NULL",
      args: [effectiveAreaId, boardId],
    }) : { rows: [] }
    if (areaId && !area) return null
    return {
      area: area ? { id: String(area.id), name: String(area.name) } : null,
      project: project ? { id: String(project.id), title: String(project.title), status: String(project.status) } : null,
    }
  }

  async groups(actor: BoardActor, boardId: string, after: string | null, selectedId: string | null = null) {
    const revision = await currentBoardGrantRevision(this.db, this.markerPath)
    if (!revision) return null
    const tx = await this.db.transaction("read")
    try {
      const access = await selectNamedBoardAccess(tx, actor, revision, boardId)
      if (!access || actor.kind !== "ha_user") return null
      const { rows } = await tx.execute({
        sql: `WITH marker AS (
            SELECT position, name, id FROM areas
            WHERE id = ? AND owner_board_id = ? AND retired_at IS NULL
          )
          SELECT item.id, item.name, item.icon, item.color FROM areas AS item
          WHERE item.owner_board_id = ? AND item.retired_at IS NULL AND (
            ? IS NULL OR EXISTS (
              SELECT 1 FROM marker WHERE (item.position, item.name COLLATE NOCASE, item.id) >
                (marker.position, marker.name COLLATE NOCASE, marker.id)
            )
          )
          ORDER BY item.position, item.name COLLATE NOCASE, item.id LIMIT 31`,
        args: [after, boardId, boardId, after],
      })
      const { rows: [selected] } = selectedId ? await tx.execute({
        sql: "SELECT id, name, icon, color FROM areas WHERE id = ? AND owner_board_id = ? AND retired_at IS NULL",
        args: [selectedId, boardId],
      }) : { rows: [] }
      if (!await boardGrantStillCurrent(this.db, revision, this.markerPath)) return null
      const items = rows.slice(0, 30).map(row => ({
        id: String(row.id), name: String(row.name), icon: String(row.icon), color: String(row.color),
      }))
      return { items, selected: selected ? {
        id: String(selected.id), name: String(selected.name), icon: String(selected.icon), color: String(selected.color),
      } : null, next_cursor: rows.length > 30 ? items.at(-1)!.id : null }
    } finally {
      tx.close()
    }
  }

  async projects(actor: BoardActor, boardId: string, areaId: string, after: string | null, selectedId: string | null = null) {
    if (!available("projects") || !available("groups")) return null
    const revision = await currentBoardGrantRevision(this.db, this.markerPath)
    if (!revision) return null
    const tx = await this.db.transaction("read")
    try {
      const access = await selectNamedBoardAccess(tx, actor, revision, boardId)
      if (!access || actor.kind !== "ha_user") return null
      const { rows: areas } = await tx.execute({
        sql: "SELECT id FROM areas WHERE id = ? AND owner_board_id = ? AND retired_at IS NULL",
        args: [areaId, boardId],
      })
      if (!areas.length) return null
      const { rows } = await tx.execute({
        sql: `WITH marker AS (
            SELECT position, title, id FROM projects
            WHERE id = ? AND owner_board_id = ? AND area_id = ? AND retired_at IS NULL
          )
          SELECT item.id, item.title FROM projects AS item
          WHERE item.owner_board_id = ? AND item.area_id = ? AND item.retired_at IS NULL AND (
            ? IS NULL OR EXISTS (
              SELECT 1 FROM marker WHERE (item.position, item.title COLLATE NOCASE, item.id) >
                (marker.position, marker.title COLLATE NOCASE, marker.id)
            )
          )
          ORDER BY item.position, item.title COLLATE NOCASE, item.id LIMIT 31`,
        args: [after, boardId, areaId, boardId, areaId, after],
      })
      const { rows: [selected] } = selectedId ? await tx.execute({
        sql: "SELECT id, title FROM projects WHERE id = ? AND owner_board_id = ? AND area_id = ? AND retired_at IS NULL",
        args: [selectedId, boardId, areaId],
      }) : { rows: [] }
      if (!await boardGrantStillCurrent(this.db, revision, this.markerPath)) return null
      const project = (row: typeof rows[number]) => ({ id: String(row.id), name: String(row.title) })
      const items = rows.slice(0, 30).map(project)
      return { items, selected: selected ? project(selected) : null, next_cursor: rows.length > 30 ? items.at(-1)!.id : null }
    } finally {
      tx.close()
    }
  }

  async create(actor: BoardActor, boardId: string, content: NamedTaskContent, placement: NamedTaskPlacement) {
    return this.mutate(actor, boardId, "create", async (tx, allows) => {
      const lane = await this.readLane(tx, boardId, placement.laneId)
      if (!lane) return unavailable
      if (isDoneStatus(lane.status) && !allows("complete")) return denied

      const { projectId, goalId } = placement
      let areaId = placement.areaId
      if (placement.local) {
        const context = await this.readWorkspaceContext(tx, boardId, {
          areaId: areaId ?? null, projectId: projectId ?? null, ticketId: null, planning: false,
        })
        if (!context || (context.project && context.project.status !== "active")) return unavailable
        areaId = context.area?.id
      }
      const scopes = [["areas", placement.local ? undefined : areaId],
        ["projects", placement.local ? undefined : projectId], ["goals", goalId]] as const
      for (const [table, target] of scopes) {
        if (!target) continue
        const { rows } = await tx.execute({
          sql: `SELECT 1 FROM ${table} AS planning
            WHERE planning.id = ? AND planning.retired_at IS NULL AND ((planning.owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active')) OR EXISTS (
              SELECT 1 FROM board_access_grants AS grant JOIN task_boards AS target_board ON target_board.id = grant.board_id
              JOIN board_permissions AS policy ON policy.board_id = target_board.id
              WHERE grant.board_id = planning.owner_board_id AND target_board.state IN ('active', 'archived')
                AND grant.principal_type = ? AND grant.principal_id = ?
            ))`,
          args: [target, actor.kind, actor.id],
        })
        if (!rows.length) return unavailable
      }

      const homeArea = placement.homeAssistantArea
      if (homeArea && !(await tx.execute(readHomeAssistantAreaPolicyRevision(homeArea.revision))).rows.length) return denied
      const task = await insertNamedTask(tx, { boardId, laneId: lane.id, content, status: lane.status })
      if (!task) return unavailable
      if (areaId || projectId || goalId) {
        await tx.execute({
          sql: "INSERT INTO board_task_planning (task_id, area_id, project_id, goal_id) VALUES (?, ?, ?, ?)",
          args: [task.id, areaId ?? null, projectId ?? null, goalId ?? null],
        })
      }
      if (homeArea?.id) await tx.execute(setTaskHomeAssistantArea(task.id, homeArea.id))
      return { ok: true, value: task }
    })
  }

  async homeAssistantArea(actor: BoardActor, boardId: string, id: string, policyRevision: string) {
    const revision = await currentBoardGrantRevision(this.db, this.markerPath)
    if (!revision) return null
    const tx = await this.db.transaction("read")
    try {
      const access = await selectNamedBoardAccess(tx, actor, revision, boardId)
      if (!access || !(await tx.execute(readHomeAssistantAreaPolicyRevision(policyRevision))).rows.length) return null
      const { rows: [task] } = await tx.execute({
        sql: `SELECT ${taskTimestampMs("updated_at")} AS version FROM tasks WHERE id = ? AND task_board_id = ?`,
        args: [id, boardId],
      })
      if (!task) return null
      const area = await findTaskHomeAssistantArea(tx, id)
      if (!await boardGrantStillCurrent(this.db, revision, this.markerPath)) return null
      return { ...area, version: Number(task.version) }
    } finally {
      tx.close()
    }
  }

  async changeHomeAssistantArea(actor: BoardActor, boardId: string, id: string, version: number, locationRevision: number, selection: HomeAssistantAreaSelection) {
    return this.mutate(actor, boardId, "edit", tx => editTaskHomeAssistantArea(tx, id, boardId, version, locationRevision, selection))
  }

  async file(actor: BoardActor, boardId: string, id: string, version: number, areaId?: string | null, projectId?: string | null) {
    return this.mutate(actor, boardId, "edit", async tx => {
      const { rows: [existing] } = await tx.execute({
        sql: `SELECT placement.area_id, placement.project_id FROM tasks
          LEFT JOIN board_task_planning AS placement ON placement.task_id = tasks.id
          WHERE tasks.id = ? AND tasks.task_board_id = ? AND ${taskTimestampMs("tasks.updated_at")} = ?
            AND NOT (tasks.task_kind = 'routine_instance' AND tasks.source_template_id IS NOT NULL)`,
        args: [id, boardId, version],
      })
      if (!existing) return stale
      const effectiveProjectId = projectId === undefined && typeof existing.project_id === "string" ? existing.project_id : projectId ?? null
      const effectiveAreaId = areaId === undefined && !effectiveProjectId && typeof existing.area_id === "string" ? existing.area_id : areaId ?? null
      const context = await this.readWorkspaceContext(tx, boardId, {
        areaId: effectiveAreaId, projectId: effectiveProjectId, ticketId: null, planning: false,
      })
      if (!context || (context.project && context.project.status !== "active")) return unavailable
      const { rows: [task] } = await tx.execute({
        sql: `UPDATE tasks SET updated_at = ${nextTaskTimestampMs("updated_at")}
          WHERE id = ? AND task_board_id = ? AND NOT (task_kind = 'routine_instance' AND source_template_id IS NOT NULL)
            AND ${taskTimestampMs("updated_at")} = ? AND ${canAdvanceTaskTimestampMs("updated_at")}
          RETURNING updated_at AS version`,
        args: [Date.now(), id, boardId, version],
      })
      if (!task) return stale
      const groupId = context.area?.id ?? null
      if (!groupId && !effectiveProjectId) {
        await tx.execute({ sql: "DELETE FROM board_task_planning WHERE task_id = ? AND goal_id IS NULL", args: [id] })
        await tx.execute({ sql: "UPDATE board_task_planning SET area_id = NULL, project_id = NULL WHERE task_id = ?", args: [id] })
      } else {
        await tx.execute({
          sql: `INSERT INTO board_task_planning (task_id, area_id, project_id) VALUES (?, ?, ?)
            ON CONFLICT(task_id) DO UPDATE SET area_id = excluded.area_id, project_id = excluded.project_id`,
          args: [id, groupId, effectiveProjectId],
        })
      }
      return { ok: true, value: { version: Number(task.version) } }
    })
  }

  async completeRoutine(actor: BoardActor, boardId: string, routineId: string, requestedPeriod?: string) {
    return this.mutate(actor, boardId, "complete", async (tx, allows) => {
      if (!available("routines") || !allows("create")) return denied
      const { rows: [routine] } = await tx.execute({
        sql: `SELECT routine.name, routine.cadence, area.id AS area_id,
            json_extract(routine.template_json, '$.project_id') AS project_id,
            json_extract(routine.template_json, '$.description') AS description,
            (SELECT id FROM kanban_lanes WHERE board_id = ? AND key = 'complete' LIMIT 1) AS lane_id
          FROM task_templates AS routine
          JOIN areas AS area ON json_extract(routine.template_json, '$.area_id') = area.id
            AND area.owner_board_id = routine.owner_board_id AND area.retired_at IS NULL
          WHERE routine.id = ? AND routine.owner_board_id = ? AND routine.is_routine = 1 AND routine.retired_at IS NULL`,
        args: [boardId, routineId, boardId],
      })
      if (!routine || typeof routine.lane_id !== "string") return unavailable
      const currentPeriod = namedRoutinePeriod(String(routine.cadence))
      const period = requestedPeriod ?? currentPeriod
      const { rows: [existing] } = await tx.execute({
        sql: `SELECT id, status FROM tasks WHERE task_board_id = ? AND source_template_id = ? AND due_date = ? LIMIT 1`,
        args: [boardId, routineId, period],
      })
      if (existing) {
        if (existing.status !== STATUS.COMPLETE) return stale
        return { ok: true, value: { id: String(existing.id) } }
      }
      if (period !== currentPeriod) return stale
      if (typeof routine.project_id === "string") {
        const { rows: [project] } = await tx.execute({
          sql: "SELECT id FROM projects WHERE id = ? AND owner_board_id = ? AND area_id = ? AND status = 'active' AND retired_at IS NULL",
          args: [routine.project_id, boardId, String(routine.area_id)],
        })
        if (!project) return unavailable
      }
      const task = await insertNamedTask(tx, {
        boardId, laneId: routine.lane_id, status: STATUS.COMPLETE,
        content: { title: String(routine.name), description: String(routine.description ?? "") },
        routine: { templateId: routineId, period },
      })
      if (!task) return unavailable
      await tx.execute({
        sql: "INSERT INTO board_task_planning (task_id, area_id, project_id) VALUES (?, ?, ?)",
        args: [task.id, String(routine.area_id), typeof routine.project_id === "string" ? routine.project_id : null],
      })
      return { ok: true, value: { id: task.id } }
    })
  }

  async edit(actor: BoardActor, boardId: string, id: string, version: number, content: Partial<NamedTaskContent>) {
    return this.mutate(actor, boardId, "edit", async tx => {
      if (content.dueDate !== undefined) {
        const { rows: [task] } = await tx.execute({
          sql: `SELECT due_date, task_kind, source_template_id FROM tasks WHERE id = ? AND task_board_id = ?`,
          args: [id, boardId],
        })
        if (!task) return unavailable
        if (task.task_kind === "routine_instance" && task.source_template_id != null && content.dueDate !== task.due_date) return { ok: false, errorCode: "stale", reason: "routine-date" }
      }
      const { rows: [updated] } = await tx.execute({
        sql: `UPDATE tasks SET title = COALESCE(?, title), description = COALESCE(?, description),
          due_date = CASE WHEN ? THEN ? ELSE due_date END,
          updated_at = ${nextTaskTimestampMs("updated_at")}
          WHERE id = ? AND task_board_id = ? AND ${taskTimestampMs("updated_at")} = ?
            AND (${canAdvanceTaskTimestampMs("updated_at")})
          RETURNING updated_at AS version`,
        args: [content.title ?? null, content.description ?? null, Number(content.dueDate !== undefined), content.dueDate ?? null, Date.now(), id, boardId, version],
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
        sql: "SELECT source_template_id, task_kind FROM tasks WHERE id = ? AND task_board_id = ?",
        args: [id, boardId],
      })
      if (task?.task_kind === "routine_instance" && task.source_template_id != null) return denied
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
