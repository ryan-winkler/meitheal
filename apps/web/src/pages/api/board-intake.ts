import { isCurrentActiveHAUser } from "@domains/ha/ha-users"
import type { APIRoute } from "astro"
import { BoardIntakeRepository } from "@domains/tasks/persistence/board-intake-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { apiError, apiJson } from "@lib/api-response"
import { currentBoardContext, readBoardRequest } from "@lib/named-board-request"
import { stripHtml } from "@lib/strip-html"

const resumeIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

function submission(body: Record<string, unknown>) {
  const title = typeof body.title === "string" ? stripHtml(body.title.trim()) : ""
  const description = typeof body.description === "string" ? stripHtml(body.description.trim()) : ""
  return title && title.length <= 500 && description.length <= 10_000
    ? { title, description, assignToRecipient: body.assignToRecipient === true }
    : null
}

export const GET: APIRoute = async context => {
  const { locals, request } = context
  const user = await currentBoardContext(context)
  if (!user) return apiError("Open Meitheal through Home Assistant to send work.", 403)
  await ensureSchema()
  const repository = new BoardIntakeRepository(getPersistenceClient(), user.principal)
  const [destinations, submissions] = await Promise.all([
    repository.findDestinations(user.actor), repository.findSubmissions(user.actor),
  ])
  return apiJson({ destinations, submissions })
}

export const POST: APIRoute = async context => {
  const { locals, request } = context
  const body = await readBoardRequest(request)
  const user = await currentBoardContext(context, true)
  if (!user) return apiError("Open Meitheal through Home Assistant to send work.", 403)
  if (!body) return apiError("Use a valid JSON request.", 400)
  await ensureSchema()
  const repository = new BoardIntakeRepository(getPersistenceClient(), user.principal)
  if (body.action === "prepare" && typeof body.id === "string") {
    const draft = body.resumeId === undefined ? null : submission(body)
    if (body.resumeId !== undefined && (typeof body.resumeId !== "string" || !resumeIdPattern.test(body.resumeId) || !draft)) {
      return apiError("Enter a valid task title and description.", 400)
    }
    const result = draft && typeof body.resumeId === "string"
      ? await repository.issue(user.actor, body.id, Date.now(), { ...draft, resumeId: body.resumeId })
      : await repository.issue(user.actor, body.id)
    if (result.ok) return apiJson(result.value, 201)
    if (result.errorCode === "quota") return apiError("Your send limit is reached. You can retry an existing submission.", 429)
    if (result.errorCode === "conflict") return apiError("This submission already has different content.", 409)
    return apiError("This destination is unavailable.", 404)
  }
  const locator = body.action === "retry" && typeof body.resumeId === "string" ? { resumeId: body.resumeId }
    : body.action === "send" && typeof body.token === "string" ? { token: body.token } : null
  const recipient = locator ? await repository.findSubmissionRecipient(user.actor, locator) : null
  const currentUsers = recipient && await isCurrentActiveHAUser(recipient, { fresh: true, signal: request.signal }) ? [recipient] : []
  if (body.action === "retry" && typeof body.resumeId === "string" && resumeIdPattern.test(body.resumeId)) {
    const result = await repository.retry(user.actor, body.resumeId, currentUsers)
    if (result.ok) return apiJson(result.value)
    if (result.errorCode === "quota") return apiError("Your daily send limit is reached.", 429)
    return apiError("This submission or destination is unavailable.", 404)
  }
  if (body.action === "send" && typeof body.token === "string") {
    const content = submission(body)
    if (!content) return apiError("Enter a valid task title and description.", 400)
    const result = await repository.submit(user.actor, body.token, content, currentUsers)
    if (result.ok) return apiJson(result.value)
    if (result.errorCode === "quota") return apiError("Your daily send limit is reached.", 429)
    if (result.errorCode === "conflict") return apiError("This submission has already accepted different content. Start a new submission.", 409)
    return apiError("This submission or destination is unavailable.", 404)
  }
  return apiError("Choose a supported send action.", 400)
}
