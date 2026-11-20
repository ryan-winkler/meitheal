import { boardScopeErrorResponse } from "@lib/board-http"
import { isOrganizationFeatureAvailable as available } from "@lib/organization-request-context"
import type { APIRoute } from "astro"
import { isNamedBoardPreset } from "@domains/tasks"
import { NamedBoardRepository } from "@domains/tasks/persistence/named-board-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { assertBoardDirectoryCurrent, boardViewResponse, readBoardDirectory } from "@lib/board-view"
import { apiError, apiJson } from "@lib/api-response"
import { boardSessionProof, currentBoardContext, readBoardRequest } from "@lib/named-board-request"
import { stripHtml } from "@lib/strip-html"

export const GET: APIRoute = async (context) => {
  try {
    const user = await currentBoardContext(context)
    if (!user) return apiError("Use your current authenticated session to view Boards.", 403)
    const directory = await readBoardDirectory(user.actor, context.request)
    const response = boardViewResponse(directory, user.actor.id)
    response.headers.set("x-meitheal-board-session", boardSessionProof(user.actor.id))
    response.headers.set("cache-control", "private, no-store")
    await assertBoardDirectoryCurrent(directory)
    return response
  } catch (error) {
    const failure = boardScopeErrorResponse(error)
    if (failure) return failure
    throw error
  }
}

export const HEAD = GET

const createBoard: APIRoute = async (context) => {
  const { request } = context
  const body = await readBoardRequest(request)
  const name = typeof body?.name === "string" ? stripHtml(body.name.trim()) : ""
  if (!name || name.length > 100) return apiError("Enter a Board name of 1 to 100 characters.", 400)
  const preset = body?.preset
  if (preset !== undefined && !isNamedBoardPreset(preset))
    return apiError("Choose an available Board preset.", 400)
  if (!available("organizer")) return apiError("The Boards organizer is unavailable.", 404)
  const user = await currentBoardContext(context, true)
  if (!user) return apiError("Use your current authenticated session to create a Board.", 403)
  await ensureSchema()
  const repository = new NamedBoardRepository(getPersistenceClient())
  const result = await repository.create(user.principal, name, preset)
  if (result.status === "committed") return apiJson(result.result, 201)
  if (result.status === "committed-locked")
    return apiJson({ ...result.result, accessPending: true }, 202)
  return apiError("Board access is temporarily locked.", 503)
}

export const POST: APIRoute = async (context) => {
  try {
    return await createBoard(context)
  } catch (error) {
    const failure = boardScopeErrorResponse(error)
    if (failure) return failure
    throw error
  }
}
