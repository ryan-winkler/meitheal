import type { AssignmentProof } from "../assignment-proof"
import type { Client, Transaction } from "@libsql/client"
import type { HomeAssistantAreaFilter, HomeAssistantAreaSelection } from "../../../lib/home-assistant-area-access"
import type { BoardWorkspaceSelection } from "../../../lib/board-workspace"
import { isClosedStatus, normalizeStatus, STATUS } from "../../../lib/status-config"
import { projectPublicTaskFields } from "../task-projection"
import { prepareTaskCreation } from "../task-creation-service"
import { requireBoardScope, scopeBoardAccess, scopePermits, validateBoardScope, type BoardScope } from "../board-scope"
import { boardOperationClient, boardReadTransactionClient, BoardOperationError } from "./board-operation-client"
import { HierarchyRepository } from "./hierarchy-repository"
import { TemplateRepository } from "./template-repository"
import { TaskRepository, type TaskRow } from "./task-repository"
import { readNamedBoardPlanning, namedRoutinePeriod } from "./named-board-planning-repository"
import { editTaskHomeAssistantArea, findTaskHomeAssistantArea, readHomeAssistantAreaPolicyRevision } from "./home-assistant-task-area"
import type { BoardActor } from "./named-board-repository"
import { sql } from "./sql-fragment"
import type { TaskReadPlacement } from "./board-work-query"
import { isOrganizationFeatureAvailable as available } from "../../../lib/organization-request-context"

type Outcome<T> = { ok: true, value: T } | { ok: false, errorCode: "unavailable" | "denied" | "stale", reason?: "routine-date" }
type NamedTaskContent = { title: string, description: string, dueDate?: string | null }
type NamedTaskPlacement = { laneId?: string, areaId?: string, projectId?: string, goalId?: string, local?: boolean, homeAssistantArea?: HomeAssistantAreaSelection }
const unavailable = { ok: false, errorCode: "unavailable" } as const
const stale = { ok: false, errorCode: "stale" } as const

/** Compatibility adapter only. Validation, allocation and writes belong to the common rich command. */
export async function insertNamedTask(tx: Transaction, input: {
  boardId: string, laneId: string, status: string, content: NamedTaskContent, assignedTo?: string, assignmentProof?: AssignmentProof | undefined,
  routine?: { templateId: string, period: string },
}, scope: BoardScope, db: Client) {
  if (scope.boardId !== input.boardId || input.routine) return null
  const repo = new TaskRepository(db, scope)
  const prepared = await prepareTaskCreation(repo, { title: input.content.title, description: input.content.description,
    status: input.status, due_date: input.content.dueDate ?? null, assigned_to: input.assignedTo ?? null }, { useDefaultAssignee: false })
  if (!prepared.ok) return null
  const created = await repo.createWorkInWriter(tx, prepared.task, { laneId: input.laneId, assignmentProof: input.assignmentProof })
  return created.ok ? { id: created.task.id, ticket: String(created.task.ticket_ref), version: Number(created.task.updated_at) } : null
}

/** Old /tickets paths translate to the same scoped rich task/planning engines. */
export class NamedBoardTaskRepository {
  constructor(private readonly db: Client, private readonly scope: BoardScope, private readonly markerPath?: string) { requireBoardScope(scope) }
  private matches(actor: BoardActor, boardId = this.scope.boardId) {
    return boardId === this.scope.boardId && actor.kind === this.scope.principal.kind && actor.id === this.scope.principal.id
  }
  private repo() { return new TaskRepository(this.db, this.scope) }
  private async outcome<T>(run: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
    try { return await run() } catch (error) {
      if (error instanceof BoardOperationError) return { ok: false, errorCode: error.errorCode === "denied" ? "denied" : error.errorCode === "stale" ? "stale" : "unavailable" }
      throw error
    }
  }

