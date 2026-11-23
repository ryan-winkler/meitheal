import { randomUUID } from "node:crypto"
import { routinePeriod } from "../routine-period"
import type { Client, InValue } from "@libsql/client"
import {
  requireBoardScope,
  validateBoardScope,
  type BoardScope,
  type WorkAction
} from "../board-scope"
import { validateBoardPlacement } from "../board-access-service"
import { prepareTaskCreation } from "../task-creation-service"
import { boardOperationClient, requireBoardWriterIntent, requireBoardWriterCheck, BoardOperationError } from "./board-operation-client"
import { ownedPlanning, storageBoardId } from "./board-storage"
import { sql, sourceSql } from "./sql-fragment"
import { TaskRepository } from "./task-repository"
import { changeBoardGrants } from "./board-grant-fence"
import { scopedTaskRead } from "./board-work-query"

export interface RoutineTemplateRow {
  id: string
  name: string
  template_json: string
  icon: string
  cadence: string
  position: number
  /** Number of streak freezes consumed this cycle */
  streak_freezes_used: number
  /** Maximum allowed streak freezes per cycle (default 3) */
  streak_freeze_limit: number
  created_at: number
  updated_at: number
}

/** @deprecated Use RoutineTemplateRow — ADR-007 ubiquitous language */
export type HabitTemplateRow = RoutineTemplateRow

export interface RoutineWithStats extends RoutineTemplateRow {
  boardId: string
  todayCompleted: boolean
  todayTaskId: string | null
  lastCompletedDate: string | null
  currentStreak: number
  longestStreak: number
  totalCompletions: number
  projectActive: boolean
  checklists: Array<{ text: string; done: boolean }>
}

/** @deprecated Use RoutineWithStats — ADR-007 ubiquitous language */
export type HabitWithStats = RoutineWithStats

type TemplateInput = {
  id: string
  name: string
  templateJson: string
  icon: string
  position: number
  isRoutine?: boolean
  cadence?: string
  areaId?: string | null | undefined
  projectId?: string | null | undefined
  isHabit?: boolean
  frequency?: string
}
type TemplatePatch = Partial<Omit<TemplateInput, "id" | "position" | "isHabit" | "isRoutine">> & {
  templatePatch?: string
  streak_freezes_used?: number
  streak_freeze_limit?: number
}

export const ROUTINE_NEWLY_COMPLETED = Symbol("routineNewlyCompleted")

export type RoutineCompletionOutcome = {
  taskId: string
  alreadyExisted: boolean
  completed: boolean
  [ROUTINE_NEWLY_COMPLETED]?: boolean
}

export { routinePeriod } from "../routine-period"

function templateObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Template must contain a JSON object")
  return parsed as Record<string, unknown>
}

