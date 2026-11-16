import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { HierarchyRepository } from "@domains/tasks/persistence/hierarchy-repository"
import { stripHtml } from "../../../lib/strip-html"
import { apiError, apiJson } from "../../../lib/api-response"
import { logApiError } from "../../../lib/api-logger"

/**
 * Area Detail API — GET/PUT/DELETE a specific area
 *
 * @domain domain-tasks (hierarchy context)
 * @see docs/decisions/ADR-007-hierarchy-model.md
 */

export const GET: APIRoute = async ({ params }) => {
  try {
    await ensureSchema()
    const repo = new HierarchyRepository(getPersistenceClient())
    const area = await repo.findAreaById(params.id!)
    if (!area) return apiError("Area not found", 404)
    return apiJson(area)
  } catch (error) {
    logApiError("areas", "GET detail error", error)
    return apiError("Failed to get area")
  }
}

export const PUT: APIRoute = async ({ params, request }) => {
  try {
    await ensureSchema()
    const repo = new HierarchyRepository(getPersistenceClient())
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const updates: Parameters<typeof repo.updateArea>[1] = {}
    if (typeof body.name === "string") {
      const name = stripHtml(body.name.trim())
      if (!name || name.length > 100) return apiError("Name must be 1-100 characters", 400)
      updates.name = name
    }
    if (typeof body.icon === "string") updates.icon = body.icon.slice(0, 10)
    if (typeof body.color === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(body.color)) {
      updates.color = body.color
    }
    if (typeof body.position === "number") updates.position = body.position

    const updated = await repo.updateArea(params.id!, updates)
    if (!updated) return apiError("Area not found or no changes", 404)

    const area = await repo.findAreaById(params.id!)
    return apiJson(area)
  } catch (error) {
    logApiError("areas", "PUT error", error)
    return apiError("Failed to update area")
  }
}

export const DELETE: APIRoute = async ({ params }) => {
  try {
    await ensureSchema()
    const repo = new HierarchyRepository(getPersistenceClient())
    const deleted = await repo.deleteArea(params.id!)
    if (!deleted) return apiError("Area not found", 404)
    return apiJson({ ok: true })
  } catch (error) {
    logApiError("areas", "DELETE error", error)
    return apiError("Failed to delete area")
  }
}
