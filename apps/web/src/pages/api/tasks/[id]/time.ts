import type { APIRoute } from "astro"
import {
  startTimeEntry,
  stopTimeEntry,
  getTimeEntries,
  getTotalTimeForTask,
} from "@domains/pomodoro"
import { hasBoardSelection, unavailableBoardResponse } from "@domains/tasks/board-availability"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
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

export const GET: APIRoute = async ({ params }) => {
  try {
    const taskId = params.id
    if (!taskId) return apiError("Task ID required", 400)

    const [entries, total] = await Promise.all([
      getTimeEntries(taskId),
      getTotalTimeForTask(taskId),
    ])

    return apiJson({ entries, totalSeconds: total })
  } catch (err) {
    return apiError("Failed to get time entries")
  }
}

export const POST: APIRoute = async ({ params, request, locals }) => {
  try {
    const taskId = params.id
    if (!taskId) return apiError("Task ID required", 400)

    const agentToken = locals.agentToken
    if (agentToken && agentToken.scopes.includes("tasks:write:assigned") && !agentToken.scopes.includes("tasks:write")) {
      await ensureSchema()
      const repo = new TaskRepository(getPersistenceClient())
      const task = await repo.findById(taskId)
      if (!task || !agentToken.assigneeId || task.assigned_to !== agentToken.assigneeId) {
        return new Response(JSON.stringify({ error: "Agent can only track time on tasks assigned to it" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        })
      }
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    if (hasBoardSelection(body)) return unavailableBoardResponse()
    const action = String(body.action || "start")

    if (action === "start") {
      const entry = await startTimeEntry(taskId)
      return apiJson({ entry })
    } else if (action === "stop") {
      const entry = await stopTimeEntry(taskId)
      if (!entry) return apiJson({ entry: null, message: "No running timer for this task" })
      return apiJson({ entry })
    } else {
      return apiError("Invalid action. Use: start, stop", 400)
    }
  } catch (err) {
    return apiError("Failed to manage time entry")
  }
}
