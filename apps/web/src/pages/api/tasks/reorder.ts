/**
 * POST /api/tasks/reorder — Persist kanban card positions within a lane.
 *
 * Body: { ordered_ids: string[] }
 *   - ordered_ids: task IDs in the user's desired order
 *
 * Sets kanban_position = index for each task ID in the array.
 * Alternatively, { task_id, anchor_id, lane, before } moves a card relative to a
 * neighbor in the full lane, including rows outside the visible page.
 */
import type { APIRoute } from "astro"
import {
  ensureSchema,
  getPersistenceClient,
} from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { apiLogger, logApiError } from "../../../lib/api-logger"

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json() as Record<string, unknown>
    if (body && "task_id" in body) {
      const { task_id, anchor_id, lane, before } = body
      if (typeof task_id !== "string" || typeof anchor_id !== "string" || task_id === anchor_id ||
          typeof lane !== "string" || typeof before !== "boolean") {
        return new Response(JSON.stringify({ error: "Invalid card order" }), {
          status: 400, headers: { "content-type": "application/json" },
        })
      }
      await ensureSchema()
      const repo = new TaskRepository(getPersistenceClient())
      const ok = await repo.reorderKanbanCard({ id: task_id, anchorId: anchor_id, lane, before })
      return new Response(JSON.stringify(ok ? { ok } : { error: "The cards are no longer in the same lane" }), {
        status: ok ? 200 : 409, headers: { "content-type": "application/json" },
      })
    }

    if (
      !body?.ordered_ids ||
      !Array.isArray(body.ordered_ids) ||
      body.ordered_ids.length === 0
    ) {
      return new Response(
        JSON.stringify({ error: "ordered_ids array required" }),
        { status: 400, headers: { "content-type": "application/json" } },
      )
    }

    await ensureSchema()
    const repo = new TaskRepository(getPersistenceClient())

    await repo.reorderTasks(
      body.ordered_ids.map((id: string, idx: number) => ({ id, position: idx }))
    )
    apiLogger.log("info", { event: "reorder.success", domain: "tasks", component: "reorder", request_id: "kanban-reorder", message: `Reordered ${body.ordered_ids.length} tasks` })

    return new Response(
      JSON.stringify({ ok: true, count: body.ordered_ids.length }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  } catch (err: unknown) {
    logApiError("POST", "/api/tasks/reorder", err)
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    })
  }
}
