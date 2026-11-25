import { randomUUID } from "node:crypto"
import type { Client } from "@libsql/client"
import { BoardAccessService } from "../board-access-service"
import { requireBoardScope, scopeBoardAccess, scopePermits, type BoardScope } from "../board-scope"
import { readBoardPillars, saveBoardPillarChange, type BoardPillarChange } from "@domains/pillars"
import { HierarchyRepository } from "./hierarchy-repository"
import { TemplateRepository, routinePeriod } from "./template-repository"
import { changeGoalShare, readSharedGoals, type GoalShareTarget } from "./shared-goal-repository"
import { ownedPlanning } from "./board-storage"
import { sql } from "./sql-fragment"

export type VisibilityChange =
  | {
      action: "goal-share"
      id: string
      areaId?: string
      target?: GoalShareTarget
      enabled: boolean
    }
  | { action: "retire"; entity: "area" | "goal" | "project" | "routine"; id: string }
export type BoardPlanningChange =
  | BoardPillarChange
  | VisibilityChange
  | { action: "area"; title: string; id?: string; icon?: string; color?: string }
  | {
      action: "goal"
      title: string
      description: string
      areaId?: string | null
      id?: string
      projectId?: string | null
    }
  | {
      action: "project"
      title: string
      description: string
      areaId?: string | null
      goalId: string | null
    }
  | { action: "project-edit"; id: string; title: string; description: string }
  | { action: "project-goal"; id: string; goalId: string | null }
  | { action: "project-status"; id: string; status: "active" | "completed" | "archived" }
  | {
      action: "routine"
      title: string
      description: string
      areaId?: string | null
      cadence: "daily" | "weekly"
      id?: string
      projectId?: string | null
    }
export const namedRoutinePeriod = routinePeriod

/** Compatibility output assembled exclusively from the common scoped engines. */
export async function readNamedBoardPlanning(client: Client, scope: BoardScope, timezone = "UTC") {
  requireBoardScope(scope)
  const hierarchy = new HierarchyRepository(client, scope)
  const templates = new TemplateRepository(client, scope)
  const can = (resource: "area" | "project" | "goal" | "routine" | "pillar") =>
    scopePermits(scope, { resource, action: "read" })
  const areas = can("area") ? await hierarchy.findAllAreas() : []
  const projects = can("project") ? await hierarchy.findAllProjects() : []
  const goals = can("goal") ? await hierarchy.findAllGoals() : []
  const shared = can("goal") ? await readSharedGoals(client, scope) : []
  const routines = can("routine") ? await templates.getRoutinesWithStats(undefined, undefined, timezone) : []
  const pillars = can("pillar") ? await readBoardPillars(client, scope) : []
  const destinations: Array<{
    id: string
    name: string
    board: string
    boardId: string
    kind: "board" | "area" | "project"
  }> = []
  const shares: Array<{
    goalId: string
    areaId: string | null
    projectId: string | null
    boardId: string
    areaName: string | null
  }> = []
  if (scopePermits(scope, { resource: "board", action: "manage" })) {
    const access = new BoardAccessService(client)
    const { rows: boards } = await client.execute(
      "SELECT id FROM task_boards WHERE state IN ('active','archived') ORDER BY name COLLATE NOCASE,id"
    )
    for (const row of boards) {
      const target = await access.resolveInTransaction(
        scope.principal,
        String(row.id),
        { resource: "board", action: "manage" },
        client,
        scope.authorityRevision
      )
      if (!target.ok) continue
      const board = scopeBoardAccess(target.scope)
      destinations.push({
        id: board.id,
        name: board.name,
        board: board.name,
        boardId: board.id,
        kind: "board"
      })
      const targetHierarchy = new HierarchyRepository(client, target.scope)
      if (scopePermits(target.scope, { resource: "area", action: "read" }))
        for (const area of await targetHierarchy.findAllAreas())
          destinations.push({
            id: area.id,
            name: area.name,
            board: board.name,
            boardId: board.id,
            kind: "area"
          })
      if (scopePermits(target.scope, { resource: "project", action: "read" }))
        for (const project of await targetHierarchy.findAllProjects())
          destinations.push({
            id: project.id,
            name: project.title,
            board: board.name,
            boardId: board.id,
            kind: "project"
          })
    }
    const { rows } = await client.execute(
      sql`SELECT share.goal_id,share.area_id,share.project_id,share.receiving_board_id FROM board_goal_shares AS share JOIN goals ON goals.id=share.goal_id WHERE ${ownedPlanning(scope, "goals")}`
    )
    for (const row of rows) {
      const target = destinations.find(
        (target) =>
          target.boardId === row.receiving_board_id &&
          target.id === (row.area_id ?? row.project_id ?? row.receiving_board_id)
      )
      shares.push({
        goalId: String(row.goal_id),
        areaId: typeof row.area_id === "string" ? row.area_id : null,
        projectId: typeof row.project_id === "string" ? row.project_id : null,
        boardId: String(row.receiving_board_id),
        areaName: target?.name ?? null
      })
    }
  }
  return {
    areas: areas.map((area) => ({
      id: area.id,
      name: area.name,
      icon: area.icon,
      color: area.color
    })),
    projects: projects.map((project) => ({
      id: project.id,
      title: project.title,
      description: project.description ?? "",
      status: project.status,
      areaId: project.area_id,
      goalId: project.goal_id,
      isDefault: Boolean(project.is_default)
    })),
    goals: goals.map((goal) => ({
      id: goal.id,
      title: goal.title,
      description: goal.description ?? "",
      areaId: goal.area_id
    })),
    pillars,
    destinations,
    shares,
    linkableGoals: shared.map((goal) => ({
      id: goal.id,
      title: goal.title,
      sharedAreaId: goal.area_id
    })),
    routines: routines.map((routine) => {
      let template: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(routine.template_json)
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) template = parsed as Record<string, unknown>
      } catch {
        /* ignore malformed template_json */
      }
      return {
        id: routine.id,
        name: routine.name,
        cadence: routine.cadence,
        areaId: typeof template.area_id === "string" ? template.area_id : null,
        projectId: typeof template.project_id === "string" ? template.project_id : null,
        description: String(template.description ?? ""),
        complete: routine.todayCompleted,
        period: routinePeriod(routine.cadence, new Date(), timezone)
      }
    })
  }
}

