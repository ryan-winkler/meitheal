import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { HierarchyRepository } from "@domains/tasks/persistence/hierarchy-repository"
import { stripHtml } from "../../../lib/strip-html"
import { apiError, apiJson } from "../../../lib/api-response"
import { logApiError } from "../../../lib/api-logger"

/**
 * Projects API — Hierarchy Aggregate Roots
 *
 * Projects are time-bounded containers for tasks, linked to goals.
 * They are aggregate roots — the primary work container.
 *
 * GET  /api/projects — List projects (optional ?goal_id=&status= filters)
 * POST /api/projects — Create a new project
 *
 * @domain domain-tasks (hierarchy context)
 * @see docs/decisions/ADR-007-hierarchy-model.md
 */

export const GET: APIRoute = async ({ url }) => {
  try {
    await ensureSchema()
    const repo = new HierarchyRepository(getPersistenceClient())
    const filters: { goal_id?: string; status?: string } = {}
    const goal_id = url.searchParams.get("goal_id")
    const status = url.searchParams.get("status")
    if (goal_id) filters.goal_id = goal_id
    if (status) filters.status = status
    const projects = await repo.findAllProjects(filters)
    return apiJson({ projects })
  } catch (error) {
    logApiError("projects", "GET error", error)
    return apiError("Failed to list projects")
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

    if (await repo.countProjects() >= 500) {
      return apiError("Maximum project limit (500) reached", 429)
    }

    const id = crypto.randomUUID()
    const goal_id = typeof body.goal_id === "string" ? body.goal_id : null
    const description = typeof body.description === "string" ? body.description.slice(0, 2000) : null
    const status = typeof body.status === "string" && ["active", "completed", "paused", "archived"].includes(body.status) ? body.status : "active"
    const icon = typeof body.icon === "string" ? body.icon.slice(0, 10) : "📋"
    const color = typeof body.color === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(body.color) ? body.color : "#6366F1"
    const position = await repo.getNextProjectPosition()

    await repo.createProject({
      id, title, status, icon, color, position,
      ...(goal_id != null ? { goal_id } : {}),
      ...(description != null ? { description } : {}),
    })

    return apiJson({
      id, title, goal_id, description, status, icon, color, position,
      created_at: Date.now(), updated_at: Date.now(),
    }, 201)
  } catch (error) {
    logApiError("projects", "POST error", error)
    return apiError("Failed to create project")
  }
}
