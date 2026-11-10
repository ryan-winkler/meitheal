import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { apiError, apiJson } from "../../../../lib/api-response"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["tasks", "audit", "observability"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: true,
})

/**
 * GET /api/tasks/[id]/activity — Task activity log (audit trail)
 * Returns field-level change history for a task with pagination total.
 * Competitive parity: Jira, Asana, Linear all show activity logs.
 */
export const GET: APIRoute = async ({ params, url }) => {
  try {
    await ensureSchema()
    const repo = new TaskRepository(getPersistenceClient())

    const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 100), 500)
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0)

    const activity = await repo.getActivityLog(params.id!, limit, offset)

    // Get total count for complete pagination UX
    const client = getPersistenceClient()
    const countResult = await client.execute({
      sql: "SELECT COUNT(*) as total FROM task_activity_log WHERE task_id = ?",
      args: [params.id!],
    })
    const total = Number((countResult.rows[0] as Record<string, unknown>)?.total ?? 0)

    return apiJson({ activity, total, limit, offset })
  } catch (err) {
    logger.log("error", {
      event: "api.activity.get.failed",
      domain: "tasks",
      component: "activity-api",
      request_id: crypto.randomUUID(),
      message: "Failed to fetch activity log",
    })
    return apiError("Failed to fetch activity")
  }
}
