import type { APIRoute } from "astro"
import { NamedBoardTaskRepository } from "@domains/tasks/persistence/named-board-task-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { apiError, apiJson } from "@lib/api-response"
import { currentBoardTaskActor, readBoardRequest } from "@lib/named-board-request"
import { stripHtml } from "@lib/strip-html"

export const POST: APIRoute = async ({ locals, request, params }) => {
  const body = await readBoardRequest(request)
  const title = typeof body?.title === "string" ? stripHtml(body.title.trim()) : ""
  const description = typeof body?.description === "string" ? stripHtml(body.description.trim()) : ""
  if (!body || !title || title.length > 500 || description.length > 10_000) return apiError("Enter a valid task title and description.", 400)
  const actor = await currentBoardTaskActor(locals, request, true)
  if (!actor || !params.id) return apiError("Board unavailable", 404)
  await ensureSchema()
  const repository = new NamedBoardTaskRepository(getPersistenceClient())
  const result = await repository.create(actor, params.id, { title, description }, {
    ...(typeof body.laneId === "string" ? { laneId: body.laneId } : {}),
    ...(typeof body.areaId === "string" ? { areaId: body.areaId } : {}),
    ...(typeof body.projectId === "string" ? { projectId: body.projectId } : {}),
    ...(typeof body.goalId === "string" ? { goalId: body.goalId } : {}),
  })
  if (result.ok) return apiJson(result.value, 201)
  if (result.errorCode === "denied") return apiError("Your Board permissions do not allow this action.", 403)
  return apiError("Board or placement unavailable", 404)
}
