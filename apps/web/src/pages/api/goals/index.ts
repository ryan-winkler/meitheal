import { boardScopeErrorResponse } from "@lib/board-http"
import { withBoardScope } from "@lib/board-http"
import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { listSharedGoals, readNamedGoalScope, serializeBoardGoal, sharedGoalProjectionKey } from "@domains/tasks/persistence/shared-goal-repository"
import { HierarchyRepository } from "@domains/tasks/persistence/hierarchy-repository"
import { stripHtml } from "../../../lib/strip-html"
import { apiError, apiJson } from "../../../lib/api-response"
import { logApiError } from "../../../lib/api-logger"

/**
 * Goals API — Hierarchy Aggregate Roots
 *
 * Goals represent desired outcomes linked to areas.
 * They are aggregate roots — the primary container for strategic intent.
 *
 * GET  /api/goals — List goals (optional ?area_id=&project_id=&status= filters)
 * POST /api/goals — Create a new goal
 *
 * @domain domain-tasks (hierarchy context)
 * @see docs/decisions/ADR-007-hierarchy-model.md
 */

export const HEAD: APIRoute = withBoardScope({ resource: "goal", action: "read" }, async ({ url, locals, request }, scope) => {
  const expected = request.headers.get("x-meitheal-goal-projection")
  const headers = { "cache-control": "private, no-store" }
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) return new Response(null, { status: 409, headers })

  try {
    await ensureSchema()
    const areaId = url.searchParams.get("area_id")
    const projectId = url.searchParams.get("project_id")
    const client = getPersistenceClient()
    const filters = { ...(areaId ? { areaId } : {}), ...(projectId ? { projectId } : {}) }
    const [goals, names] = await Promise.all([
      listSharedGoals(client, scope, filters, request.signal),
      url.searchParams.get("scope_labels") === "1"
        ? readNamedGoalScope(client, scope, filters, request.signal) : undefined,
    ])
    const matches = sharedGoalProjectionKey(goals, names) === expected
    return new Response(null, { status: matches ? 204 : 409, headers })
  } catch {
    return new Response(null, { status: 503, headers })
  }
})

export const GET: APIRoute = withBoardScope({ resource: "goal", action: "read" }, async ({ url, locals, request }, scope) => {
  try {
    await ensureSchema()
    const client = getPersistenceClient()
    const repo = new HierarchyRepository(client, scope)
    const filters: { area_id?: string; project_id?: string; status?: string } = {}
    const area_id = url.searchParams.get("area_id")
    const project_id = url.searchParams.get("project_id")
    const status = url.searchParams.get("status")
    if (area_id) filters.area_id = area_id
    if (project_id) filters.project_id = project_id
    if (status) filters.status = status
    const goals = await repo.findAllGoals(filters)
    const wantsShared = url.searchParams.get("projection") !== "owned" && (!status || status === "shared")
    const shared = wantsShared
      ? await listSharedGoals(client, scope, {
        ...(area_id ? { areaId: area_id } : {}),
        ...(project_id ? { projectId: project_id } : {}),
      }, request.signal) : []
    const sharedById = new Map(shared.map(goal => [goal.id, goal]))
    const projected = goals.map(goal => {
      const progress = sharedById.get(goal.id)
      sharedById.delete(goal.id)
      return progress ? {
        ...goal, project_count: progress.project_count, completed_project_count: progress.completed_project_count,
      } : goal
    })
    const received = [...sharedById.values()].map(serializeBoardGoal)
    return apiJson({ goals: [...projected, ...received] })
  } catch (error) {
    const scopeFailure = boardScopeErrorResponse(error)
    if (scopeFailure) return scopeFailure
    logApiError("goals", "GET error", error)
    return apiError("Failed to list goals")
  }
})

export const POST: APIRoute = withBoardScope({ resource: "goal", action: "create" }, async ({ request }, scope) => {
  try {
    await ensureSchema()
    const repo = new HierarchyRepository(getPersistenceClient(), scope)
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const title = stripHtml(String(body.title ?? "").trim())
    if (!title || title.length > 200) {
      return apiError("Title is required and must be 200 characters or less", 400)
    }

    if (await repo.countGoals() >= 200) {
      return apiError("Maximum goal limit (200) reached", 429)
    }

    const id = crypto.randomUUID()
    if (body.area_id != null && typeof body.area_id !== "string") {
      return apiError("Choose an existing Area", 400)
    }
    const area_id = typeof body.area_id === "string" ? body.area_id : null
    if (area_id !== null && !await repo.findAreaById(area_id)) {
      return apiError("Choose an existing Area", 400)
    }
    const description = typeof body.description === "string" ? body.description.slice(0, 2000) : null
    const status = typeof body.status === "string" && ["active", "completed", "archived"].includes(body.status) ? body.status : "active"
    const target_date = typeof body.target_date === "string" ? body.target_date : null

    if (body.project_id != null && (typeof body.project_id !== "string" || !body.project_id)) return apiError("Choose an existing Project", 400)
    const created = await repo.createGoal({
      id, title, status,
      ...(typeof body.project_id === "string" ? { project_id: body.project_id } : {}),
      ...(area_id != null ? { area_id } : {}),
      ...(description != null ? { description } : {}),
      ...(target_date != null ? { target_date } : {}),
    })

    if (!created) return apiError(body.project_id ? "This Project is unavailable or already has a Goal. Change its Goal in Project settings." : "Choose an existing Area", body.project_id ? 409 : 400)

    return apiJson({ id, title, area_id, description, status, target_date, created_at: Date.now(), updated_at: Date.now() }, 201)
  } catch (error) {
    const scopeFailure = boardScopeErrorResponse(error)
    if (scopeFailure) return scopeFailure
    logApiError("goals", "POST error", error)
    return apiError("Failed to create goal")
  }
})
