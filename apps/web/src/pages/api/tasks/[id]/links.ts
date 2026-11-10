import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { apiError, apiJson } from "../../../../lib/api-response"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"

const logger = createLogger({
  service: "meitheal-web", env: process.env.NODE_ENV ?? "development",
  minLevel: "info", enabledCategories: ["tasks"],
  redactPatterns: defaultRedactionPatterns, auditEnabled: false,
})

/**
 * Valid Jira-style link types for task-to-task relationships.
 * Each type has a natural-language inverse used for display:
 *   related_to ↔ related_to
 *   blocked_by ↔ blocks
 *   duplicates ↔ duplicated_by
 */
const LINK_TYPES = ["related_to", "blocked_by", "blocks", "duplicates", "duplicated_by"] as const
export type LinkType = (typeof LINK_TYPES)[number]

/** Simple UUID-v4 format check (lowercase hex + dashes). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET /api/tasks/:id/links — Returns all links for a task (both as source and target).
 */
export const GET: APIRoute = async ({ params }) => {
  try {
    await ensureSchema()
    const repo = new TaskRepository(getPersistenceClient())
    const taskId = params.id!

    const [outbound, inbound] = await Promise.all([
      repo.getOutboundLinks(taskId),
      repo.getInboundLinks(taskId),
    ])

    return apiJson({ outbound, inbound })
  } catch (err) {
    logger.log("error", { event: "api.links.get_failed", domain: "tasks", component: "links-api", request_id: "system", message: `GET links failed: ${err}` })
    return apiError("Failed to fetch task links", 500)
  }
}

/**
 * POST /api/tasks/:id/links — Create a link between two tasks.
 */
export const POST: APIRoute = async ({ params, request }) => {
  try {
    await ensureSchema()
    const repo = new TaskRepository(getPersistenceClient())
    const sourceTaskId = params.id!

    const body = await request.json()
    const { target_task_id, link_type } = body as { target_task_id: string; link_type: string }

    if (!target_task_id || !link_type) {
      return apiError("target_task_id and link_type are required", 400)
    }

    if (!UUID_RE.test(target_task_id)) {
      return apiError("target_task_id must be a valid UUID", 400)
    }

    if (!LINK_TYPES.includes(link_type as LinkType)) {
      return apiError(`Invalid link_type. Must be one of: ${LINK_TYPES.join(", ")}`, 400)
    }

    if (sourceTaskId === target_task_id) {
      return apiError("Cannot link a task to itself", 400)
    }

    // Idempotency check
    if (await repo.linkExists(sourceTaskId, target_task_id, link_type)) {
      return apiJson({ created: false, message: "Link already exists" })
    }

    const id = crypto.randomUUID()
    const created_at = await repo.createLink(id, sourceTaskId, target_task_id, link_type)

    logger.log("info", { event: "api.links.created", domain: "tasks", component: "links-api", request_id: "system", message: `Created link: ${sourceTaskId} --${link_type}--> ${target_task_id}` })

    return apiJson({ id, source_task_id: sourceTaskId, target_task_id, link_type, created_at, created: true }, 201)
  } catch (err) {
    logger.log("error", { event: "api.links.post_failed", domain: "tasks", component: "links-api", request_id: "system", message: `POST link failed: ${err}` })
    return apiError("Failed to create task link", 500)
  }
}

/**
 * DELETE /api/tasks/:id/links?link_id=xxx — Remove a link.
 */
export const DELETE: APIRoute = async ({ params, url }) => {
  try {
    await ensureSchema()
    const repo = new TaskRepository(getPersistenceClient())
    const taskId = params.id!

    const link_id = url.searchParams.get("link_id")
    if (!link_id) {
      return apiError("link_id query parameter is required", 400)
    }

    const rowsAffected = await repo.deleteLink(link_id, taskId)
    if (rowsAffected === 0) {
      return apiError("Link not found or does not belong to this task", 404)
    }

    logger.log("info", { event: "api.links.deleted", domain: "tasks", component: "links-api", request_id: "system", message: `Deleted link=${link_id} from task=${taskId}` })

    return apiJson({ deleted: true })
  } catch (err) {
    logger.log("error", { event: "api.links.delete_failed", domain: "tasks", component: "links-api", request_id: "system", message: `DELETE link failed: ${err}` })
    return apiError("Failed to delete task link", 500)
  }
}