  async routineLibrary(actor: BoardActor, placement?: TaskReadPlacement) {
    if (!this.matches(actor)) return []
    const routines = await new TemplateRepository(this.db, this.scope).getRoutinesWithStats(placement?.areaId ?? undefined, placement?.projectId ?? undefined)
    const projects = new Map((await new HierarchyRepository(this.db, this.scope).findAllProjects()).map(project => [project.id, project.status]))
    const board = scopeBoardAccess(this.scope)
    return routines.map(routine => {
      const template = JSON.parse(routine.template_json) as { project_id?: unknown }
      const projectActive = typeof template.project_id !== "string" || projects.get(template.project_id) === "active"
      return { id: routine.id, name: routine.name, cadence: routine.cadence,
      period: namedRoutinePeriod(routine.cadence), boardId: board.id, boardName: board.name,
      complete: routine.todayCompleted, canComplete: projectActive && scopePermits(this.scope, { resource: "task", action: "complete" }) && scopePermits(this.scope, { resource: "task", action: "create" }) }
    })
  }

  async dueWork(actor: BoardActor, day: string) {
    if (!this.matches(actor)) return []
    const rows = [...await this.repo().getOverdueTasks(day), ...await this.repo().getTasksDueOn(day)]
    const board = scopeBoardAccess(this.scope)
    return [...new Map(rows.map(row => [row.id, row])).values()].filter(row => !isClosedStatus(row.status)).map(row => ({
      id: row.id, title: row.title, dueDate: String(row.due_date), boardId: board.id, boardName: board.name,
    }))
  }

  async view(actor: BoardActor, boardId: string, offset = 0, selection?: BoardWorkspaceSelection, location?: HomeAssistantAreaFilter, _kanban?: { params: URLSearchParams, timezone?: string }) {
    if (!this.matches(actor, boardId)) return null
    const tx = await boardOperationClient(this.db, this.scope, { resource: "task", action: "read" }).transaction("read")
    try {
      const reader = boardReadTransactionClient(tx, this.scope)
      const hierarchy = new HierarchyRepository(reader, this.scope)
      const repo = new TaskRepository(reader, this.scope)
      const project = selection?.projectId ? await hierarchy.findProjectById(selection.projectId) : null
      if (selection?.projectId && !project || project && selection?.areaId && project.area_id !== selection.areaId) return null
      const areaId = selection?.areaId ?? project?.area_id
      const area = areaId ? await hierarchy.findAreaById(areaId) : null
      if (areaId && !area) return null
      const context = { area: area ? { id: area.id, name: area.name } : null,
        project: project ? { id: project.id, title: project.title, status: project.status } : null }
      const rows = selection?.ticketId ? { tasks: [await repo.findById(selection.ticketId)].filter((row): row is TaskRow => row !== null), total: 1 } :
        await repo.findAll({ limit: 51, offset, ...(project ? { projectId: project.id } : area ? { workspaceAreaId: area.id } : {}), ...(location ? { homeAssistantArea: location } : {}) })
      if (selection?.ticketId && !rows.tasks.length) return null
      const lanes = await repo.getKanbanLanes()
      const access = scopeBoardAccess(this.scope)
      const [members, intakes, agents] = access.role === "owner" ? await tx.batch([
        sql`SELECT principal_id, role, deny_completion, deny_deletion FROM board_access_grants WHERE board_id = ${boardId} AND principal_type = 'ha_user' ORDER BY principal_id`,
        sql`SELECT id, label, enabled FROM board_intakes WHERE board_id = ${boardId} ORDER BY label COLLATE NOCASE, id`,
        sql`SELECT principal_id FROM board_access_grants WHERE board_id = ${boardId} AND principal_type = 'agent' ORDER BY principal_id`,
      ]) : []
      const planning = !selection || selection.planning ? await readNamedBoardPlanning(reader, this.scope) : null
      const summary = project ? { count: (await repo.findAll({ projectId: project.id, deferred: false, limit: 1 })).total,
        next: rows.tasks.find(row => !isClosedStatus(row.status) && !row.blocked_by) ? { id: rows.tasks.find(row => !isClosedStatus(row.status) && !row.blocked_by)!.id,
          title: rows.tasks.find(row => !isClosedStatus(row.status) && !row.blocked_by)!.title } : null } : null
      const current = await validateBoardScope(this.scope, this.db, { resource: "task", action: "read" })
      if (!current.ok) return null
      return {
        board: access, authorityRevision: this.scope.authorityRevision, planning, context, summary,
        lanes: lanes.map(lane => ({ id: lane.id, label: lane.label, key: lane.key })),
        tasks: rows.tasks.slice(0, 50).map(task => {
          const publicTask = projectPublicTaskFields(task)
          return { ...publicTask, id: task.id, title: task.title, description: task.description ?? "",
            status: task.status, ticket: String(task.ticket_ref ?? `${access.ticketPrefix}-${task.ticket_number}`),
            laneId: String(task.board_column_id ?? lanes.find(lane => lane.includes.includes(normalizeStatus(task.status)))?.id ?? ""),
            assignedTo: task.assigned_to, dueDate: task.due_date, routine: task.task_kind === "routine_instance" && task.source_template_id !== null,
            version: Number(task.task_version ?? task.updated_at), placement: { areaId: publicTask.area_id ?? null, projectId: publicTask.project_id ?? null } }
        }),
        nextOffset: rows.tasks.length > 50 ? offset + 50 : null,
        members: (members?.rows ?? []).map(member => ({ id: String(member.principal_id), role: String(member.role), denyCompletion: member.deny_completion === 1, denyDeletion: member.deny_deletion === 1 })),
        intakes: (intakes?.rows ?? []).map(intake => ({ id: String(intake.id), label: String(intake.label), enabled: intake.enabled === 1 })),
        agents: (agents?.rows ?? []).map(agent => String(agent.principal_id)),
      }
    } finally { tx.close() }
  }

