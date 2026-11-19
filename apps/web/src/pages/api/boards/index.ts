import { isOrganizationFeatureAvailable as available } from "@lib/organization-request-context"
import type { APIRoute } from "astro"
import { isNamedBoardPreset } from "@domains/tasks"
import { NamedBoardRepository } from "@domains/tasks/persistence/named-board-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { boardViewResponse, readBoardDirectory } from "@lib/board-view"
import { apiError, apiJson } from "@lib/api-response"
import { boardSessionProof, currentBoardUser, readBoardRequest } from "@lib/named-board-request"
import { stripHtml } from "@lib/strip-html"

export const GET: APIRoute = async ({ locals, request }) => {
  const user = await currentBoardUser(locals, request.signal)
  if (!user) return apiError("Open Meitheal through Home Assistant to view your Boards.", 403)
  const directory = await readBoardDirectory(user.actor, Boolean(user.isAdmin))
  const response = boardViewResponse(directory, user.actor.id)
  response.headers.set("x-meitheal-board-session", boardSessionProof(user.actor.id))
  response.headers.set("cache-control", "private, no-store")
  return response
}

export const HEAD = GET

export const POST: APIRoute = async ({ locals, request }) => {
  const body = await readBoardRequest(request)
  const name = typeof body?.name === "string" ? stripHtml(body.name.trim()) : ""
  if (!name || name.length > 100) return apiError("Enter a Board name of 1 to 100 characters.", 400)
  const preset = body?.preset
  if (preset !== undefined && !isNamedBoardPreset(preset)) return apiError("Choose an available Board preset.", 400)
  if (!available("organizer")) return apiError("The Boards organizer is unavailable.", 404)
  const user = await currentBoardUser(locals, request.signal, request)
  if (!user) return apiError("Open Meitheal through Home Assistant to create a Board.", 403)
  await ensureSchema()
  const repository = new NamedBoardRepository(getPersistenceClient())
  const result = await repository.create(user.actor.id, name, preset)
  if (result.status === "committed") return apiJson(result.result, 201)
  if (result.status === "committed-locked") return apiJson({ ...result.result, accessPending: true }, 202)
  return apiError("Named Board access is temporarily locked.", 503)
}
