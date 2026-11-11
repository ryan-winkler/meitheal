/**
 * GET/DELETE /api/tasks/delete-completed — Age-based deletion of completed tasks
 *
 * @domain tasks
 * @bounded-context tasks (persistence)
 *
 * GET  ?months=3|6|12|24 → Dry-run preview: returns count of tasks that would be deleted
 * DELETE ?months=3|6|12|24&confirm=true → Permanently deletes matching tasks
 *
 * @safety
 * - Only touches tasks with status IN ('complete', 'archived')
 * - Active, pending, and in-progress tasks are NEVER affected
 * - No bot/API automation — user-initiated only via Danger Zone settings
 * - Cascades to comments, activity log, and task links
 * - Logs to audit_trail on every deletion
 *
 * @kcs This endpoint permanently removes data. Unlike clear-completed (soft archive),
 * this performs hard deletion. The confirmation parameter is required to prevent
 * accidental invocation.
 */
import type { APIRoute } from "astro"
import { rejectBoardSelectionInJson } from "@domains/tasks/board-availability"
import {
  ensureSchema,
  getPersistenceClient,
} from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { apiLogger, logApiError } from "../../../lib/api-logger"
import { isDbUnavailable, db503Response } from "../../../lib/db-fallback"

/** Allowed month thresholds — anything else is rejected */
const VALID_MONTHS = new Set([3, 6, 12, 24])

/** Convert months-ago to epoch milliseconds cutoff */
function monthsToCutoffMs(months: number): number {
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - months)
  return cutoff.getTime()
}

/** Validate and extract the months query parameter */
function validateMonths(url: URL): { months: number } | Response {
  const monthsParam = Number(url.searchParams.get("months"))
  if (!VALID_MONTHS.has(monthsParam)) {
    return new Response(
      JSON.stringify({ error: "months must be 3, 6, 12, or 24" }),
      { status: 400, headers: { "content-type": "application/json" } },
    )
  }
  return { months: monthsParam }
}

/** GET — dry-run preview: count tasks that would be deleted */
export const GET: APIRoute = async ({ url }) => {
  try {
    const result = validateMonths(url)
    if (result instanceof Response) return result
    const { months } = result

    await ensureSchema()
    const repo = new TaskRepository(getPersistenceClient())
    const cutoffMs = monthsToCutoffMs(months)
    const cutoffDate = new Date(cutoffMs).toISOString().split("T")[0]

    return new Response(
      JSON.stringify({ count: await repo.countCompletedBefore(cutoffMs), months, cutoffDate }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  } catch (err) {
    if (isDbUnavailable(err)) return db503Response("delete-completed-preview", err)
    logApiError("delete-completed", "GET preview failed", err)
    return new Response(
      JSON.stringify({ error: "Failed to preview deletion" }),
      { status: 500, headers: { "content-type": "application/json" } },
    )
  }
}

/** DELETE — permanently remove completed/archived tasks older than threshold */
export const DELETE: APIRoute = async ({ request, url }) => {
  try {
    const result = validateMonths(url)
    if (result instanceof Response) return result
    const { months } = result

    const confirm = url.searchParams.get("confirm")
    if (confirm !== "true") {
      return new Response(
        JSON.stringify({ error: "confirm=true is required to execute deletion" }),
        { status: 400, headers: { "content-type": "application/json" } },
      )
    }

    const boardSelection = await rejectBoardSelectionInJson(request)
    if (boardSelection) return boardSelection
    await ensureSchema()
    const client = getPersistenceClient()
    const repo = new TaskRepository(client)
    const cutoffMs = monthsToCutoffMs(months)
    const cutoffDate = new Date(cutoffMs).toISOString().split("T")[0]

    const deleted = await repo.deleteCompletedBefore(cutoffMs)

    // Audit trail entry
    try {
      await client.execute({
        sql: `INSERT INTO audit_trail (audit_id, request_id, level, message, metadata, created_at)
              VALUES (?, ?, 'warn', ?, ?, ?)`,
        args: [
          crypto.randomUUID(),
          "retention-delete",
          `Permanently deleted ${deleted} completed/archived tasks older than ${months} months (before ${cutoffDate})`,
          JSON.stringify({ months, cutoffDate, deletedCount: deleted }),
          Date.now(),
        ],
      })
    } catch {
      /* audit write failure should not block response */
    }

    apiLogger.log("warn", {
      event: "retention-delete.success",
      domain: "tasks",
      component: "delete-completed",
      request_id: "retention-delete",
      message: `Permanently deleted ${deleted} tasks older than ${months} months`,
      metadata: { months, cutoffDate, deletedCount: deleted },
    })

    return new Response(
      JSON.stringify({ ok: true, deleted, months, cutoffDate }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  } catch (err) {
    if (isDbUnavailable(err)) return db503Response("delete-completed", err)
    logApiError("delete-completed", "DELETE failed", err)
    return new Response(
      JSON.stringify({ error: "Failed to delete tasks" }),
      { status: 500, headers: { "content-type": "application/json" } },
    )
  }
}
