import { journaledBoardCommandAck, boardScopeErrorResponse } from "@lib/board-http"
import { withBoardScope } from "@lib/board-http"
import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TemplateRepository } from "@domains/tasks/persistence/template-repository"
import { HierarchyRepository } from "@domains/tasks/persistence/hierarchy-repository"
import { apiJson, apiError } from "../../lib/api-response"
import { isFeatureEnabled } from "../../lib/feature-flags"
import { logApiError } from "../../lib/api-logger"

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

export const GET: APIRoute = withBoardScope({ resource: "routine", action: "read" }, async ({ url }, scope) => {
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
    const habits = await new TemplateRepository(client, scope).getRoutinesWithStats(areaId || undefined, projectId || undefined)
    return apiJson({ habits })
  } catch (error) {
    const scopeFailure = boardScopeErrorResponse(error)
    if (scopeFailure) return scopeFailure
    logApiError("habits", "GET error", error)
    return apiError("Failed to get habits")
  }
})

const manageRoutine: Parameters<typeof withBoardScope>[1] = async ({ request }, scope) => {
  if (!(await isFeatureEnabled("habits"))) {
    return apiError("Habit tracker is disabled in settings", 404)
  }
  try {
    await ensureSchema()
    const client = getPersistenceClient()
    const repo = new TemplateRepository(client, scope)
    const hierarchy = new HierarchyRepository(client, scope)
    const validArea = async (value: unknown) => value == null || value === "" ||
      (typeof value === "string" && Boolean(await hierarchy.findAreaById(value)))

    const validProject = async (value: unknown) => value == null || value === "" ||
      (typeof value === "string" && Boolean(await hierarchy.findProjectById(value)))

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const action = String(body.action || "create")

    switch (action) {
      case "create": {
        const name = String(body.name || "").trim()
        if (!name) return apiError("name is required", 400)
        if (name.length > 100) return apiError("name must be 100 characters or fewer", 400)
        if (!await validArea(body.area_id) || !await validProject(body.project_id)) return apiError("Choose an existing Area and Project", 400)

        const id = crypto.randomUUID()
        const position = await repo.getNextPosition()
        const icon = typeof body.icon === "string" ? body.icon : "✅"
        const cadence = (body.cadence ?? body.frequency) === "weekly" ? "weekly" : "daily"

        // Build template JSON with optional checklists
        const templateJson: Record<string, unknown> = {
          title: name,
          description: typeof body.description === "string" ? body.description : "",
          priority: typeof body.priority === "number" ? body.priority : 3,
          labels: ["routine"],
          task_type: "task",
          area_id: body.area_id || null,
          project_id: body.project_id || null,
        }

        // Checklists: array of { text, done } items
        if (Array.isArray(body.checklists)) {
          templateJson.checklists = (body.checklists as Array<{ text?: string }>)
            .filter(item => item.text && typeof item.text === "string")
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
        const templateId = String(body.templateId || body.habitId || "")
        if (!templateId) return apiError("templateId is required", 400)
        const existing = await repo.findById(templateId)
        if (!existing || !existing.is_routine) return apiError("Routine not found", 404)
        const result = await repo.completeRoutine(templateId)
        return apiJson(result)
      }

      case "update": {
        const templateId = String(body.templateId || "")
        if (!templateId) return apiError("templateId is required", 400)
        if (!(await repo.findById(templateId))?.is_routine) return apiError("Routine not found", 404)

        const updates: Parameters<typeof repo.update>[1] = {}
        if (typeof body.name === "string") updates.name = body.name.trim()
        if (typeof body.icon === "string") updates.icon = body.icon
        if (typeof body.cadence === "string") updates.cadence = body.cadence
        else if (typeof body.frequency === "string") updates.cadence = body.frequency

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
        const templateId = String(body.templateId || body.habitId || "")
        if (!templateId) return apiError("templateId is required", 400)
        if (!(await repo.findById(templateId))?.is_routine) return apiError("Routine not found", 404)
        await repo.delete(templateId)
        return journaledBoardCommandAck(scope, { resource: "routine", action: "delete" })
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

export const POST: APIRoute = async context => {
  const body = await context.request.clone().json().catch(() => null) as Record<string, unknown> | null
  const action = body?.action === "delete" ? "delete" : body?.action === "complete" ? "read" : body?.action === "update" ? "edit" : "create"
  return withBoardScope({ resource: "routine", action }, manageRoutine, { write: true })(context)
}