  async groups(actor: BoardActor, boardId: string, after: string | null, selectedId: string | null = null) {
    if (!this.matches(actor, boardId) || !available("groups")) return null
    const areas = await new HierarchyRepository(this.db, this.scope).findAllAreas()
    const start = after ? areas.findIndex(area => area.id === after) + 1 : 0
    if (after && start === 0) return null
    const items = areas.slice(start, start + 30).map(area => ({ id: area.id, name: area.name, icon: area.icon, color: area.color }))
    const selected = areas.find(area => area.id === selectedId)
    return { items, selected: selected ? { id: selected.id, name: selected.name, icon: selected.icon, color: selected.color } : null,
      next_cursor: areas.length > start + 30 ? items.at(-1)!.id : null }
  }

  async projects(actor: BoardActor, boardId: string, areaId: string, after: string | null, selectedId: string | null = null) {
    if (!this.matches(actor, boardId) || !available("groups") || !available("projects")) return null
    return new HierarchyRepository(this.db, this.scope).findProjectPage(areaId, after, selectedId)
  }

  async create(actor: BoardActor, boardId: string, content: NamedTaskContent, placement: NamedTaskPlacement) {
    if (!this.matches(actor, boardId)) return unavailable
    return this.outcome(async () => {
      const repo = this.repo()
      const { rows: [lane] } = placement.laneId ? await boardOperationClient(this.db, this.scope, { resource: "task", action: "create" }).execute(sql`SELECT key, includes FROM kanban_lanes WHERE id = ${placement.laneId} AND board_id = ${this.scope.boardId}`) : { rows: [] }
      let laneStatus = lane ? String(lane.key) : STATUS.PENDING
      if (lane) { try { const statuses: unknown = JSON.parse(String(lane.includes)); if (Array.isArray(statuses) && typeof statuses[0] === "string") laneStatus = statuses[0] } catch { return unavailable } }
      const prepared = await prepareTaskCreation(repo, { title: content.title, description: content.description, due_date: content.dueDate ?? null,
        status: laneStatus, area_id: placement.areaId ?? null, project_id: placement.projectId ?? null, goal_id: placement.goalId ?? null })
      if (!prepared.ok) return unavailable
      const created = await repo.createWorkCommand(prepared.task, { ...(placement.laneId ? { laneId: placement.laneId } : {}), ...(placement.homeAssistantArea ? { homeLocation: placement.homeAssistantArea } : {}) })
      return created.ok ? { ok: true, value: { id: created.task.id, ticket: String(created.task.ticket_ref), version: Number(created.task.updated_at) } } : unavailable
    })
  }