export class TemplateRepository {
  constructor(
    private readonly client: Client,
    readonly scope: BoardScope
  ) {
    requireBoardScope(scope)
  }
  private db(action: WorkAction, routine = true) {
    return boardOperationClient(this.client, this.scope, {
      resource: routine ? "routine" : "task",
      action
    })
  }
  async findAll() {
    const tx = await this.db("read", false).transaction("read")
    try {
      const { rows } = await tx.execute(
        sql`SELECT * FROM task_templates AS template WHERE ${ownedPlanning(this.scope, "template")} AND retired_at IS NULL ORDER BY position,created_at,id`
      )
      const result = []
      for (const row of rows) if (await this.visible(tx, row)) result.push(row)
      await tx.commit()
      return result
    } finally {
      tx.close()
    }
  }
  async findById(id: string) {
    const tx = await this.db("read", false).transaction("read")
    try {
      const {
        rows: [row]
      } = await tx.execute(
        sql`SELECT * FROM task_templates AS template WHERE ${ownedPlanning(this.scope, "template")} AND template.id=${id} AND retired_at IS NULL`
      )
      const result = row && (await this.visible(tx, row)) ? (row as Record<string, unknown>) : null
      await tx.commit()
      return result
    } finally {
      tx.close()
    }
  }
  private async visible(
    db: Pick<Client, "execute">,
    row: Record<string, unknown>
  ): Promise<boolean> {
    if (
      row.is_routine === 1 &&
      !(await validateBoardScope(this.scope, db, { resource: "routine", action: "read" })).ok
    )
      return false
    const data = templateObject(String(row.template_json))
    return validateBoardPlacement(this.scope, db, {
      areaId: typeof data.area_id === "string" ? data.area_id : null,
      projectId: typeof data.project_id === "string" ? data.project_id : null
    })
  }
  async getNextPosition(): Promise<number> {
    const {
      rows: [row]
    } = await this.db("read", false).execute(
      sql`SELECT COALESCE(MAX(position),-1)+1 AS position FROM task_templates AS template WHERE ${ownedPlanning(this.scope, "template")}`
    )
    return Number(row?.position ?? 0)
  }
  private async placement(db: Pick<Client, "execute">, template: Record<string, unknown>) {
    let areaId = typeof template.area_id === "string" && template.area_id ? template.area_id : null
    const projectId =
      typeof template.project_id === "string" && template.project_id ? template.project_id : null
    if (projectId) {
      const {
        rows: [project]
      } = await db.execute(
        sql`SELECT area_id FROM projects AS project WHERE id = ${projectId} AND ${ownedPlanning(this.scope, "project")} AND retired_at IS NULL`
      )
      if (!project || (areaId && project.area_id !== areaId))
        throw new BoardOperationError("unavailable")
      if (!areaId && typeof project.area_id === "string") areaId = project.area_id
    }
    if (areaId) {
      const { rows } = await db.execute(
        sql`SELECT id FROM areas AS area WHERE id = ${areaId} AND ${ownedPlanning(this.scope, "area")} AND retired_at IS NULL`
      )
      if (!rows.length) throw new BoardOperationError("unavailable")
    }
    if (!(await validateBoardPlacement(this.scope, db, { areaId, projectId })))
      throw new BoardOperationError("unavailable")
    return { ...template, area_id: areaId, project_id: projectId }
  }
  async create(data: TemplateInput): Promise<boolean> {
    const routine = data.isRoutine ?? data.isHabit ?? false
    const db = this.db("create", routine)
    const tx = await db.transaction("write")
    try {
      const input = templateObject(data.templateJson)
      if (data.areaId !== undefined) input.area_id = data.areaId
      if (data.projectId !== undefined) input.project_id = data.projectId
      const template = await this.placement(tx, input)
      const now = Date.now()
      const result =
        await tx.execute(sql`INSERT INTO task_templates(id,name,template_json,icon,is_routine,cadence,position,created_at,updated_at,owner_board_id)
        VALUES (${data.id},${data.name},${JSON.stringify(template)},${data.icon},${routine ? 1 : 0},${data.cadence ?? data.frequency ?? "daily"},${data.position},${now},${now},${storageBoardId(this.scope)})`)
      await tx.commit()
      return result.rowsAffected > 0
    } finally {
      tx.close()
    }
  }
  async update(id: string, data: TemplatePatch): Promise<boolean> {
    const current = await this.findById(id)
    if (!current) return false
    const tx = await this.db("edit", Boolean(current.is_routine)).transaction("write")
    try {
      const {
        rows: [fresh]
      } = await tx.execute(
        sql`SELECT * FROM task_templates AS template WHERE id=${id} AND ${ownedPlanning(this.scope, "template")} AND retired_at IS NULL`
      )
      if (!fresh || !await this.visible(tx, fresh)) return false
      await requireBoardWriterIntent(tx, this.scope, { resource: fresh.is_routine ? "routine" : "task", action: "edit" })
      await requireBoardWriterCheck(tx, this.scope, async () => {
        if (!await this.visible(tx, fresh)) throw new BoardOperationError("unavailable")
      })
      let template = templateObject(data.templateJson ?? String(fresh.template_json))
      if (data.templatePatch !== undefined)
        template = { ...template, ...templateObject(data.templatePatch) }
      if (typeof data.name === "string" && data.name.trim()) template.title = data.name.trim()
      if (data.areaId !== undefined) template.area_id = data.areaId
      if (data.projectId !== undefined) template.project_id = data.projectId
      template = await this.placement(tx, template)
      const sets = [sql`template_json=${JSON.stringify(template)}`, sql`updated_at=${Date.now()}`]
      for (const [key, value] of Object.entries({
        name: data.name,
        icon: data.icon,
        cadence: data.cadence ?? data.frequency,
        streak_freezes_used: data.streak_freezes_used,
        streak_freeze_limit: data.streak_freeze_limit
      })) {
        if (value !== undefined) sets.push(sql`${sourceSql(key)}=${value}`)
      }
      const { joinSql } = await import("./sql-fragment")
      const result = await tx.execute(
        sql`UPDATE task_templates SET ${joinSql(sets)} WHERE id=${id} AND ${ownedPlanning(this.scope, "task_templates")}`
      )
      await tx.commit()
      return result.rowsAffected > 0
    } finally {
      tx.close()
    }
  }
  async delete(id: string): Promise<void> {
    const current = await this.findById(id)
    if (!current) return
    const result = await changeBoardGrants(this.client, this.scope.principal, async (tx) => {
      const { rows: [fresh] } = await tx.execute(sql`SELECT * FROM task_templates AS template
        WHERE id=${id} AND ${ownedPlanning(this.scope, "template")} AND retired_at IS NULL`)
      if (!fresh || !await this.visible(tx, fresh)) return { unchanged: false }
      const allowed = await validateBoardScope(this.scope, tx, {
        resource: fresh.is_routine ? "routine" : "task",
        action: "delete"
      })
      if (!allowed.ok) throw new BoardOperationError(allowed.errorCode)
      const changed = await tx.execute(
        sql`UPDATE task_templates SET retired_at=${Date.now()},updated_at=${Date.now()} WHERE id=${id} AND ${ownedPlanning(this.scope, "task_templates")} AND retired_at IS NULL`
      )
      return changed.rowsAffected ? { next: true } : { unchanged: false }
    })
    if (result.status === "locked") throw new BoardOperationError("continuity_locked")
  }
  async findRoutines(areaId?: string, projectId?: string): Promise<RoutineTemplateRow[]> {
    const filter = areaId
      ? sql`AND json_extract(template_json,'$.area_id')=${areaId}`
      : sourceSql("")
    const project = projectId
      ? sql`AND json_extract(template_json,'$.project_id')=${projectId}`
      : sourceSql("")
    const tx = await this.db("read").transaction("read")
    try {
      const { rows } = await tx.execute(
        sql`SELECT * FROM task_templates AS template WHERE ${ownedPlanning(this.scope, "template")} AND is_routine=1 AND retired_at IS NULL ${filter} ${project} ORDER BY position,created_at,id`
      )
      const visible = []
      for (const row of rows) if (await this.visible(tx, row)) visible.push(row)
      await tx.commit()
      return visible.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        template_json: String(row.template_json),
        icon: String(row.icon),
        cadence: String(row.cadence ?? row.frequency ?? "daily"),
        position: Number(row.position),
        streak_freezes_used: Number(row.streak_freezes_used ?? 0),
        streak_freeze_limit: Number(row.streak_freeze_limit ?? 3),
        created_at: Number(row.created_at),
        updated_at: Number(row.updated_at)
      }))
    } finally {
      tx.close()
    }
  }
  async findHabits() {
    return this.findRoutines()
  }
  async getRoutinesWithStats(areaId?: string, projectId?: string, timezone = "UTC"): Promise<RoutineWithStats[]> {
    const routines = await this.findRoutines(areaId, projectId)
    if (routines.length === 0) return []
    const routineIds = routines.map((r) => r.id)
    const parsedBodies = new Map<string, Record<string, unknown>>()
    const projectIds = new Set<string>()
    for (const routine of routines) {
      const body = templateObject(routine.template_json)
      parsedBodies.set(routine.id, body)
      if (typeof body.project_id === "string" && body.project_id) projectIds.add(body.project_id)
    }
    const batchQueries = [
      scopedTaskRead(
        this.scope,
        sql`SELECT id,source_template_id,status,due_date FROM scoped_tasks WHERE source_template_id IN (SELECT value FROM json_each(${JSON.stringify(routineIds)})) ORDER BY due_date DESC,created_at DESC`
      ),
      ...(projectIds.size > 0
        ? [
            sql`SELECT id FROM projects AS project WHERE id IN (SELECT value FROM json_each(${JSON.stringify([...projectIds])})) AND ${ownedPlanning(this.scope, "project")} AND retired_at IS NULL AND status='active'`
          ]
        : [])
    ]
    const [taskRes, projectRes] = await this.db("read").batch(batchQueries, "read")
    const tasksByRoutine = new Map<string, Array<Record<string, unknown>>>()
    for (const row of taskRes?.rows ?? []) {
      const tplId = String(row.source_template_id ?? "")
      const list = tasksByRoutine.get(tplId) ?? []
      list.push(row as Record<string, unknown>)
      tasksByRoutine.set(tplId, list)
    }
    const activeProjectIds = new Set((projectRes?.rows ?? []).map((row) => String(row.id)))
    const now = new Date()
    const result: RoutineWithStats[] = []
    for (const routine of routines) {
      const period = routinePeriod(routine.cadence, now, timezone)
      const rows = tasksByRoutine.get(routine.id) ?? []
      const today = rows.find((row) => row.due_date === period)
      const completed = rows.filter((row) => row.status === "complete")
      const dates = [
        ...new Set(
          completed
            .map((row) => String(row.due_date))
            .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
        )
      ]
        .sort()
        .reverse()
      const dayStep = routine.cadence === "weekly" ? 7 : 1
      let longest = 0,
        streak = 0,
        previous: number | undefined
      for (const date of dates) {
        const time = Date.parse(date)
        streak = previous !== undefined && previous - time === dayStep * 86400000 ? streak + 1 : 1
        longest = Math.max(longest, streak)
        previous = time
      }
      let current = 0,
        expected = Date.parse(period)
      if (dates[0] && Date.parse(dates[0]) === expected - dayStep * 86400000)
        expected -= dayStep * 86400000
      for (const date of dates) {
        if (Date.parse(date) !== expected) break
        current++
        expected -= dayStep * 86400000
      }
      const body = parsedBodies.get(routine.id) ?? {}
      const linkedProjectId = typeof body.project_id === "string" && body.project_id ? body.project_id : null
      const projectActive = !linkedProjectId || activeProjectIds.has(linkedProjectId)
      result.push({
        ...routine,
        boardId: this.scope.boardId,
        projectActive,
        todayCompleted: today?.status === "complete",
        todayTaskId: today ? String(today.id) : null,
        lastCompletedDate: dates[0] ?? null,
        currentStreak: current,
        longestStreak: longest,
        totalCompletions: completed.length,
        checklists: Array.isArray(body.checklists)
          ? (body.checklists as Array<{ text: string; done: boolean }>)
          : []
      })
    }
    return result
  }
  async getHabitsWithStats(areaId?: string, projectId?: string, timezone = "UTC") {
    return this.getRoutinesWithStats(areaId, projectId, timezone)
  }
  private async createTaskWithOutcome(
    taskId: string,
    template: Record<string, unknown>,
    routine?: {
      templateId: string
      period: string
      expectedTemplateJson: string
      expectedCadence: string
      complete?: boolean
      timezone?: string
    },
    templateSnapshot?: { templateId: string; expectedTemplateJson: string }
  ) {
    const repo = new TaskRepository(this.client, this.scope)
    const stored = routine ?? templateSnapshot
    let labels = template.labels
    let storedLabels: string | undefined
    if (stored) {
      const {
        rows: [raw]
      } = await this.db("read", false).execute(
        sql`SELECT json_extract(${stored.expectedTemplateJson}, '$.labels') AS labels`
      )
      if (typeof raw?.labels === "string") {
        try {
          const entries: unknown = JSON.parse(raw.labels)
          if (
            Array.isArray(entries) &&
            entries.every(
              (entry) =>
                typeof entry === "string" ||
                (entry !== null &&
                  typeof entry === "object" &&
                  !Array.isArray(entry) &&
                  typeof entry.name === "string")
            )
          ) {
            labels = entries.map((entry) => (typeof entry === "string" ? entry : entry.name))
            storedLabels = raw.labels
          }
        } catch {
          /* Native validation handles malformed historical selections. */
        }
      }
    }
    const rawChecklists = Array.isArray(template.checklists)
      ? template.checklists.map((item) =>
          item && typeof item === "object" && !Array.isArray(item)
            ? { ...item, ...(routine?.complete ? { done: true } : {}) }
            : item
        )
      : template.checklists
    const prepared = await prepareTaskCreation(
      repo,
      {
        ...template,
        ...(labels === undefined ? {} : { labels }),
        area_id: template.area_id ?? null,
        status: routine?.complete ? "complete" : "pending",
        custom_fields:
          typeof template.custom_fields === "string"
            ? template.custom_fields
            : JSON.stringify(template.custom_fields ?? {}),
        checklists:
          typeof rawChecklists === "string"
            ? rawChecklists
            : JSON.stringify(rawChecklists ?? []),
        ...(routine ? { task_kind: "routine_instance", due_date: routine.period } : {})
      },
      { id: taskId }
    )
    if (!prepared.ok) throw new Error(prepared.error)
    if (storedLabels !== undefined) prepared.task.labels = storedLabels
    const result = await repo.createWorkCommand(prepared.task, {
      ...(routine ? { routineOccurrence: routine } : {}),
      ...(templateSnapshot ? { templateSnapshot } : {})
    })
    if (!result.ok) {
      if (result.errorCode === "conflict") throw new BoardOperationError("stale")
      throw new BoardOperationError(result.errorCode === "denied" ? "denied" : "unavailable")
    }
    const out: RoutineCompletionOutcome = {
      taskId: String(result.task.id),
      alreadyExisted: result.replayed,
      completed: result.task.status === "complete",
    }
    Object.defineProperty(out, ROUTINE_NEWLY_COMPLETED, {
      value: result.newlyCompleted,
      enumerable: false,
      configurable: true,
    })
    return { ...out, newlyCompleted: result.newlyCompleted }
  }
  private async createTask(
    taskId: string,
    template: Record<string, unknown>,
    routine?: {
      templateId: string
      period: string
      expectedTemplateJson: string
      expectedCadence: string
      complete?: boolean
      timezone?: string
    },
    templateSnapshot?: { templateId: string; expectedTemplateJson: string }
  ): Promise<RoutineCompletionOutcome> {
    const { newlyCompleted, ...legacyShape } = await this.createTaskWithOutcome(
      taskId,
      template,
      routine,
      templateSnapshot
    )
    Object.defineProperty(legacyShape, ROUTINE_NEWLY_COMPLETED, {
      value: newlyCompleted,
      enumerable: false,
      configurable: true,
    })
    return legacyShape
  }
  async instantiateFromTemplate(
    taskId: string,
    template: Record<string, unknown>,
    sourceTemplateId?: string
  ): Promise<void> {
    // Recover metadata only from a current owned template. Two-argument server
    // callers retain strict native creation when no matching saved template exists.
    const rows = sourceTemplateId
      ? [await this.findById(sourceTemplateId)].filter((row) => row !== null)
      : await this.findAll()
    const matching = rows.filter(
      (row) =>
        JSON.stringify(templateObject(String(row.template_json))) === JSON.stringify(template)
    )
    if (sourceTemplateId && matching.length !== 1) throw new Error("Template changed")
    const row = matching.length === 1 ? matching[0] : undefined
    await this.createTask(
      taskId,
      template,
      undefined,
      row
        ? { templateId: String(row.id), expectedTemplateJson: String(row.template_json) }
        : undefined
    )
  }
  async instantiateRoutineTask(templateId: string, timezone = "UTC") {
    const row = await this.findById(templateId)
    if (!row || !row.is_routine) throw new Error("Routine is unavailable")
    const body = templateObject(String(row.template_json))
    body.title ??= row.name
    if (Array.isArray(body.checklists))
      body.checklists = body.checklists.map((item) => ({ ...item, done: false }))
    return this.createTask(randomUUID(), body, {
      templateId,
      period: routinePeriod(String(row.cadence ?? "daily"), new Date(), timezone),
      expectedTemplateJson: String(row.template_json),
      expectedCadence: String(row.cadence ?? "daily"),
      timezone
    })
  }
  async completeRoutine(templateId: string, requestedPeriod?: string, timezone = "UTC") {
    await this.db("read").execute(
      sql`SELECT id FROM task_templates AS template WHERE id=${templateId} AND ${ownedPlanning(this.scope, "template")} AND is_routine=1 AND retired_at IS NULL`
    )
    const row = await this.findById(templateId)
    if (!row || !row.is_routine) throw new Error("Routine is unavailable")
    const body = templateObject(String(row.template_json))
    body.title ??= row.name
    return this.createTask(randomUUID(), body, {
      templateId,
      period: requestedPeriod ?? routinePeriod(String(row.cadence ?? "daily"), new Date(), timezone),
      expectedTemplateJson: String(row.template_json),
      expectedCadence: String(row.cadence ?? "daily"),
      complete: true,
      timezone
    })
  }
  async completeRoutineWithOutcome(templateId: string, requestedPeriod?: string, timezone = "UTC") {
    await this.db("read").execute(
      sql`SELECT id FROM task_templates AS template WHERE id=${templateId} AND ${ownedPlanning(this.scope, "template")} AND is_routine=1 AND retired_at IS NULL`
    )
    const row = await this.findById(templateId)
    if (!row || !row.is_routine) throw new Error("Routine is unavailable")
    const body = templateObject(String(row.template_json))
    body.title ??= row.name
    return this.createTaskWithOutcome(randomUUID(), body, {
      templateId,
      period: requestedPeriod ?? routinePeriod(String(row.cadence ?? "daily"), new Date(), timezone),
      expectedTemplateJson: String(row.template_json),
      expectedCadence: String(row.cadence ?? "daily"),
      complete: true,
      timezone
    })
  }
  async instantiateHabitTask(templateId: string) {
    return this.instantiateRoutineTask(templateId)
  }
}
