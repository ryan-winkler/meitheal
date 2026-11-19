import type { APIRoute } from "astro"
import { TaskRepository, getPersistenceClient, persistManualCalendarConfirmation } from "@domains/tasks"
import { withBoardScope } from "@lib/board-http"
import { requestIntegrationBinding } from "@lib/integration-binding-access"
import { apiJson, apiError } from "@lib/api-response"

export const POST: APIRoute = withBoardScope({ resource: "task", action: "edit" }, async ({ request }, scope) => {
  const raw: unknown = await request.json().catch(() => null)
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return apiError("Choose a task and approved Calendar binding.", 400)
  const body = raw as Record<string, unknown>
  if (typeof body.taskId !== "string" || !body.taskId || Object.hasOwn(body, "board_id")) return apiError("Choose a task in the selected Board.", 400)
  const task = await new TaskRepository(getPersistenceClient(), scope).resolveTaskId(body.taskId, "edit")
  if (!task) return apiError("This task is unavailable.", 404)
  const approved = await requestIntegrationBinding(scope, "calendar", "calendar.sync", body, { resource: "task", action: "edit" })
  if (!approved?.ok) return apiError("This Calendar binding is unavailable.", 404)
  const requestId = typeof body.requestId === "string" && body.requestId.length <= 256 ? body.requestId : crypto.randomUUID()
  const persisted = await persistManualCalendarConfirmation({
    taskId: task.id, requestId, confirmationId: crypto.randomUUID(),
    ...(typeof body.providerEventId === "string" && body.providerEventId.length <= 512 ? { providerEventId: body.providerEventId } : {}),
    ...(Object.hasOwn(body, "payload") ? { payload: body.payload } : {}),
  }, approved.value)
  return apiJson({ taskId: task.id, requestId, ...persisted }, persisted.alreadyExisted ? 200 : 201)
}, { write: true })
