import { boardScopeErrorResponse, withBoardScope } from "@lib/board-http"
import { scopeBoardAccess } from "@domains/tasks/board-scope"
import { isOrganizationFeatureAvailable as availableFeature } from "@lib/organization-request-context"
import { readHomeAssistantAreaFilter } from "@lib/home-assistant-area-access"
import type { APIRoute } from "astro"
import { ensureAgentTokenSchema } from "@domains/auth"
import { HierarchyRepository } from "@domains/tasks/persistence/hierarchy-repository"
import { NamedBoardTaskRepository } from "@domains/tasks/persistence/named-board-task-repository"
import { NamedBoardRepository } from "@domains/tasks/persistence/named-board-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import {
  boardAuthorityKey,
  boardScopeAuthorityKey,
  boardViewResponse,
  readBoardView
} from "@lib/board-view"
import { readBoardWorkspaceSelection } from "@lib/board-workspace"
import { apiError, apiJson } from "@lib/api-response"
import {
  boardGroupCursor,
  boardSessionProof,
  currentBoardContext,
  currentBoardUser,
  readBoardGroupCursor,
  readBoardRequest
} from "@lib/named-board-request"

export const GET: APIRoute = withBoardScope(
  { resource: "task", action: "read" },
  async (context, scope) => {
    const { locals, params, url } = context
    const selector = url.searchParams.get("view")
    const user = locals.agentToken ? null : await currentBoardContext(context)
    const actor = scope.principal
    if (!params.id) return apiError("Board unavailable", 404)
    if (selector === "authority") {
      const response = apiJson({ board_id: scope.boardId })
      response.headers.set("x-meitheal-board-authority", boardScopeAuthorityKey(scope))
      response.headers.set("x-meitheal-board-view", boardScopeAuthorityKey(scope))
      if (user) response.headers.set("x-meitheal-board-session", boardSessionProof(actor.id))
      return response
    }
    if (selector === "groups") {
      if (!availableFeature("groups")) return apiError("Areas are unavailable.", 404)
      const areaId = url.searchParams.get("area")
      if (areaId && !availableFeature("projects")) return apiError("Projects are unavailable.", 404)
      const cursor = url.searchParams.get("after")
      const cursorScope = areaId ? JSON.stringify([scope.boardId, areaId]) : scope.boardId
      const after = cursor ? readBoardGroupCursor(actor.id, cursorScope, cursor) : null
      if (cursor && !after) return apiError("Area page unavailable", 404)
      const hierarchy = new HierarchyRepository(getPersistenceClient(), scope)
      if (areaId && !(await hierarchy.findAreaById(areaId)))
        return apiError("Area unavailable", 404)
      const selectedId = url.searchParams.get("selected")
      let projection
      if (areaId) {
        const page = await hierarchy.findProjectPage(areaId, after, selectedId)
        if (!page) return apiError("Project page unavailable", 404)
        projection = page
      } else {
        const page = await hierarchy.findAreaPage(after)
        const selected = selectedId ? await hierarchy.findAreaById(selectedId) : null
        projection = {
          ...page,
          ...(selectedId
            ? {
                selected: selected
                  ? {
                      id: selected.id,
                      name: selected.name,
                      icon: selected.icon,
                      color: selected.color
                    }
                  : null
              }
            : {})
        }
      }
      const response = boardViewResponse(projection, actor.id, {
        ...projection,
        next_cursor: projection.next_cursor
          ? boardGroupCursor(actor.id, cursorScope, projection.next_cursor)
          : null
      })
      if (user) response.headers.set("x-meitheal-board-session", boardSessionProof(actor.id))
      return response
    }
    const offset = Number(url.searchParams.get("offset") ?? 0)
    if (!Number.isSafeInteger(offset) || offset < 0) return apiError("Choose a valid page", 400)
    const view = await readBoardView(
      scope,
      actor,
      params.id,
      offset,
      selector === "tasks" ? readBoardWorkspaceSelection(url.searchParams) : undefined,
      selector === "tasks"
        ? await readHomeAssistantAreaFilter(context, url.searchParams)
        : undefined,
      selector === "tasks" && url.searchParams.get("kanban") === "1"
        ? { params: url.searchParams, timezone: locals.timezone }
        : undefined
    )
    if (!view) return apiError("Board unavailable", 404)
    const response = boardViewResponse(view, actor.id, {
      ...view,
      people:
        user && scopeBoardAccess(scope).role === "owner"
          ? [...user.roster].map(([id, name]) => ({ id, name }))
          : []
    })
    if (user) response.headers.set("x-meitheal-board-session", boardSessionProof(actor.id))
    response.headers.set("x-meitheal-board-authority", boardAuthorityKey(view, actor.id))
    return response
  },
  { boardParam: "id" }
)

export const HEAD = GET