  async homeAssistantArea(actor: BoardActor, boardId: string, id: string, policyRevision: string) {
    if (!this.matches(actor, boardId)) return null
    const tx = await boardOperationClient(this.db, this.scope, { resource: "task", action: "read" }, [id]).transaction("read")
    try {
      if (!(await tx.execute(readHomeAssistantAreaPolicyRevision(policyRevision))).rows.length) return null
      const area = await findTaskHomeAssistantArea(tx, this.scope, id)
      const task = await new TaskRepository(boardReadTransactionClient(tx, this.scope), this.scope).findById(id)
      return area && task ? { ...area, version: Number(task.task_version ?? task.updated_at) } : null
    } finally { tx.close() }
  }
  async changeHomeAssistantArea(actor: BoardActor, boardId: string, id: string, version: number, locationRevision: number, selection: HomeAssistantAreaSelection) {
    if (!this.matches(actor, boardId)) return unavailable
    return this.outcome(async () => {
      const tx = await boardOperationClient(this.db, this.scope, { resource: "task", action: "edit" }, [id]).transaction("write")
      try { const result = await editTaskHomeAssistantArea(tx, this.scope, id, version, locationRevision, selection); if (result.ok) await tx.commit(); return result } finally { tx.close() }
    })
  }
  async file(actor: BoardActor, boardId: string, id: string, version: number, areaId?: string | null, projectId?: string | null) {
    if (!this.matches(actor, boardId)) return unavailable
    return this.outcome(async () => { const result = await this.repo().fileTask(id, version, { ...(areaId === undefined ? {} : { areaId }), ...(projectId === undefined ? {} : { projectId }) });
      return result.ok ? { ok: true, value: { version: Number(result.task.task_version ?? result.task.updated_at) } } : stale })
  }
  async completeRoutine(actor: BoardActor, boardId: string, routineId: string, requestedPeriod?: string) {
    if (!this.matches(actor, boardId)) return unavailable
    return this.outcome(async () => {
      const templates = new TemplateRepository(this.db, this.scope)
      const template = await templates.findById(routineId)
      if (!template) return unavailable
      if (requestedPeriod && requestedPeriod !== namedRoutinePeriod(String(template.cadence ?? "daily"))) return stale
      const result = await templates.completeRoutine(routineId)
      return result?.completed ? { ok: true, value: { id: result.taskId } } : unavailable
    })
  }
  async edit(actor: BoardActor, boardId: string, id: string, version: number, content: Partial<NamedTaskContent>) {
    if (!this.matches(actor, boardId)) return unavailable
    return this.outcome(async () => { const result = await this.repo().updateTask(id, { ...(content.title === undefined ? {} : { title: content.title }), ...(content.description === undefined ? {} : { description: content.description }), ...(content.dueDate === undefined ? {} : { due_date: content.dueDate }) }, { version: { updatedAt: version } });
      return result.ok ? { ok: true, value: { version: Number(result.task.task_version ?? result.task.updated_at) } } : stale })
  }
  async move(actor: BoardActor, boardId: string, id: string, laneId: string, version: number) {
    if (!this.matches(actor, boardId)) return unavailable
    return this.outcome(async () => { const result = await this.repo().moveToLane(id, laneId, version); return result.ok ? { ok: true, value: { version: Number(result.task.task_version ?? result.task.updated_at) } } : stale })
  }
  async delete(actor: BoardActor, boardId: string, id: string, version: number) {
    if (!this.matches(actor, boardId)) return unavailable
    return this.outcome(async () => await this.repo().deleteTask(id, { version }) ? { ok: true, value: true } : stale)
  }
}
