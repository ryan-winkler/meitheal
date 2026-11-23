import { journaledBoardCommandAck, boardScopeErrorResponse, withBoardScope } from "@lib/board-http"
import type { APIRoute } from "astro"
import { scopePermits } from "@domains/tasks/board-scope"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TemplateRepository } from "@domains/tasks/persistence/template-repository"
import { HierarchyRepository } from "@domains/tasks/persistence/hierarchy-repository"
import { apiJson, apiError } from "../../lib/api-response"
import { isValidTimezone } from "../../lib/date"
import { isFeatureEnabled } from "../../lib/feature-flags"
import { logApiError } from "../../lib/api-logger"
import { readStoredHouseholdTimezone } from "../../lib/task-queries"

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
    const validArea = async (value: unknown) => value == null || value === "" ||
      (typeof value === "string" && Boolean(await hierarchy.findAreaById(value)))

    const validProject = async (value: unknown) => value == null || value === "" ||
      (typeof value === "string" && Boolean(await hierarchy.findProjectById(value)))

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
        if (!await validArea(body.area_id) || !await validProject(body.project_id)) return apiError("Choose an existing Area and Project", 400)

        const rawCadence = body.cadence ?? body.frequency
        if (rawCadence !== undefined && (typeof rawCadence !== "string" || !VALID_ROUTINE_CADENCES.has(rawCadence))) {
          return apiError("cadence must be daily or weekly", 400)
        }
        const cadence = rawCadence === "weekly" ? "weekly" : "daily"
        const icon = typeof body.icon === "string" && body.icon.trim() ? body.icon.trim().slice(0, 32) : "check"

        const id = crypto.randomUUID()
        const position = await repo.getNextPosition()

        // Build template JSON with optional checklists
        const templateJson: Record<string, unknown> = {
          title: name,
          description: typeof body.description === "string" ? body.description : "",
          priority: typeof body.priority === "number" ? Math.min(5, Math.max(1, Math.round(body.priority))) : 3,
          labels: ["routine"],
          task_type: "task",
          area_id: body.area_id || null,
          project_id: body.project_id || null,
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
          areaId: typeof body.area_id === "string" && body.area_id ? body.area_id : null,
          projectId: typeof body.project_id === "string" && body.project_id ? body.project_id : null,
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
        if (!(await repo.findById(templateId))?.is_routine) return apiError("Routine not found", 404)

        const updates: Parameters<typeof repo.update>[1] = {}
        if (body.name !== undefined) {
          if (typeof body.name !== "string") return apiError("name must be a string", 400)
          const trimmed = body.name.trim()
          if (!trimmed) return apiError("name is required", 400)
          if (trimmed.length > 100) return apiError("name must be 100 characters or fewer", 400)
          updates.name = trimmed
        }
        if (body.icon !== undefined) {
          if (typeof body.icon !== "string" || !body.icon.trim() || body.icon.trim().length > 32) {
            return apiError("icon must be 1-32 characters", 400)
          }
          updates.icon = body.icon.trim()
        }
        const rawCadence = body.cadence !== undefined ? body.cadence : body.frequency
        if (rawCadence !== undefined) {
          if (typeof rawCadence !== "string" || !VALID_ROUTINE_CADENCES.has(rawCadence)) {
            return apiError("cadence must be daily or weekly", 400)
          }
          updates.cadence = rawCadence
        }

        // Rebuild template JSON if checklist or other template fields change
        if (body.templateJson && typeof body.templateJson === "object" && !Array.isArray(body.templateJson)) {
          const patch = body.templateJson as Record<string, unknown>
          if (!await validArea(patch.area_id) || !await validProject(patch.project_id)) return apiError("Choose an existing Area and Project", 400)
          if ("area_id" in patch) updates.areaId = typeof patch.area_id === "string" && patch.area_id ? patch.area_id : null
          if ("project_id" in patch) updates.projectId = typeof patch.project_id === "string" && patch.project_id ? patch.project_id : null
          updates.templatePatch = JSON.stringify(patch)
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
