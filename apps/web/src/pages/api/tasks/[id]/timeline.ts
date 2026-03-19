import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { apiError, apiJson } from "../../../../lib/api-response"

/**
 * GET /api/tasks/[id]/timeline — Unified Immutable Audit Ledger
 * Merges activity log + comments into a single chronological feed.
 * Supports filtering by event_type and actor_type with pagination.
 *
 * Competitive parity: GitHub issue timeline, Linear activity feed.
 */
export const GET: APIRoute = async ({ params, url }) => {
  try {
    await ensureSchema()
    const repo = new TaskRepository(getPersistenceClient())

    const limit = Number(url.searchParams.get("limit")) || 50
    const offset = Number(url.searchParams.get("offset")) || 0
    const event_type = url.searchParams.get("event_type") || undefined
    const actor_type = url.searchParams.get("actor_type") || undefined

    const timeline = await repo.getTimeline(params.id!, {
      limit,
      offset,
      event_type,
      actor_type,
    })

    return apiJson(timeline)
  } catch {
    return apiError("Failed to fetch timeline")
  }
}
