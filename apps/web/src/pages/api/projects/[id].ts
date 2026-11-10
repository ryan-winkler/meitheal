import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { HierarchyRepository } from "@domains/tasks/persistence/hierarchy-repository"
import { stripHtml } from "../../../lib/strip-html"
import { apiError, apiJson } from "../../../lib/api-response"
import { logApiError } from "../../../lib/api-logger"

/**
 * Project Detail API — GET/PUT/DELETE a specific project
 *
 * @domain domain-tasks (hierarchy context)
 * @see docs/decisions/ADR-007-hierarchy-model.md
 */

const VALID_STATUSES = ["active", "completed", "paused", "archived"]

export const GET: APIRoute = async ({ params, url }) => {
  try {
    await ensureSchema()
    const repo = new HierarchyRepository(getPersistenceClient())
    const project = await repo.findProjectById(params.id!)
    if (!project) return apiError("Project not found", 404)
    if (url.searchParams.get("task_counts") === "1") {
      return apiJson({ ...project, task_counts: await repo.getProjectTaskCounts(project.id) })
    }
    return apiJson(project)
  } catch (error) {
    logApiError("projects", "GET detail error", error)
    return apiError("Failed to get project")
  }
}

export const PUT: APIRoute = async ({ params, request }) => {
  try {
    await ensureSchema()
    const repo = new HierarchyRepository(getPersistenceClient())
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const updates: Parameters<typeof repo.updateProject>[1] = {}
    if (typeof body.title === "string") {
      const title = stripHtml(body.title.trim())
      if (!title || title.length > 200) return apiError("Title must be 1-200 characters", 400)
      updates.title = title
    }
    if ("goal_id" in body) updates.goal_id = typeof body.goal_id === "string" ? body.goal_id : null
    if ("area_id" in body) updates.area_id = typeof body.area_id === "string" ? body.area_id : null
    if (typeof body.description === "string" || body.description === null) updates.description = body.description ? String(body.description).slice(0, 2000) : null
    if (typeof body.status === "string" && VALID_STATUSES.includes(body.status)) updates.status = body.status
    if (typeof body.icon === "string") updates.icon = body.icon.slice(0, 10)
    if (typeof body.color === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(body.color)) updates.color = body.color
    if (typeof body.position === "number") updates.position = body.position
    // Phase 15: is_default is server-managed — silently ignore client attempts to set it

    const updated = await repo.updateProject(params.id!, updates)
    if (!updated) return apiError("Project not found or no changes", 404)

    const project = await repo.findProjectById(params.id!)
    return apiJson(project)
  } catch (error) {
    logApiError("projects", "PUT error", error)
    return apiError("Failed to update project")
  }
}

export const DELETE: APIRoute = async ({ params }) => {
  try {
    await ensureSchema()
    const repo = new HierarchyRepository(getPersistenceClient())

    // Phase 15: prevent deleting the default "Every Day" project
    const project = await repo.findProjectById(params.id!)
    if (!project) return apiError("Project not found", 404)
    if (project.is_default) return apiError("Cannot delete the default project", 403)

    const deleted = await repo.deleteProject(params.id!)
    if (!deleted) return apiError("Project not found", 404)
    return apiJson({ ok: true })
  } catch (error) {
    logApiError("projects", "DELETE error", error)
    return apiError("Failed to delete project")
  }
}
