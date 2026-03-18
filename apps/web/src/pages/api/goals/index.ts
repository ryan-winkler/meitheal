import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
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
 * GET  /api/goals — List goals (optional ?area_id=&status= filters)
 * POST /api/goals — Create a new goal
 *
 * @domain domain-tasks (hierarchy context)
 * @see docs/decisions/ADR-007-hierarchy-model.md
 */

export const GET: APIRoute = async ({ url }) => {
  try {
    await ensureSchema()
    const repo = new HierarchyRepository(getPersistenceClient())
    const filters: { area_id?: string; status?: string } = {}
    const area_id = url.searchParams.get("area_id")
    const status = url.searchParams.get("status")
    if (area_id) filters.area_id = area_id
    if (status) filters.status = status
    const goals = await repo.findAllGoals(filters)
    return apiJson({ goals })
  } catch (error) {
    logApiError("goals", "GET error", error)
    return apiError("Failed to list goals")
  }
}

export const POST: APIRoute = async ({ request }) => {
  try {
    await ensureSchema()
    const repo = new HierarchyRepository(getPersistenceClient())
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const title = stripHtml(String(body.title ?? "").trim())
    if (!title || title.length > 200) {
      return apiError("Title is required and must be 200 characters or less", 400)
    }

    if (await repo.countGoals() >= 200) {
      return apiError("Maximum goal limit (200) reached", 429)
    }

    const id = crypto.randomUUID()
    const area_id = typeof body.area_id === "string" ? body.area_id : null
    const description = typeof body.description === "string" ? body.description.slice(0, 2000) : null
    const status = typeof body.status === "string" && ["active", "completed", "archived"].includes(body.status) ? body.status : "active"
    const target_date = typeof body.target_date === "string" ? body.target_date : null

    await repo.createGoal({
      id, title, status,
      ...(area_id != null ? { area_id } : {}),
      ...(description != null ? { description } : {}),
      ...(target_date != null ? { target_date } : {}),
    })

    return apiJson({ id, title, area_id, description, status, target_date, created_at: Date.now(), updated_at: Date.now() }, 201)
  } catch (error) {
    logApiError("goals", "POST error", error)
    return apiError("Failed to create goal")
  }
}
