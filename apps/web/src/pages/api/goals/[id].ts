import type { APIRoute } from "astro"
import { isValidGoalProgress } from "@meitheal/domain-tasks"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { HierarchyRepository } from "@domains/tasks/persistence/hierarchy-repository"
import { stripHtml } from "../../../lib/strip-html"
import { apiError, apiJson } from "../../../lib/api-response"
import { logApiError } from "../../../lib/api-logger"

/**
 * Goal Detail API — GET/PUT/DELETE a specific goal
 *
 * @domain domain-tasks (hierarchy context)
 * @see docs/decisions/ADR-007-hierarchy-model.md
 */

const VALID_STATUSES = ["active", "completed", "archived"]

export const GET: APIRoute = async ({ params }) => {
  try {
    await ensureSchema()
    const repo = new HierarchyRepository(getPersistenceClient())
    const goal = await repo.findGoalById(params.id!)
    if (!goal) return apiError("Goal not found", 404)
    return apiJson(goal)
  } catch (error) {
    logApiError("goals", "GET detail error", error)
    return apiError("Failed to get goal")
  }
}

export const PUT: APIRoute = async ({ params, request }) => {
  try {
    await ensureSchema()
    const repo = new HierarchyRepository(getPersistenceClient())
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const updates: Parameters<typeof repo.updateGoal>[1] = {}
    if ("progress" in body) {
      if (!isValidGoalProgress(body.progress)) return apiError("progress must be a number from 0 to 100", 400)
      updates.progress = body.progress
    }
    if (typeof body.title === "string") {
      const title = stripHtml(body.title.trim())
      if (!title || title.length > 200) return apiError("Title must be 1-200 characters", 400)
      updates.title = title
    }
    if ("area_id" in body) updates.area_id = typeof body.area_id === "string" ? body.area_id : null
    if (typeof body.description === "string" || body.description === null) updates.description = body.description ? String(body.description).slice(0, 2000) : null
    if (typeof body.status === "string" && VALID_STATUSES.includes(body.status)) updates.status = body.status
    if ("target_date" in body) updates.target_date = typeof body.target_date === "string" ? body.target_date : null

    const updated = await repo.updateGoal(params.id!, updates)
    if (!updated) return apiError("Goal not found or no changes", 404)

    const goal = await repo.findGoalById(params.id!)
    return apiJson(goal)
  } catch (error) {
    logApiError("goals", "PUT error", error)
    return apiError("Failed to update goal")
  }
}

export const DELETE: APIRoute = async ({ params }) => {
  try {
    await ensureSchema()
    const repo = new HierarchyRepository(getPersistenceClient())
    const deleted = await repo.deleteGoal(params.id!)
    if (!deleted) return apiError("Goal not found", 404)
    return apiJson({ ok: true })
  } catch (error) {
    logApiError("goals", "DELETE error", error)
    return apiError("Failed to delete goal")
  }
}
