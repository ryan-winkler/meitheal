/**
 * POST /api/tasks/clear-completed — Archive tasks completed today
 *
 * @domain tasks
 * @bounded-context tasks (persistence)
 *
 * Bulk-archives all tasks with status='complete' that were updated today.
 * Used by the Today page's "Clear Done" button.
 *
 * @kcs This endpoint does not delete tasks — it moves them to
 * an archived state. If no archive status exists, it does nothing.
 * Currently it soft-deletes by marking status='complete' tasks as hidden.
 */
import type { APIRoute } from "astro"
import {
  ensureSchema,
  getPersistenceClient,
} from "@domains/tasks/persistence/store"
import { apiLogger, logApiError } from "../../../lib/api-logger"

export const POST: APIRoute = async () => {
  try {
    await ensureSchema()
    const client = getPersistenceClient()
    const todayStr = new Date().toISOString().split("T")[0] ?? ""

    // Count completed tasks from today before clearing
    const countResult = await client.execute({
      sql: `SELECT COUNT(*) as cnt FROM tasks
            WHERE status = 'complete'
              AND updated_at >= ?`,
      args: [`${todayStr}T00:00:00`],
    })
    const count = Number(countResult.rows[0]?.cnt ?? 0)

    if (count === 0) {
      return new Response(
        JSON.stringify({ ok: true, cleared: 0, message: "No completed tasks to clear" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }

    // Soft-archive: set a flag so they don't appear in normal queries
    // Using a special status 'archived' that is filtered out by default
    await client.execute({
      sql: `UPDATE tasks
            SET status = 'archived', updated_at = datetime('now')
            WHERE status = 'complete'
              AND updated_at >= ?`,
      args: [`${todayStr}T00:00:00`],
    })

    apiLogger.log("info", {
      event: "clear-completed.success",
      domain: "tasks",
      component: "clear-completed",
      request_id: "today-clear",
      message: `Archived ${count} completed tasks`,
    })

    return new Response(
      JSON.stringify({ ok: true, cleared: count }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  } catch (err: unknown) {
    logApiError("POST", "/api/tasks/clear-completed", err)
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "content-type": "application/json" } },
    )
  }
}
