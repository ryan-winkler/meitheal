import type { APIContext, APIRoute } from "astro"
import { TaskRepository, getPersistenceClient, validateIntegrationScope, scopePermits, hasBoardSelection, type BoardScope, type IntegrationScope } from "@domains/tasks"
import { getTodoItems } from "@domains/ha"
import { todoRequestBinding } from "./index"
import { withBoardScope } from "@lib/board-http"
import { apiError, apiJson } from "@lib/api-response"
import { readBoardRequest } from "@lib/named-board-request"
import { POST as createTask } from "../tasks/index"
import { PUT as updateTask, DELETE as deleteTask } from "../tasks/[id]"
import { haStatusToMeitheal } from "@domains/todo"

async function itemsForBinding(context: IntegrationScope, completedOnly = false) {
  const db = getPersistenceClient()
  const operationAllowed = async () => (await validateIntegrationScope(context, db, { resource: "task", action: "read" })).ok
  let items
  try { items = await getTodoItems(context.binding.sourceId, completedOnly ? ["completed"] : undefined, { operationAllowed, throwOnError: true }) } catch { return null }
  if (!await operationAllowed()) return null
  const matches = await new TaskRepository(db, context.scope).findTasksByExternalSyncIds({ source: "ha_todo", entityId: context.binding.sourceId,
    externalIds: items.map(item => item.uid).filter((id): id is string => typeof id === "string") }, context)
  return items.flatMap(item => {
    const match = item.uid ? matches.get(item.uid) : null
    return match && !match.taskDeleted && !match.suppressed && match.taskId ? [{ ...item, task_id: match.taskId }] : []
  })
}
function taskContext(context: APIContext, scope: BoardScope, method: string, taskId?: string, body?: unknown): APIContext {
  const url = new URL(taskId ? `/api/tasks/${encodeURIComponent(taskId)}` : "/api/tasks", context.request.url)
  const headers = new Headers(context.request.headers)
  headers.set("X-Meitheal-Board-Id", scope.boardId)
  headers.set("Content-Type", "application/json")
  return { ...context, url, params: taskId ? { id: taskId } : {}, request: new Request(url, { method, headers, signal: context.request.signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) }
}
async function boundTask(scope: BoardScope, binding: IntegrationScope, input: Record<string, unknown>, action: "edit" | "delete"): Promise<string | null> {
  if (typeof input.task_id === "string") {
    const task = await new TaskRepository(getPersistenceClient(), scope).resolveTaskId(input.task_id, action)
    if (!task) return null
    const snapshot = await new TaskRepository(getPersistenceClient(), binding.scope).findSyncConfirmation(task.id, binding)
    return snapshot?.confirmation ? task.id : null
  }
  if (typeof input.item !== "string") return null
  const matches = await new TaskRepository(getPersistenceClient(), binding.scope).findTasksByExternalSyncIds({ source: "ha_todo", entityId: binding.binding.sourceId, externalIds: [input.item] }, binding)
  const match = matches.get(input.item)
  return match && !match.taskDeleted && !match.suppressed && match.taskId ? match.taskId : null
}

export const GET: APIRoute = withBoardScope({ resource: "task", action: "read" }, async (context, scope) => {
  const input = Object.fromEntries(context.url.searchParams)
  const binding = await todoRequestBinding(scope, { ...input, generation: Number(input.generation) }, { resource: "task", action: "read" })
  if (!binding) return apiError("Choose an accessible current Todo binding.", 404)
  const items = await itemsForBinding(binding)
  return items ? apiJson({ ok: true, items }) : apiError("Todo items could not be confirmed. Check the Home Assistant connection and retry.", 503)
})

/** Todo compatibility writes use the same task commands, events, ceilings and receipts. */
export const POST: APIRoute = withBoardScope({ resource: "task", action: "create" }, async (context, scope) => {
  if (context.request.headers.has("x-meitheal-capture-attempt")) return apiError("Use the canonical task capture endpoint.", 400)
  const body = await readBoardRequest(context.request)
  if (body && hasBoardSelection(body)) return apiError("Select the Board using the request context.", 400)
  if (!body || typeof body.summary !== "string") return apiError("Provide a task summary and current Todo binding.", 400)
  const binding = await todoRequestBinding(scope, body, { resource: "task", action: "create" })
  if (!binding) return apiError("This Todo binding is unavailable.", 404)
  return createTask(taskContext(context, scope, "POST", undefined, { title: body.summary, description: body.description ?? "",
    due_date: body.due ?? null, area_id: binding.binding.destination.areaId ?? null, project_id: binding.binding.destination.projectId ?? null }))
})

export const PUT: APIRoute = withBoardScope({ resource: "task", action: "edit" }, async (context, scope) => {
  const body = await readBoardRequest(context.request)
  if (body && hasBoardSelection(body)) return apiError("Select the Board using the request context.", 400)
  if (!body) return apiError("Provide a linked task and current Todo binding.", 400)
  const binding = await todoRequestBinding(scope, body, { resource: "task", action: "edit" })
  if (!binding) return apiError("This Todo binding is unavailable.", 404)
  const taskId = await boundTask(scope, binding, body, "edit")
  if (!taskId) return apiError("This linked task is unavailable.", 404)
  if (body.status !== undefined && body.status !== "needs_action" && body.status !== "completed") return apiError("Choose a valid Todo status.", 400)
  if (body.due_date !== undefined && body.due_datetime !== undefined) return apiError("Choose one due date format.", 400)
  const updates: Record<string, unknown> = {
    ...(body.rename === undefined ? {} : { title: body.rename }), ...(body.description === undefined ? {} : { description: body.description }),
    ...(body.status === undefined ? {} : { status: haStatusToMeitheal(body.status) }),
    ...(body.due_date === undefined && body.due_datetime === undefined ? {} : { due_date: body.due_date ?? body.due_datetime }),
    ...(body.updated_at === undefined ? {} : { updated_at: body.updated_at }),
  }
  return updateTask(taskContext(context, scope, "PUT", taskId, updates))
})

export const DELETE: APIRoute = withBoardScope({ resource: "task", action: "delete" }, async (context, scope) => {
  const body = await readBoardRequest(context.request)
  if (body && hasBoardSelection(body)) return apiError("Select the Board using the request context.", 400)
  if (!body) return apiError("Choose linked tasks and a current Todo binding.", 400)
  const binding = await todoRequestBinding(scope, body, { resource: "task", action: "delete" })
  if (!binding) return apiError("This Todo binding is unavailable.", 404)
  let ids: string[]
  if (typeof body.task_id === "string") {
    const id = await boundTask(scope, binding, body, "delete")
    ids = id ? [id] : []
  } else {
    if (!scopePermits(scope, { resource: "task", action: "read" })) return apiError("Read this Board to choose linked tasks.", 403)
    if (body.clear_completed !== true && (!Array.isArray(body.items) || !body.items.length || body.items.length > 100 || !body.items.every(item => typeof item === "string"))) return apiError("Choose linked item IDs or completed work.", 400)
    const items = await itemsForBinding(binding, body.clear_completed === true)
    if (!items) return apiError("Todo items could not be confirmed. Check the Home Assistant connection and retry.", 503)
    ids = items.filter(item => body.clear_completed === true || (body.items as string[]).includes(item.uid!)).map(item => item.task_id)
  }
  if (!ids.length) return apiError("No linked task is available.", 404)
  const deleted: string[] = []
  for (const id of [...new Set(ids)]) {
    const response = await deleteTask(taskContext(context, scope, "DELETE", id))
    if (!response.ok) return apiJson({ ok: false, deleted, error: "Some tasks could not be deleted. Refresh before continuing." }, response.status)
    deleted.push(id)
  }
  return apiJson({ ok: true, deleted })
})
