import { boardScopeErrorResponse } from "@lib/board-http"
import { withBoardScope } from "@lib/board-http"
import type { APIRoute } from "astro"
import {
  startTimeEntryForTask,
  stopTimeEntryForTask,
  getTimeEntries,
  getTotalTimeForTask,
} from "@domains/pomodoro"
import { hasBoardSelection, unavailableBoardResponse } from "@domains/tasks/board-availability"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { requireAssignedTaskWriteAccess, restrictedAssigneeId } from "../../../../lib/agent-token-guard"
import { apiJson, apiError } from "../../../../lib/api-response"

/**
 * Time Tracking API — per-task time entries
 *
 * GET  /api/tasks/[id]/time — Get all time entries + total for a task
 * POST /api/tasks/[id]/time — Start or stop timer for a task
 *
 * @domain pomodoro
 * @bounded-context pomodoro
 */

export const GET: APIRoute = withBoardScope({ resource: "task", action: "read" }, async ({ params }, scope) => {
  try {
    if (!params.id) return apiError("Task ID required", 400)
    await ensureSchema()
    // Read with the same task ID that POST writes to, so a ticket key such as MTH-12 works both ways.
    const taskId = (await new TaskRepository(getPersistenceClient(), scope).resolveTaskId(params.id))?.id
    if (!taskId) return apiJson({ entries: [], totalSeconds: 0 })

    const [entries, total] = await Promise.all([
      getTimeEntries(scope, taskId),
      getTotalTimeForTask(scope, taskId),
    ])

    return apiJson({ entries, totalSeconds: total })
  } catch (err) {
    const scopeFailure = boardScopeErrorResponse(err)
    if (scopeFailure) return scopeFailure
    return apiError("Failed to get time entries")
  }
})

export const POST: APIRoute = withBoardScope({ resource: "task", action: "edit" }, async ({ params, request, locals }, scope) => {
  try {
    const taskId = params.id
    if (!taskId) return apiError("Task ID required", 400)

    await ensureSchema()
    const repo = new TaskRepository(getPersistenceClient(), scope)
    const resolved = await repo.resolveTaskId(taskId, "edit")
    if (!resolved) return apiError("Task not found", 404)
    const resolvedTaskId = resolved.id
    const denied = await requireAssignedTaskWriteAccess(
      locals.agentToken,
      (id) => repo.findTaskForCommand(id, "edit"),
      [resolvedTaskId],
      "Agent can only track time on tasks assigned to it",
    )
    if (denied) return denied

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    if (hasBoardSelection(body)) return unavailableBoardResponse()
    const action = String(body.action || "start")

    if (action === "start") {
      const res = await startTimeEntryForTask(scope, resolvedTaskId, restrictedAssigneeId(locals.agentToken))
      if (!res.ok) return apiError(res.errorCode === "assignee_mismatch" ? "Agent can only track time on tasks assigned to it" : "Task not found", res.errorCode === "assignee_mismatch" ? 403 : 404)
      return apiJson({ entry: res.entry })
    } else if (action === "stop") {
      const res = await stopTimeEntryForTask(scope, resolvedTaskId, restrictedAssigneeId(locals.agentToken))
      if (!res.ok) return apiError(res.errorCode === "assignee_mismatch" ? "Agent can only track time on tasks assigned to it" : "Task not found", res.errorCode === "assignee_mismatch" ? 403 : 404)
      if (!res.entry) return apiJson({ entry: null, message: "No running timer for this task" })
      return apiJson({ entry: res.entry })
    } else {
      return apiError("Invalid action. Use: start, stop", 400)
    }
  } catch (err) {
    const scopeFailure = boardScopeErrorResponse(err)
    if (scopeFailure) return scopeFailure
    return apiError("Failed to manage time entry")
  }
})