const patchBoard: APIRoute = async (context) => {
  const { locals, request, params } = context
  const body = await readBoardRequest(request)
  const user = await currentBoardContext(context, true)
  if (!user || !params.id) return apiError("Board unavailable", 404)
  if (!body) return apiError("Use a valid JSON request.", 400)
  await ensureSchema()
  const repository = new NamedBoardRepository(getPersistenceClient())
  const id = params.id

  if (body.action === "rename" || body.action === "sharing") {
    if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1)
      return apiError("Refresh the Board before changing it.", 400)
    let result
    if (body.action === "rename") {
      const name = typeof body.name === "string" ? body.name.trim() : ""
      if (!name || name.length > 100 || /[<>\u0000-\u001f]/.test(name))
        return apiError("Enter a Board name of 1 to 100 characters.", 400)
      result = await repository.rename(user.principal, id, name, Number(body.revision))
    } else {
      if (
        (body.visibility !== "shared" && body.visibility !== "restricted") ||
        (body.sharedRole !== "member" && body.sharedRole !== "viewer") ||
        typeof body.sharedAdminManagement !== "boolean"
      )
        return apiError("Choose a sharing policy.", 400)
      result = await repository.updateSharing(
        user.principal,
        id,
        {
          visibility: body.visibility,
          sharedRole: body.sharedRole,
          sharedAdminManagement: body.sharedAdminManagement
        },
        Number(body.revision),
        [...user.roster.keys()]
      )
    }
    if (result.status === "locked") return apiError("Board access is temporarily locked.", 503)
    if (result.result === "unavailable") return apiError("Board unavailable", 404)
    if (result.result === "stale")
      return apiError("This Board changed. Refresh it before trying again.", 409)
    if (result.result === "last-owner")
      return apiError("Add an active owner before restricting this Board.", 409)
    return apiJson(
      { ok: true, accessPending: result.status === "committed-locked" },
      result.status === "committed-locked" ? 202 : 200
    )
  }
  if (body.action === "retire" || body.action === "restore") {
    if (locals.agentToken) return apiError("Board unavailable", 404)
    if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1)
      return apiError("Refresh the Board before changing it.", 400)
    const result = await repository.changeLifecycle(
      user.actor,
      id,
      body.action === "restore" ? "active" : "retired",
      Number(body.revision),
      Boolean(user.isAdmin)
    )
    if (result.status === "locked")
      return apiError("Board access is temporarily locked. Try again after it is restored.", 503)
    if (result.result === "unavailable") return apiError("Board unavailable", 404)
    if (result.result === "stale")
      return apiError("This Board changed. Refresh it before trying again.", 409)
    return apiJson(
      { ok: true, accessPending: result.status === "committed-locked" },
      result.status === "committed-locked" ? 202 : 200
    )
  }
  if (body.action === "sidebar" && typeof body.hidden === "boolean") {
    return (await repository.setSidebarHidden(user.actor, id, body.hidden))
      ? apiJson({ ok: true })
      : apiError("Board unavailable", 404)
  }
  if (
    body.action === "policy" &&
    typeof body.denyCompletion === "boolean" &&
    typeof body.denyDeletion === "boolean" &&
    typeof body.denyAgentDeletion === "boolean"
  ) {
    const result = await repository.updateRestrictions(user.actor, id, {
      denyCompletion: body.denyCompletion,
      denyDeletion: body.denyDeletion,
      denyAgentDeletion: body.denyAgentDeletion
    })
    if (result.status === "locked") return apiError("Board access is temporarily locked.", 503)
    if (!result.result) return apiError("Board unavailable", 404)
    return apiJson({ ok: true, accessPending: result.status === "committed-locked" })
  }
  if (
    body.action === "agent" &&
    typeof body.tokenId === "string" &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.tokenId) &&
    typeof body.enabled === "boolean"
  ) {
    await ensureAgentTokenSchema()
    const result = await repository.updateAgent(user.actor, id, body.tokenId, body.enabled)
    if (result.status === "locked") return apiError("Board access is temporarily locked.", 503)
    if (!result.result) return apiError("Board or eligible agent token unavailable", 404)
    return apiJson({ ok: true, accessPending: result.status === "committed-locked" })
  }
  if (body.action === "member" && typeof body.memberId === "string") {
    const role = body.role
    if (role !== null && role !== "owner" && role !== "member" && role !== "viewer") {
      return apiError("Choose Owner, Member or Viewer.", 400)
    }
    const result = await repository.updateMember(
      user.actor,
      id,
      body.memberId,
      role === null
        ? null
        : {
            role,
            denyCompletion: body.denyCompletion === true,
            denyDeletion: body.denyDeletion === true
          },
      [...user.roster.keys()]
    )
    if (result.status === "locked") return apiError("Board access is temporarily locked.", 503)
    if (result.result === "last-owner")
      return apiError("Add another active owner before removing this owner.", 409)
    if (result.result === "unavailable") return apiError("Board or person unavailable", 404)
    return apiJson({ ok: true, accessPending: result.status === "committed-locked" })
  }
  return apiError("Choose a supported Board setting.", 400)
}

export const PATCH: APIRoute = async (context) => {
  try {
    return await patchBoard(context)
  } catch (error) {
    const failure = boardScopeErrorResponse(error)
    if (failure) return failure
    throw error
  }
}
