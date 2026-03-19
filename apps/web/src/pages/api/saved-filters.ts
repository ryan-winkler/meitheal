/**
 * Saved Filters API — Phase 31
 *
 * CRUD for user-defined saved filter combinations (smart views).
 *
 * @domain domain-tasks
 * @kcs saved filter query format: JSON object with optional keys:
 *   status, priority, area_id, search, rice, task_type, sort
 */
import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { SettingsRepository } from "@domains/tasks/persistence/settings-repository"
import { apiError, apiJson } from "../../lib/api-response"
import { logApiError } from "../../lib/api-logger"

export const GET: APIRoute = async () => {
  try {
    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())
    const filters = await repo.listFilters()
    return apiJson({ filters })
  } catch (error) {
    logApiError("saved-filters", "GET error", error)
    return apiError("Failed to fetch saved filters", 500)
  }
}

export const POST: APIRoute = async ({ request }) => {
  try {
    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())

    let body: Record<string, unknown>
    try {
      body = await request.json() as Record<string, unknown>
    } catch {
      return apiError("Invalid JSON body", 400)
    }

    const { name, query_json, icon } = body as {
      name?: string
      query_json?: Record<string, unknown>
      icon?: string
    }

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return apiError("name is required", 400)
    }

    if (name.trim().length > 100) {
      return apiError("name must be 100 characters or fewer", 400)
    }

    const id = crypto.randomUUID()
    const position = await repo.getNextFilterPosition()

    await repo.createFilter({
      id,
      name: name.trim(),
      queryJson: JSON.stringify(query_json ?? {}),
      icon: icon ?? "🔍",
      position,
    })

    return apiJson({ id, name: name.trim(), position }, 201)
  } catch (error) {
    logApiError("saved-filters", "POST error", error)
    return apiError("Failed to create saved filter", 500)
  }
}

export const DELETE: APIRoute = async ({ request }) => {
  try {
    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())
    const url = new URL(request.url)
    const id = url.searchParams.get("id")

    if (!id) {
      return apiError("id query parameter is required", 400)
    }

    await repo.deleteFilter(id)
    return apiJson({ deleted: true })
  } catch (error) {
    logApiError("saved-filters", "DELETE error", error)
    return apiError("Failed to delete saved filter", 500)
  }
}
