import { DELETE as deleteTask } from "../../../tasks/[id]"
import { withBoardScope } from "@lib/board-http"
import { organizationPlacementAvailable } from "@lib/organization-placement-access"
import type { APIRoute } from "astro"
import { NamedBoardTaskRepository } from "@domains/tasks/persistence/named-board-task-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { apiError, apiJson } from "@lib/api-response"
import { readBoardRequest } from "@lib/named-board-request"
import { parseCalendarDay } from "@lib/calendar-day"
import { stripHtml } from "@lib/strip-html"

function rejected(error: "denied" | "stale" | "unavailable", reason?: "routine-date") {
  if (reason === "routine-date") return apiError("A generated Routine task keeps its original occurrence date. Complete the existing occurrence.", 409)
  if (error === "denied") return apiError("Your Board permissions do not allow this action.", 403)
  if (error === "stale") return apiError("This task has changed. Refresh the Board and try again.", 409)
  return apiError("Board or task unavailable", 404)
}

export const PATCH: APIRoute = withBoardScope({ resource: "task", action: "edit" }, async ({ request, params }, scope) => {
  const body = await readBoardRequest(request)
  if (body && !organizationPlacementAvailable(body)) return apiError("This organizing feature is unavailable.", 404)
  if (!body || typeof body.version !== "number" || !Number.isSafeInteger(body.version)) return apiError("Use a current task version.", 400)
  const actor = scope.principal
  if (!actor || !params.id || !params.ticket) return apiError("Board or task unavailable", 404)
  await ensureSchema()
  const repository = new NamedBoardTaskRepository(getPersistenceClient(), scope)
  if (body.action === "file") {
    const { areaId, projectId } = body
    if ((areaId != null && typeof areaId !== "string") || (projectId != null && typeof projectId !== "string")) {
      return apiError("Choose a valid Board group and Project.", 400)
    }
    const result = await repository.file(actor, params.id, params.ticket, body.version, areaId, projectId)
    return result.ok ? apiJson(result.value) : rejected(result.errorCode, "reason" in result ? result.reason : undefined)
  }
  if (typeof body.laneId === "string") {
    const result = await repository.move(actor, params.id, params.ticket, body.laneId, body.version)
    return result.ok ? apiJson(result.value) : rejected(result.errorCode, "reason" in result ? result.reason : undefined)
  }
  const dueDate = body.due_date
  if (dueDate !== undefined && dueDate !== null && (typeof dueDate !== "string" || !parseCalendarDay(dueDate))) {
    return apiError("Choose a valid due date.", 400)
  }
  if (dueDate !== undefined && body.title === undefined && body.description === undefined) {
    const result = await repository.edit(actor, params.id, params.ticket, body.version, { dueDate })
    return result.ok ? apiJson(result.value) : rejected(result.errorCode, "reason" in result ? result.reason : undefined)
  }
  const title = typeof body.title === "string" ? stripHtml(body.title.trim()) : ""
  const description = typeof body.description === "string" ? stripHtml(body.description.trim()) : ""
  if (!title || title.length > 500 || description.length > 10_000) return apiError("Enter a valid task title and description.", 400)
  const result = await repository.edit(actor, params.id, params.ticket, body.version, { title, description, ...(dueDate !== undefined ? { dueDate } : {}) })
  return result.ok ? apiJson(result.value) : rejected(result.errorCode, "reason" in result ? result.reason : undefined)
}, { boardParam: "id", recordResource: "task", recordParam: "ticket" })

export const DELETE: APIRoute = withBoardScope({ resource: "task", action: "delete" }, async (context, scope) => {
  const body: unknown = await context.request.clone().json().catch(() => null)
  if (!body || typeof body !== "object" || !("version" in body) || typeof body.version !== "number" || !Number.isSafeInteger(body.version)) return apiError("Use a current task version.", 400)
  const headers = new Headers(context.request.headers)
  headers.set("X-Meitheal-Board-Id", scope.boardId)
  return deleteTask({ ...context, params: { ...context.params, id: context.params.ticket }, request: new Request(context.request, { headers }) })
}, { boardParam: "id", recordResource: "task", recordParam: "ticket" })
