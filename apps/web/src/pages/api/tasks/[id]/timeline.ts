import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { apiError, apiJson } from "../../../../lib/api-response"
import { createLogger, defaultRedactionPatterns, VALID_ACTOR_TYPE_SET, VALID_EVENT_TYPE_SET } from "@meitheal/domain-observability"

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["tasks", "audit", "observability"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: true,
})

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

    const taskId = params.id
    if (!taskId || taskId.length > 255) {
      return apiError("Invalid task ID", 400)
    }

    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50))
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0)

    // Validate event_type against known values
    const rawEventType = url.searchParams.get("event_type") || undefined
    if (rawEventType && !VALID_EVENT_TYPE_SET.has(rawEventType)) {
      return apiError(`Invalid event_type: ${rawEventType}`, 400)
    }

    // Validate actor_type against known values
    const rawActorType = url.searchParams.get("actor_type") || undefined
    if (rawActorType && !VALID_ACTOR_TYPE_SET.has(rawActorType)) {
      return apiError(`Invalid actor_type: ${rawActorType}`, 400)
    }

    const timeline = await repo.getTimeline(taskId, {
      limit,
      offset,
      ...(rawEventType ? { event_type: rawEventType } : {}),
      ...(rawActorType ? { actor_type: rawActorType } : {}),
    })

    return apiJson(timeline)
  } catch (err) {
    logger.log("error", {
      event: "api.timeline.get.failed",
      domain: "tasks",
      component: "timeline-api",
      request_id: crypto.randomUUID(),
      message: "Failed to fetch timeline",
    })
    return apiError("Failed to fetch timeline")
  }
}
