import { journaledBoardCommandAck, boardScopeErrorResponse, withBoardScope } from "@lib/board-http"
import type { APIRoute } from "astro"
import { isValidEffortMinutes, isValidEffortType } from "@meitheal/domain-tasks"
import { scopePermits } from "@domains/tasks/board-scope"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TemplateRepository } from "@domains/tasks/persistence/template-repository"
import { HierarchyRepository } from "@domains/tasks/persistence/hierarchy-repository"
import { taskChecklistsJson, taskLabelsJson } from "@domains/tasks/task-creation-service"
import { apiJson, apiError } from "../../lib/api-response"
import { isValidTimezone } from "../../lib/date"
import { isFeatureEnabled } from "../../lib/feature-flags"
import { logApiError } from "../../lib/api-logger"
import { sanitize } from "../../lib/sanitize"
import { readStoredHouseholdTimezone } from "../../lib/task-queries"
import { mapEntityEmojiToTabler } from "../../lib/tabler-svg"

/**
 * Habits API — Routine Template Integration
 *
 * Routines (formerly "habits") are task templates with is_routine=1.
 * Completing a routine creates/completes a real task linked via source_template_id.
 *
 * GET  /api/habits — Get all routine templates with stats
 * POST /api/habits — Create, complete, update, or delete routines
 *
 * @domain domain-tasks (routines bounded context)
 * @kcs Routines are NOT isolated — they produce real tasks visible
 * across all views (Today, Kanban, Table, Upcoming).
 * @see docs/decisions/ADR-007-hierarchy-model.md
 */

const VALID_ROUTINE_CADENCES = new Set(["daily", "weekly"])
const ALLOWED_TEMPLATE_PATCH_KEYS = new Set([
  "title",
  "description",
  "priority",
  "labels",
  "checklists",
  "area_id",
  "project_id",
  "effort_minutes",
  "effort_type",
])

function resolveRoutineIcon(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 32) return null
  return mapEntityEmojiToTabler(trimmed)
}

async function resolveRequestTimezone(locals: App.Locals | undefined): Promise<string> {
  const tz = locals?.timezone?.trim() ?? ""
  return isValidTimezone(tz) ? tz : readStoredHouseholdTimezone()
}

export const GET: APIRoute = withBoardScope({ resource: "routine", action: "read" }, async ({ url, locals }, scope) => {
  if (!(await isFeatureEnabled("habits"))) {
    return apiError("Habit tracker is disabled in settings", 404)
  }
  try {
    await ensureSchema()
    const client = getPersistenceClient()
    const areaId = url.searchParams.get("area_id")
    if (areaId !== null && areaId !== "" && !await new HierarchyRepository(client, scope).findAreaById(areaId)) {
      return apiError("Area not found", 404)
    }
    const projectId = url.searchParams.get("project_id")
    if (projectId && !await new HierarchyRepository(client, scope).findProjectById(projectId)) return apiError("Project not found", 404)
    const timezone = await resolveRequestTimezone(locals)
    const habits = await new TemplateRepository(client, scope).getRoutinesWithStats(
      areaId || undefined,
      projectId || undefined,
      timezone,
    )
    return apiJson({ habits })
  } catch (error) {
    const scopeFailure = boardScopeErrorResponse(error)
    if (scopeFailure) return scopeFailure
    logApiError("habits", "GET error", error)
    return apiError("Failed to get habits")
  }
})

const routineBaseOperation = { resource: "routine", action: "read" } as const

