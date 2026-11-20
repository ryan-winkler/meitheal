import { boardScopeErrorResponse } from "@lib/board-http"
import { journaledBoardCommandAck, withBoardScope } from "@lib/board-http"
import type { APIRoute } from "astro"
import { isValidGoalProgress } from "@meitheal/domain-tasks"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { listSharedGoals, serializeBoardGoal } from "@domains/tasks/persistence/shared-goal-repository"
import { HierarchyRepository, PlanningAccessLockedError } from "@domains/tasks/persistence/hierarchy-repository"
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

export const GET: APIRoute = withBoardScope({ resource: "goal", action: "read" }, async ({ params, locals, request }, scope) => {
  try {
    await ensureSchema()
    const client = getPersistenceClient()
    const repo = new HierarchyRepository(client, scope)
    const id = params.id!
    const goal = await repo.findGoalById(id)
    const [shared] = await listSharedGoals(client, scope, { goalId: id }, request.signal)
    if (goal && shared) {
      return apiJson({ ...goal, project_count: shared.project_count, completed_project_count: shared.completed_project_count })
    }
    if (goal) return apiJson(goal)
    if (shared) return apiJson(serializeBoardGoal(shared))
    return apiError("Goal not found", 404)
  } catch (error) {
    const scopeFailure = boardScopeErrorResponse(error)
    if (scopeFailure) return scopeFailure
    logApiError("goals", "GET detail error", error)
    return apiError("Failed to get goal")
  }
})

export const PUT: APIRoute = withBoardScope({ resource: "goal", action: "edit" }, async ({ params, request }, scope) => {
  try {
    await ensureSchema()
    const repo = new HierarchyRepository(getPersistenceClient(), scope)
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
    const scopeFailure = boardScopeErrorResponse(error)
    if (scopeFailure) return scopeFailure
    logApiError("goals", "PUT error", error)
    return apiError("Failed to update goal")
  }
})

export const DELETE: APIRoute = withBoardScope({ resource: "goal", action: "delete" }, async ({ params }, scope) => {
  try {
    await ensureSchema()
    const repo = new HierarchyRepository(getPersistenceClient(), scope)
    const deleted = await repo.deleteGoal(params.id!)
    if (!deleted) return apiError("Goal not found", 404)
    return journaledBoardCommandAck(scope, { resource: "goal", action: "delete" })
  } catch (error) {
    const scopeFailure = boardScopeErrorResponse(error)
    if (scopeFailure) return scopeFailure
    if (error instanceof PlanningAccessLockedError) return apiError(error.message, 503)
    logApiError("goals", "DELETE error", error)
    return apiError("Failed to delete goal")
  }
})
