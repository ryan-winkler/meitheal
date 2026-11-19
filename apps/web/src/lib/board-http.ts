import type { APIContext, APIRoute } from "astro"
import { validateBoardScope, type BoardScope, type ScopeFailure, type WorkOperation } from "@domains/tasks/board-scope"
import { BoardAccessService, getPersistenceClient } from "@domains/tasks"
import { resolveBoardRequestScope } from "./board-request-context"
import { retainBoardResponseScope } from "./board-view"
import { apiProblem } from "./api-response"
import { db503Response, isDbUnavailable } from "./db-fallback"

const journaledAcknowledgements = new WeakMap<Response, { scope: BoardScope, operation: WorkOperation }>()

/** A successful journaled command may acknowledge its own change, never publish old work data. */
export function journaledBoardCommandAck(scope: BoardScope, operation: WorkOperation, reportAccessPublished = false): Response {
  const response = Response.json(reportAccessPublished ? { ok: true, accessPending: false } : { ok: true }, {
    headers: { "Cache-Control": "private, no-store" },
  })
  journaledAcknowledgements.set(response, { scope, operation })
  return response
}

type RecordResource = "task" | "area" | "project" | "goal" | "routine" | "pillar"
type ScopeOptions = { recordResource?: RecordResource, recordParam?: string, boardParam?: string, write?: boolean }

/** Server page loader shared by canonical Board pages and existing bookmarks. */
export async function resolveBoardPageScope(context: Pick<APIContext, "request" | "locals" | "url" | "params">,
  options: { boardId?: string | undefined, record?: { resource: RecordResource, id: string } } = {}) {
  const boardMatch = /^\/boards\/([^/]+)\/?$/.exec(context.url.pathname)
  const recordMatch = /^\/(areas|projects|goals|task|tickets)\/([^/]+)\/?$/.exec(context.url.pathname)
  const resources = { areas: "area", projects: "project", goals: "goal", task: "task", tickets: "task" } as const
  const result = await resolveBoardRequestScope(context, {
    operation: { resource: "task", action: "read" },
    ...(options.boardId || boardMatch ? { boardId: options.boardId ?? decodeURIComponent(boardMatch![1]!) } : {}),
    ...(options.record ? { record: options.record } : recordMatch ? {
      record: { resource: resources[recordMatch[1] as keyof typeof resources], id: decodeURIComponent(recordMatch[2]!) },
    } : {}),
  })
  if (result.ok) retainBoardResponseScope(context.request, result.scope)
  return result
}

export function boardScopeResponse(code: ScopeFailure): Response {
  const status = code === "continuity_locked" ? 503 : code === "stale" ? 409 : code === "denied" ? 403 : 404
  return apiProblem({ status, detail: code === "continuity_locked" ? "Current work access is unavailable."
    : code === "stale" ? "Work access changed. Refresh before continuing."
    : code === "denied" ? "This action is unavailable." : "This work is unavailable.",
    extraHeaders: { "Cache-Control": "private, no-store" },
  })
}

/** Preserve authorization/continuity failures when an adapter has a generic error boundary. */
export function boardScopeErrorResponse(error: unknown): Response | undefined {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined
  if (code === "TRANSACTION_ACTIVE" || isDbUnavailable(error)) return db503Response("board-work", error)
  if (error && typeof error === "object" && "errorCode" in error && ["unavailable", "denied", "continuity_locked", "stale"].includes(String(error.errorCode))) return boardScopeResponse(error.errorCode as ScopeFailure)
}

function recordSelection(context: APIContext, options: ScopeOptions) {
  if (options.recordResource) {
    const id = context.params[options.recordParam ?? "id"]
    return id ? { resource: options.recordResource, id } : undefined
  }
  const families = { tasks: "task", areas: "area", projects: "project", goals: "goal", templates: "routine" } as const
  const family = /\/api\/(tasks|areas|projects|goals|templates)\//.exec(context.url.pathname)?.[1] as keyof typeof families | undefined
  return family && context.params.id ? { resource: families[family], id: context.params.id } : undefined
}

/** The route supplies its intended operation; the request never supplies authority. */
export function withBoardScope(
  operation: WorkOperation,
  handler: (context: APIContext, scope: BoardScope) => ReturnType<APIRoute>,
  options: ScopeOptions = {},
): APIRoute {
  return async context => {
    try {
      const result = await resolveBoardRequestScope(context, {
        operation, ...(options.boardParam && context.params[options.boardParam] ? { boardId: context.params[options.boardParam] } : {}),
        ...(recordSelection(context, options) ? { record: recordSelection(context, options) } : {}),
        write: options.write ?? operation.action !== "read",
      })
      if (!result.ok) return boardScopeResponse(result.errorCode)
      const response = await handler(context, result.scope)
      const acknowledgement = response instanceof Response ? journaledAcknowledgements.get(response) : undefined
      if (acknowledgement?.scope === result.scope && acknowledgement.operation.resource === operation.resource && acknowledgement.operation.action === operation.action) {
        // The journal intentionally advanced the epoch. Admit only this fixed
        // acknowledgement under the same actor's current Board authority.
        const refreshed = await new BoardAccessService(getPersistenceClient()).resolve(result.scope.principal, result.scope.boardId, operation)
        if (!refreshed.ok) return boardScopeResponse(refreshed.errorCode)
        const current = await validateBoardScope(refreshed.scope, getPersistenceClient(), operation)
        return current.ok ? response : boardScopeResponse(current.errorCode)
      }
      const current = await validateBoardScope(result.scope, getPersistenceClient(), operation)
      if (!current.ok) return boardScopeResponse(current.errorCode)
      if (response instanceof Response) response.headers.set("Cache-Control", "private, no-store")
      return response
    } catch (error) {
      const failure = boardScopeErrorResponse(error)
      if (failure) return failure
      throw error
    }
  }
}
