import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { HierarchyRepository } from "@domains/tasks/persistence/hierarchy-repository"
import { stripHtml } from "../../../lib/strip-html"
import { apiError, apiJson } from "../../../lib/api-response"
import { logApiError } from "../../../lib/api-logger"

/**
 * Areas API — Hierarchy Classification
 *
 * Areas are life domains (e.g. Personal, Work, Health) that group goals.
 * They are classification entities, not aggregate roots.
 *
 * GET  /api/areas — List all areas
 * POST /api/areas — Create a new area
 *
 * @domain domain-tasks (hierarchy context)
 * @see docs/decisions/ADR-007-hierarchy-model.md
 */

export const GET: APIRoute = async () => {
  try {
    await ensureSchema()
    const repo = new HierarchyRepository(getPersistenceClient())
    const areas = await repo.findAllAreas()
    return apiJson({ areas })
  } catch (error) {
    logApiError("areas", "GET error", error)
    return apiError("Failed to list areas")
  }
}

export const POST: APIRoute = async ({ request }) => {
  try {
    await ensureSchema()
    const repo = new HierarchyRepository(getPersistenceClient())
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const name = stripHtml(String(body.name ?? "").trim())
    if (!name || name.length > 100) {
      return apiError("Name is required and must be 100 characters or less", 400)
    }

    if (await repo.countAreas() >= 50) {
      return apiError("Maximum area limit (50) reached", 429)
    }

    const id = crypto.randomUUID()
    const icon = typeof body.icon === "string" ? body.icon.slice(0, 10) : "📁"
    const color = typeof body.color === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(body.color) ? body.color : "#6366F1"
    const position = await repo.getNextAreaPosition()

    await repo.createArea({ id, name, icon, color, position })

    return apiJson({ id, name, icon, color, position, created_at: Date.now(), updated_at: Date.now() }, 201)
  } catch (error) {
    logApiError("areas", "POST error", error)
    return apiError("Failed to create area")
  }
}
