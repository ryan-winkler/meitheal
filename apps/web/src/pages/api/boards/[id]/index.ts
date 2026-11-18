import { verifyCurrentHAAdministrator } from "@domains/ha/current-admin"
import { isOrganizationFeatureAvailable as availableFeature } from "@lib/organization-request-context"
import { readHomeAssistantAreaFilter } from "@lib/home-assistant-area-access"
import type { APIRoute } from "astro"
import { ensureAgentTokenSchema } from "@domains/auth"
import { HierarchyRepository } from "@domains/tasks/persistence/hierarchy-repository"
import { NamedBoardTaskRepository } from "@domains/tasks/persistence/named-board-task-repository"
import { NamedBoardRepository } from "@domains/tasks/persistence/named-board-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { boardViewResponse, readBoardView } from "@lib/board-view"
import { HOUSEHOLD_BOARD_ID, readBoardWorkspaceSelection } from "@lib/board-workspace"
import { apiError, apiJson } from "@lib/api-response"
import { boardGroupCursor, boardSessionProof, currentBoardUser, readBoardGroupCursor, readBoardRequest } from "@lib/named-board-request"

export const GET: APIRoute = async context => {
  const { locals, request, params, url } = context
  const selector = url.searchParams.get("view")
  const agent = locals.agentToken
  if (selector === "groups" && !availableFeature("groups")) return apiError("Areas are unavailable.", 404)
  if (selector === "groups" && params.id === HOUSEHOLD_BOARD_ID && !agent) {
    await ensureSchema()
    const hierarchy = new HierarchyRepository(getPersistenceClient())
    const projection = await hierarchy.findAreaPage(url.searchParams.get("after"))
    const selectedId = url.searchParams.get("selected")
    const selected = selectedId ? await hierarchy.findAreaById(selectedId) : null
    const response = apiJson({ ...projection, ...(selectedId ? { selected: selected ? {
      id: selected.id, name: selected.name, icon: selected.icon, color: selected.color,
    } : null } : {}) })
    response.headers.set("cache-control", "private, no-store")
    return response
  }
  const user = agent ? null : await currentBoardUser(locals, request.signal)
  const actor = agent ? { kind: "agent", id: agent.tokenId } as const : user?.actor
  if (!actor || !params.id) return apiError("Board unavailable", 404)
  if (selector === "groups") {
    if (!user) return apiError("Board unavailable", 404)
    await ensureSchema()
    const areaId = url.searchParams.get("area")
    if (areaId && !availableFeature("projects")) return apiError("Projects are unavailable.", 404)
    const cursor = url.searchParams.get("after")
    const cursorScope = areaId ? JSON.stringify([params.id, areaId]) : params.id
    const after = cursor ? readBoardGroupCursor(user.actor.id, cursorScope, cursor) : null
    if (cursor && !after) return apiError("Area page unavailable", 404)
    const repository = new NamedBoardTaskRepository(getPersistenceClient())
    const projection = areaId
      ? await repository.projects(user.actor, params.id, areaId, after, url.searchParams.get("selected"))
      : await repository.groups(user.actor, params.id, after, url.searchParams.get("selected"))
    if (!projection) return apiError("Board unavailable", 404)
    const response = boardViewResponse(projection, user.actor.id, {
      ...projection,
      next_cursor: projection.next_cursor ? boardGroupCursor(user.actor.id, cursorScope, projection.next_cursor) : null,
    })
    response.headers.set("x-meitheal-board-session", boardSessionProof(user.actor.id))
    response.headers.set("cache-control", "private, no-store")
    return response
  }
  const offset = Number(url.searchParams.get("offset") ?? 0)
  if (!Number.isSafeInteger(offset) || offset < 0) return apiError("Choose a valid page", 400)
  const view = await readBoardView(actor, params.id, offset,
    selector === "tasks" ? readBoardWorkspaceSelection(url.searchParams) : undefined,
    selector === "tasks" ? await readHomeAssistantAreaFilter(context, url.searchParams) : undefined,
    selector === "tasks" && url.searchParams.get("kanban") === "1" ? { params: url.searchParams, timezone: locals.timezone } : undefined)
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

  if (body.action === "retire" || body.action === "restore") {
    if (locals.agentToken) return apiError("Board unavailable", 404)
    if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1) return apiError("Refresh the Board before changing it.", 400)
    if (id === HOUSEHOLD_BOARD_ID) {
      if (!user.isAdmin) return apiError("Board unavailable", 404)
      const verified = await verifyCurrentHAAdministrator(user.actor.id, request.signal)
      if (verified === "unavailable") return apiError("Home Assistant could not verify administrator access. Try again when it reconnects.", 503)
      if (verified !== "allowed") return apiError("Board unavailable", 404)
    }
    const result = await repository.changeLifecycle(user.actor, id, body.action === "restore" ? "active" : "retired", Number(body.revision), Boolean(user.isAdmin))
    if (result.status === "locked") return apiError("Board access is temporarily locked. Try again after it is restored.", 503)
    if (result.result === "unavailable") return apiError("Board unavailable", 404)
    if (result.result === "stale") return apiError("This Board changed. Refresh it before trying again.", 409)
    return apiJson({ ok: true, accessPending: result.status === "committed-locked" }, result.status === "committed-locked" ? 202 : 200)
  }
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
