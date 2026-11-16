import type { APIRoute } from "astro"
import { ensureAgentTokenSchema } from "@domains/auth"
import { NamedBoardRepository } from "@domains/tasks/persistence/named-board-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { boardViewResponse, readBoardView } from "@lib/board-view"
import { apiError, apiJson } from "@lib/api-response"
import { boardSessionProof, currentBoardUser, readBoardRequest } from "@lib/named-board-request"

export const GET: APIRoute = async ({ locals, request, params, url }) => {
  const agent = locals.agentToken
  const user = agent ? null : await currentBoardUser(locals, request.signal)
  const actor = agent ? { kind: "agent", id: agent.tokenId } as const : user?.actor
  if (!actor || !params.id) return apiError("Board unavailable", 404)
  const offset = Number(url.searchParams.get("offset") ?? 0)
  if (!Number.isSafeInteger(offset) || offset < 0) return apiError("Choose a valid page", 400)
  const view = await readBoardView(actor, params.id, offset)
  if (!view) return apiError("Board unavailable", 404)
  if (!user) return apiJson(view)
  const response = boardViewResponse(view, user.actor.id, {
    ...view,
    people: view.board.role === "owner" ? [...user.roster].map(([id, name]) => ({ id, name })) : [],
  })
  response.headers.set("x-meitheal-board-session", boardSessionProof(user.actor.id))
  return response
}

export const HEAD = GET

export const PATCH: APIRoute = async ({ locals, request, params }) => {
  const body = await readBoardRequest(request)
  const user = await currentBoardUser(locals, request.signal, request)
  if (!user || !params.id) return apiError("Board unavailable", 404)
  if (!body) return apiError("Use a valid JSON request.", 400)
  await ensureSchema()
  const repository = new NamedBoardRepository(getPersistenceClient())
  const id = params.id

  if (body.action === "sidebar" && typeof body.hidden === "boolean") {
    return await repository.setSidebarHidden(user.actor, id, body.hidden)
      ? apiJson({ ok: true }) : apiError("Board unavailable", 404)
  }
  if (body.action === "policy" && typeof body.denyCompletion === "boolean" &&
      typeof body.denyDeletion === "boolean" && typeof body.denyAgentDeletion === "boolean") {
    const result = await repository.updateRestrictions(user.actor.id, id, {
      denyCompletion: body.denyCompletion, denyDeletion: body.denyDeletion, denyAgentDeletion: body.denyAgentDeletion,
    })
    if (result.status === "locked") return apiError("Named Board access is temporarily locked.", 503)
    if (!result.result) return apiError("Board unavailable", 404)
    return apiJson({ ok: true, accessPending: result.status === "committed-locked" })
  }
  if (body.action === "agent" && typeof body.tokenId === "string" &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.tokenId) && typeof body.enabled === "boolean") {
    await ensureAgentTokenSchema()
    const result = await repository.updateAgent(user.actor.id, id, body.tokenId, body.enabled)
    if (result.status === "locked") return apiError("Named Board access is temporarily locked.", 503)
    if (!result.result) return apiError("Board or eligible agent token unavailable", 404)
    return apiJson({ ok: true, accessPending: result.status === "committed-locked" })
  }
  if (body.action === "member" && typeof body.memberId === "string") {
    const role = body.role
    if (role !== null && role !== "owner" && role !== "member" && role !== "viewer") {
      return apiError("Choose Owner, Member or Viewer.", 400)
    }
    const result = await repository.updateMember(user.actor.id, id, body.memberId, role === null ? null : {
      role, denyCompletion: body.denyCompletion === true, denyDeletion: body.denyDeletion === true,
    }, [...user.roster.keys()])
    if (result.status === "locked") return apiError("Named Board access is temporarily locked.", 503)
    if (result.result === "last-owner") return apiError("Add another active owner before removing this owner.", 409)
    if (result.result === "unavailable") return apiError("Board or person unavailable", 404)
    return apiJson({ ok: true, accessPending: result.status === "committed-locked" })
  }
  return apiError("Choose a supported Board setting.", 400)
}
