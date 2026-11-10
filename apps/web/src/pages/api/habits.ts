import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TemplateRepository } from "@domains/tasks/persistence/template-repository"
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

export const GET: APIRoute = async () => {
  if (!(await isFeatureEnabled("habits"))) {
    return apiError("Habit tracker is disabled in settings", 404)
  }
  try {
    await ensureSchema()
    const repo = new TemplateRepository(getPersistenceClient())
    const habits = await repo.getRoutinesWithStats()
    return apiJson({ habits })
  } catch (error) {
    logApiError("habits", "GET error", error)
    return apiError("Failed to get habits")
  }
}

export const POST: APIRoute = async ({ request }) => {
  if (!(await isFeatureEnabled("habits"))) {
    return apiError("Habit tracker is disabled in settings", 404)
  }
  try {
    await ensureSchema()
    const repo = new TemplateRepository(getPersistenceClient())

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const action = String(body.action || "create")

    switch (action) {
      case "create": {
        const name = String(body.name || "").trim()
        if (!name) return apiError("name is required", 400)
        if (name.length > 100) return apiError("name must be 100 characters or fewer", 400)

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
        }

        // Checklists: array of { text, done } items
        if (Array.isArray(body.checklists)) {
          templateJson.checklists = (body.checklists as Array<{ text?: string }>)
            .filter(item => item.text && typeof item.text === "string")
            .map(item => ({ text: String(item.text).trim(), done: false }))
        }

        await repo.create({
          id,
          name,
          templateJson: JSON.stringify(templateJson),
          icon,
          position,
          isRoutine: true,
          cadence,
        })

        return apiJson({ id, name, icon, cadence, position }, 201)
      }

      case "complete": {
        const templateId = String(body.templateId || body.habitId || "")
        if (!templateId) return apiError("templateId is required", 400)

        const { taskId, alreadyExisted } = await repo.instantiateRoutineTask(templateId)

        // Mark the task as complete
        const client = getPersistenceClient()
        await client.execute({
          sql: "UPDATE tasks SET status = 'complete', updated_at = ? WHERE id = ?",
          args: [Date.now(), taskId],
        })

        return apiJson({ taskId, alreadyExisted, completed: true })
      }

      case "update": {
        const templateId = String(body.templateId || "")
        if (!templateId) return apiError("templateId is required", 400)

        const updates: Parameters<typeof repo.update>[1] = {}
        if (typeof body.name === "string") updates.name = body.name.trim()
        if (typeof body.icon === "string") updates.icon = body.icon
        if (typeof body.cadence === "string") updates.cadence = body.cadence
        else if (typeof body.frequency === "string") updates.cadence = body.frequency

        // Rebuild template JSON if checklist or other template fields change
        if (body.templateJson && typeof body.templateJson === "object") {
          updates.templateJson = JSON.stringify(body.templateJson)
        }

        await repo.update(templateId, updates)
        return apiJson({ ok: true })
      }

      case "delete": {
        const templateId = String(body.templateId || body.habitId || "")
        if (!templateId) return apiError("templateId is required", 400)
        await repo.delete(templateId)
        return apiJson({ ok: true })
      }

      default:
        return apiError("Invalid action. Use: create, complete, update, delete", 400)
    }
  } catch (error) {
    logApiError("habits", "POST error", error)
    return apiError("Failed to manage habit")
  }
}
