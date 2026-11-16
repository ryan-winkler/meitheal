import type { APIRoute } from "astro"
import { BoardIntakeRepository } from "@domains/tasks/persistence/board-intake-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { apiError, apiJson } from "@lib/api-response"
import { currentBoardUser, readBoardRequest } from "@lib/named-board-request"
import { stripHtml } from "@lib/strip-html"

export const POST: APIRoute = async ({ locals, request, params }) => {
  const body = await readBoardRequest(request)
  const user = await currentBoardUser(locals, request.signal, request)
  if (!user || !params.id) return apiError("Board unavailable", 404)
  const label = typeof body?.label === "string" ? stripHtml(body.label.trim()) : ""
  const senderIds = body?.senderIds
  if (!body || !label || label.length > 100 || typeof body.laneId !== "string" || !Array.isArray(senderIds)
    || senderIds.length < 1 || senderIds.length > 50 || !senderIds.every(id => typeof id === "string" && user.roster.has(id))) {
    return apiError("Choose a name, a triage column, and eligible senders.", 400)
  }
  const recipient = typeof body.recipientId === "string" && body.recipientId ? body.recipientId : undefined
  if (recipient && !user.roster.has(recipient)) return apiError("Choose an active recipient.", 400)
  await ensureSchema()
  const repository = new BoardIntakeRepository(getPersistenceClient())
  const result = await repository.create(user.actor.id, params.id, {
    label, laneId: body.laneId,
    senders: [...new Set<string>(senderIds)].map(id => ({ kind: "ha_user", id })),
    ...(recipient ? { recipientUserId: recipient } : {}),
  })
  if (result.status === "locked") return apiError("Named Board access is temporarily locked.", 503)
  if (!result.result) return apiError("Board or intake destination unavailable", 404)
  return apiJson({ ...result.result, accessPending: result.status === "committed-locked" }, 201)
}

export const PATCH: APIRoute = async ({ locals, request, params }) => {
  const body = await readBoardRequest(request)
  const user = await currentBoardUser(locals, request.signal, request)
  if (!user || !params.id) return apiError("Board unavailable", 404)
  if (!body || typeof body.id !== "string" || typeof body.enabled !== "boolean") return apiError("Choose an intake destination.", 400)
  await ensureSchema()
  const repository = new BoardIntakeRepository(getPersistenceClient())
  const result = await repository.setEnabled(user.actor.id, params.id, body.id, body.enabled)
  if (result.status === "locked") return apiError("Named Board access is temporarily locked.", 503)
  if (!result.result) return apiError("Intake destination unavailable or already set", 404)
  return apiJson({ ok: true, accessPending: result.status === "committed-locked" })
}
