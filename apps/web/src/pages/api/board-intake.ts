import type { APIRoute } from "astro"
import { BoardIntakeRepository } from "@domains/tasks/persistence/board-intake-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { apiError, apiJson } from "@lib/api-response"
import { currentBoardUser, readBoardRequest } from "@lib/named-board-request"
import { stripHtml } from "@lib/strip-html"

export const GET: APIRoute = async ({ locals, request }) => {
  const user = await currentBoardUser(locals, request.signal)
  if (!user) return apiError("Open Meitheal through Home Assistant to send work.", 403)
  await ensureSchema()
  return apiJson({ destinations: await new BoardIntakeRepository(getPersistenceClient()).findDestinations(user.actor) })
}

export const POST: APIRoute = async ({ locals, request }) => {
  const body = await readBoardRequest(request)
  const user = await currentBoardUser(locals, request.signal, request)
  if (!user) return apiError("Open Meitheal through Home Assistant to send work.", 403)
  if (!body) return apiError("Use a valid JSON request.", 400)
  await ensureSchema()
  const repository = new BoardIntakeRepository(getPersistenceClient())
  if (body.action === "prepare" && typeof body.id === "string") {
    const result = await repository.issue(user.actor, body.id)
    if (result.ok) return apiJson(result.value, 201)
    if (result.errorCode === "quota") return apiError("Your send limit is reached. You can retry an existing submission.", 429)
    return apiError("This destination is unavailable.", 404)
  }
  if (body.action === "send" && typeof body.token === "string") {
    const title = typeof body.title === "string" ? stripHtml(body.title.trim()) : ""
    const description = typeof body.description === "string" ? stripHtml(body.description.trim()) : ""
    if (!title || title.length > 500 || description.length > 10_000) return apiError("Enter a valid task title and description.", 400)
    const result = await repository.submit(user.actor, body.token, {
      title, description, assignToRecipient: body.assignToRecipient === true,
    }, [...user.roster.keys()])
    if (result.ok) return apiJson(result.value)
    if (result.errorCode === "quota") return apiError("Your daily send limit is reached.", 429)
    if (result.errorCode === "conflict") return apiError("This submission has already accepted different content. Start a new submission.", 409)
    return apiError("This submission or destination is unavailable.", 404)
  }
  return apiError("Choose a supported send action.", 400)
}