const manageRoutine: Parameters<typeof withBoardScope>[1] = async ({ request, locals }, scope) => {
  if (!(await isFeatureEnabled("habits"))) {
    return apiError("Habit tracker is disabled in settings", 404)
  }
  try {
    await ensureSchema()
    const client = getPersistenceClient()
    const repo = new TemplateRepository(client, scope)
    const hierarchy = new HierarchyRepository(client, scope)
    const timezone = await resolveRequestTimezone(locals)
    const validatePlacement = async (areaVal: unknown, projectVal: unknown): Promise<{ ok: true; areaId: string | null; projectId: string | null } | { ok: false; message: string }> => {
      let areaId: string | null = null
      if (areaVal !== undefined && areaVal !== null && areaVal !== "") {
        if (typeof areaVal !== "string" || !(await hierarchy.findAreaById(areaVal))) {
          return { ok: false, message: "Choose an existing Area and Project" }
        }
        areaId = areaVal
      }
      let projectId: string | null = null
      if (projectVal !== undefined && projectVal !== null && projectVal !== "") {
        if (typeof projectVal !== "string") return { ok: false, message: "Choose an existing Area and Project" }
        const project = await hierarchy.findProjectById(projectVal)
        if (!project) return { ok: false, message: "Choose an existing Area and Project" }
        if (areaId && project.area_id !== areaId) {
          return { ok: false, message: "Choose a Project inside the selected Area" }
        }
        projectId = projectVal
      }
      return { ok: true, areaId, projectId }
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const action = String(body.action || "create")

    switch (action) {
      case "create": {
        if (!scopePermits(scope, { resource: "routine", action: "create" })) {
          return apiError("Your Board permissions do not allow creating Routines.", 403)
        }
        const name = String(body.name || "").trim()
        if (!name) return apiError("name is required", 400)
        if (name.length > 100) return apiError("name must be 100 characters or fewer", 400)
        const placement = await validatePlacement(body.area_id, body.project_id)
        if (!placement.ok) return apiError(placement.message, 400)

        const rawCadence = body.cadence ?? body.frequency
        if (rawCadence !== undefined && (typeof rawCadence !== "string" || !VALID_ROUTINE_CADENCES.has(rawCadence))) {
          return apiError("cadence must be daily or weekly", 400)
        }
        const cadence = rawCadence === "weekly" ? "weekly" : "daily"
        let icon = "check"
        if (body.icon !== undefined && body.icon !== null && !(typeof body.icon === "string" && !body.icon.trim())) {
          const resolvedIcon = resolveRoutineIcon(body.icon)
          if (!resolvedIcon) {
            return apiError("icon must be a supported Tabler icon name (1-32 characters)", 400)
          }
          icon = resolvedIcon
        }

        const id = crypto.randomUUID()
        const position = await repo.getNextPosition()

        // Build template JSON with optional checklists
        const templateJson: Record<string, unknown> = {
          title: name,
          description: typeof body.description === "string" ? body.description : "",
          priority: typeof body.priority === "number" ? Math.min(5, Math.max(1, Math.round(body.priority))) : 3,
          labels: ["routine"],
          task_type: "task",
          area_id: placement.areaId,
          project_id: placement.projectId,
        }

        // Checklists: array of { text, done } items
        if (Array.isArray(body.checklists)) {
          templateJson.checklists = (body.checklists as Array<{ text?: string }>)
            .filter(item => item && typeof item.text === "string" && item.text.trim())
            .map(item => ({ text: String(item.text).trim(), done: false }))
        }

        const inserted = await repo.create({
          id,
          name,
          templateJson: JSON.stringify(templateJson),
          icon,
          position,
          isRoutine: true,
          cadence,
          areaId: placement.areaId,
          projectId: placement.projectId,
        })
        if (!inserted) return apiError("Choose an existing Area", 400)

        return apiJson({ id, name, icon, cadence, position }, 201)
      }

      case "complete": {
        if (!scopePermits(scope, { resource: "routine", action: "read" }) ||
            !scopePermits(scope, { resource: "task", action: "create" }) ||
            !scopePermits(scope, { resource: "task", action: "complete" })) {
          return apiError("Your Board permissions do not allow completing Routines.", 403)
        }
        const templateId = String(body.templateId || body.habitId || "")
        if (!templateId) return apiError("templateId is required", 400)
        const existing = await repo.findById(templateId)
        if (!existing || !existing.is_routine) return apiError("Routine not found", 404)
        const result = await repo.completeRoutineWithOutcome(templateId, undefined, timezone)
        let gamification: Record<string, unknown> | undefined
        if (result.newlyCompleted) {
          try {
            if (await isFeatureEnabled("gamification")) {
              let routinePriority = 3
              try {
                const tpl = JSON.parse(String(existing.template_json)) as { priority?: unknown }
                if (typeof tpl.priority === "number") routinePriority = tpl.priority
              } catch { /* fallback default priority */ }
              const { recordTaskCompletion, getXpForPriority, checkAchievements, getLevel } = await import("@domains/gamification")
              const xp = getXpForPriority(routinePriority)
              const stats = await recordTaskCompletion(scope, xp, new Date(), timezone)
              if (stats) {
                const achievements = await checkAchievements(scope, stats)
                gamification = { stats, xp, newAchievements: achievements.newlyUnlocked, level: getLevel(stats.totalPoints), confetti: await isFeatureEnabled("confetti") }
              }
            }
          } catch { /* completion persisted; optional XP is best-effort */ }
        }
        return apiJson({
          taskId: result.taskId,
          alreadyExisted: result.alreadyExisted,
          completed: result.completed,
          newlyCompleted: result.newlyCompleted,
          ...(gamification ? { gamification } : {}),
        })
      }

      case "update": {
        if (!scopePermits(scope, { resource: "routine", action: "edit" })) {
          return apiError("Your Board permissions do not allow editing Routines.", 403)
        }
        const templateId = String(body.templateId || "")
        if (!templateId) return apiError("templateId is required", 400)
        const existingRoutine = await repo.findById(templateId)
        if (!existingRoutine?.is_routine) return apiError("Routine not found", 404)

        const updates: Parameters<typeof repo.update>[1] = {}
        if (body.name !== undefined) {
          if (typeof body.name !== "string") return apiError("name must be a string", 400)
          const trimmed = body.name.trim()
          if (!trimmed) return apiError("name is required", 400)
          if (trimmed.length > 100) return apiError("name must be 100 characters or fewer", 400)
          updates.name = trimmed
        }
        if (body.icon !== undefined) {
          const resolvedIcon = resolveRoutineIcon(body.icon)
          if (!resolvedIcon) {
            return apiError("icon must be a supported Tabler icon name (1-32 characters)", 400)
          }
          updates.icon = resolvedIcon
        }
        const rawCadence = body.cadence !== undefined ? body.cadence : body.frequency
        if (rawCadence !== undefined) {
          if (typeof rawCadence !== "string" || !VALID_ROUTINE_CADENCES.has(rawCadence)) {
            return apiError("cadence must be daily or weekly", 400)
          }
          updates.cadence = rawCadence
        }

        // Rebuild template JSON with full validation for whitelisted template fields
        if (body.templateJson !== undefined) {
          if (!body.templateJson || typeof body.templateJson !== "object" || Array.isArray(body.templateJson)) {
            return apiError("templateJson must be an object", 400)
          }
          const rawPatch = body.templateJson as Record<string, unknown>
          const patch: Record<string, unknown> = {}
          for (const key of Object.keys(rawPatch)) {
            if (ALLOWED_TEMPLATE_PATCH_KEYS.has(key)) patch[key] = rawPatch[key]
          }
          if ("title" in patch) {
            if (typeof patch.title !== "string") return apiError("templateJson.title must be a string", 400)
            const cleanTitle = sanitize(patch.title.trim())
            if (!cleanTitle) return apiError("templateJson.title is required", 400)
            if (cleanTitle.length > 100) return apiError("templateJson.title must be 100 characters or fewer", 400)
            patch.title = cleanTitle
            if (updates.name === undefined) updates.name = cleanTitle
          }
          if ("description" in patch) {
            if (typeof patch.description !== "string" || patch.description.length > 10000) {
              return apiError("templateJson.description must be a string of 10000 characters or fewer", 400)
            }
            patch.description = sanitize(patch.description)
          }
          if ("priority" in patch) {
            if (typeof patch.priority !== "number" || !Number.isFinite(patch.priority)) {
              return apiError("templateJson.priority must be a number from 1 to 5", 400)
            }
            patch.priority = Math.min(5, Math.max(1, Math.round(patch.priority)))
          }
          if ("labels" in patch) {
            const labelsJson = taskLabelsJson(patch.labels)
            if (labelsJson === null) return apiError("templateJson.labels must be a string array", 400)
            patch.labels = JSON.parse(labelsJson)
          }
          if ("checklists" in patch) {
            const clRes = taskChecklistsJson(patch.checklists, false)
            if (!clRes.ok) return apiError(clRes.error, 400)
            const parsedCl = JSON.parse(clRes.json) as Array<{ text: string; done?: boolean }>
            const cleanedCl: Array<{ text: string; done: boolean }> = []
            for (const item of parsedCl) {
              const text = sanitize(item.text.trim())
              if (!text) return apiError("checklist items must have non-empty text", 400)
              cleanedCl.push({ text, done: Boolean(item.done) })
            }
            patch.checklists = cleanedCl
          }
          if (
            "effort_minutes" in patch &&
            patch.effort_minutes !== null &&
            (typeof patch.effort_minutes !== "number" || !isValidEffortMinutes(patch.effort_minutes))
          ) {
            return apiError("templateJson.effort_minutes must be null or a positive integer <= 480", 400)
          }
          if ("effort_type" in patch) {
            if (patch.effort_type !== null) {
              if (typeof patch.effort_type !== "string" || !isValidEffortType(patch.effort_type.trim().toLowerCase())) {
                return apiError("templateJson.effort_type must be null, deep, shallow, or admin", 400)
              }
              patch.effort_type = patch.effort_type.trim().toLowerCase()
            }
          }
          let existingParsed: Record<string, unknown> = {}
          try {
            const parsed = JSON.parse(String(existingRoutine.template_json ?? "{}"))
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existingParsed = parsed as Record<string, unknown>
          } catch { /* ignore */ }
          const areaCandidate = "area_id" in patch ? patch.area_id : existingParsed.area_id
          const projectCandidate = "project_id" in patch ? patch.project_id : existingParsed.project_id
          const placement = await validatePlacement(areaCandidate, projectCandidate)
          if (!placement.ok) return apiError(placement.message, 400)
          if ("area_id" in patch) {
            patch.area_id = placement.areaId
            updates.areaId = placement.areaId
          }
          if ("project_id" in patch) {
            patch.project_id = placement.projectId
            updates.projectId = placement.projectId
          }
          if (Object.keys(patch).length > 0) updates.templatePatch = JSON.stringify(patch)
        }

        if (!await repo.update(templateId, updates)) return apiError("Routine or Area no longer available", 409)
        return apiJson({ ok: true })
      }

      case "delete": {
        if (!scopePermits(scope, { resource: "routine", action: "delete" })) {
          return apiError("Your Board permissions do not allow deleting Routines.", 403)
        }
        const templateId = String(body.templateId || body.habitId || "")
        if (!templateId) return apiError("templateId is required", 400)
        if (!(await repo.findById(templateId))?.is_routine) return apiError("Routine not found", 404)
        await repo.delete(templateId)
        return journaledBoardCommandAck(scope, routineBaseOperation)
      }

      default:
        return apiError("Invalid action. Use: create, complete, update, delete", 400)
    }
  } catch (error) {
    const scopeFailure = boardScopeErrorResponse(error)
    if (scopeFailure) return scopeFailure
    logApiError("habits", "POST error", error)
    return apiError("Failed to manage habit")
  }
}

export const POST: APIRoute = withBoardScope(routineBaseOperation, manageRoutine, { write: true })
