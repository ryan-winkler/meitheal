import type { APIRoute } from "astro"
import { NamedBoardTaskRepository } from "@domains/tasks/persistence/named-board-task-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { apiError, apiJson } from "@lib/api-response"
import { currentBoardTaskActor, readBoardRequest } from "@lib/named-board-request"
import { stripHtml } from "@lib/strip-html"

function rejected(error: "denied" | "stale" | "unavailable") {
  if (error === "denied") return apiError("Your Board permissions do not allow this action.", 403)
  if (error === "stale") return apiError("This task has changed. Refresh the Board and try again.", 409)
  return apiError("Board or task unavailable", 404)
}

export const PATCH: APIRoute = async ({ locals, request, params }) => {
  const body = await readBoardRequest(request)
  if (!body || typeof body.version !== "number" || !Number.isSafeInteger(body.version)) return apiError("Use a current task version.", 400)
  const actor = await currentBoardTaskActor(locals, request, true)
  if (!actor || !params.id || !params.ticket) return apiError("Board or task unavailable", 404)
  await ensureSchema()
  const repository = new NamedBoardTaskRepository(getPersistenceClient())
  if (body.action === "file") {
    const { areaId, projectId } = body
    if ((areaId != null && typeof areaId !== "string") || (projectId != null && typeof projectId !== "string")) {
      return apiError("Choose a valid Board group and Project.", 400)
    }
    const result = await repository.file(actor, params.id, params.ticket, body.version, areaId, projectId)
    return result.ok ? apiJson(result.value) : rejected(result.errorCode)
  }
  if (typeof body.laneId === "string") {
    const result = await repository.move(actor, params.id, params.ticket, body.laneId, body.version)
    return result.ok ? apiJson(result.value) : rejected(result.errorCode)
  }
  const title = typeof body.title === "string" ? stripHtml(body.title.trim()) : ""
  const description = typeof body.description === "string" ? stripHtml(body.description.trim()) : ""
  if (!title || title.length > 500 || description.length > 10_000) return apiError("Enter a valid task title and description.", 400)
  const result = await repository.edit(actor, params.id, params.ticket, body.version, { title, description })
  return result.ok ? apiJson(result.value) : rejected(result.errorCode)
}

export const DELETE: APIRoute = async ({ locals, request, params }) => {
  const body = await readBoardRequest(request)
  if (!body || typeof body.version !== "number" || !Number.isSafeInteger(body.version)) return apiError("Use a current task version.", 400)
  const actor = await currentBoardTaskActor(locals, request, true)
  if (!actor || !params.id || !params.ticket) return apiError("Board or task unavailable", 404)
  await ensureSchema()
  const repository = new NamedBoardTaskRepository(getPersistenceClient())
  const result = await repository.delete(actor, params.id, params.ticket, body.version)
  return result.ok ? apiJson({ ok: true }) : rejected(result.errorCode)
}