/** Legacy request shapes translate; commands and validation remain in the full engines. */
export class NamedBoardPlanningRepository {
  constructor(
    private readonly db: Client,
    private readonly scope: BoardScope
  ) {
    requireBoardScope(scope)
  }
  async save(actorId: string, boardId: string, input: BoardPlanningChange): Promise<boolean> {
    if (actorId !== this.scope.principal.id || boardId !== this.scope.boardId) return false
    if (input.action === "goal-share" || input.action === "retire") {
      const result = await this.saveVisibility(actorId, boardId, input)
      return result.status !== "locked" && result.result === "saved"
    }
    const hierarchy = new HierarchyRepository(this.db, this.scope)
    const templates = new TemplateRepository(this.db, this.scope)
    if (input.action === "area") {
      if (input.id)
        return hierarchy.updateArea(input.id, {
          name: input.title,
          ...(input.icon ? { icon: input.icon } : {}),
          ...(input.color ? { color: input.color } : {})
        })
      await hierarchy.createArea({
        id: randomUUID(),
        name: input.title,
        ...(input.icon ? { icon: input.icon } : {}),
        ...(input.color ? { color: input.color } : {})
      })
      return true
    }
    if (input.action === "goal") {
      if (input.id)
        return hierarchy.updateGoal(input.id, {
          title: input.title,
          description: input.description,
          area_id: input.areaId ?? null
        })
      return hierarchy.createGoal({
        id: randomUUID(),
        title: input.title,
        description: input.description,
        area_id: input.areaId ?? null,
        project_id: input.projectId ?? null
      })
    }
    if (input.action === "project")
      return hierarchy.createProject({
        id: randomUUID(),
        title: input.title,
        description: input.description,
        area_id: input.areaId ?? null,
        goal_id: input.goalId
      })
    if (input.action === "project-edit")
      return hierarchy.updateProject(input.id, {
        title: input.title,
        description: input.description
      })
    if (input.action === "project-goal")
      return hierarchy.updateProject(input.id, { goal_id: input.goalId })
    if (input.action === "project-status")
      return hierarchy.updateProject(input.id, { status: input.status })
    if (input.action === "routine") {
      const template = {
        title: input.title,
        description: input.description,
        area_id: input.areaId ?? null,
        project_id: input.projectId ?? null
      }
      if (input.id)
        return templates.update(input.id, {
          name: input.title,
          cadence: input.cadence,
          templatePatch: JSON.stringify({
            title: input.title,
            description: input.description,
            ...(input.areaId === undefined ? {} : { area_id: input.areaId }),
            ...(input.projectId === undefined ? {} : { project_id: input.projectId })
          }),
          ...(input.areaId === undefined ? {} : { areaId: input.areaId }),
          ...(input.projectId === undefined ? {} : { projectId: input.projectId })
        })
      return templates.create({
        id: randomUUID(),
        name: input.title,
        templateJson: JSON.stringify(template),
        icon: "✅",
        position: await templates.getNextPosition(),
        isRoutine: true,
        cadence: input.cadence,
        areaId: input.areaId ?? null,
        projectId: input.projectId ?? null
      })
    }
    return saveBoardPillarChange(this.db, this.scope, input)
  }
  async saveVisibility(actorId: string, boardId: string, input: VisibilityChange) {
    if (actorId !== this.scope.principal.id || boardId !== this.scope.boardId)
      return { status: "unchanged", result: "unavailable" } as const
    if (input.action === "goal-share") {
      let target = input.target
      if (!target && input.areaId) {
        const {
          rows: [area]
        } = await this.db.execute(
          sql`SELECT area.id,COALESCE(area.owner_board_id,legacy.id) AS board_id FROM areas AS area LEFT JOIN task_boards AS legacy ON legacy.storage_encoding='legacy_null_v1' WHERE area.id=${input.areaId}`
        )
        if (area) target = { kind: "area", boardId: String(area.board_id), areaId: input.areaId }
      }
      if (!target) return { status: "unchanged", result: "unavailable" } as const
      return changeGoalShare(this.db, this.scope, input.id, target, input.enabled)
    }
    const hierarchy = new HierarchyRepository(this.db, this.scope)
    if (input.entity === "area") {
      const retired = await hierarchy.retireAreaCommand(input.id)
      return { status: "unchanged", result: retired.ok ? "saved" : retired.errorCode } as const
    }
    const result =
      input.entity === "goal"
        ? await hierarchy.deleteGoal(input.id)
        : input.entity === "project"
          ? await hierarchy.deleteProject(input.id)
          : await new TemplateRepository(this.db, this.scope).delete(input.id).then(() => true)
    return { status: "unchanged", result: result ? "saved" : "unavailable" } as const
  }
}
