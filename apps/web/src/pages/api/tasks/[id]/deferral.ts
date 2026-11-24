import { boardScopeErrorResponse } from "@lib/board-http"
import { scopePermits } from "@domains/tasks/board-scope"
import { taskDetailHttpProjection } from "@lib/task-http-projection"
import { withBoardScope } from "@lib/board-http"
import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { requireAssignedTaskWriteAccess, restrictedAssigneeId } from "../../../../lib/agent-token-guard"
import { apiError } from "../../../../lib/api-response"
import { logApiError } from "../../../../lib/api-logger"
import { readWithinLimit } from "../../../../lib/bounded-body"
import { normalizeStatus } from "../../../../lib/status-config"
import { formatTicketKey } from "../../../../lib/ticket-key"

const headers = { "content-type": "application/json", "cache-control": "no-store" }

export const PATCH: APIRoute = withBoardScope({ resource: "task", action: "edit" }, async ({ params, request, locals }, scope) => {
  try {
    const bytes = await readWithinLimit(request.body, 1024, request.signal)
    if (!bytes) return apiError("Deferral request is too large", 413)
    let body: Record<string, unknown>
    try {
      body = JSON.parse(bytes.toString("utf8"))
    } catch {
      return apiError("Expected a JSON deferral request", 400)
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 3 ||
        typeof body.deferred !== "boolean" || typeof body.updated_at !== "number" ||
        !Number.isSafeInteger(body.updated_at) || body.updated_at < 0 ||
        (body.deferral_revision !== null &&
          (typeof body.deferral_revision !== "string" || !/^[a-f0-9]{32}$/.test(body.deferral_revision)))) {
      return apiError("Expected deferred, updated_at and deferral_revision", 400)
    }

    await ensureSchema()
    const repo = new TaskRepository(getPersistenceClient(), scope)
    const resolved = await repo.resolveTaskId(params.id!, "edit")
    if (!resolved) return apiError("Task not found", 404)
    const denied = await requireAssignedTaskWriteAccess(
      locals.agentToken,
      (id) => repo.findTaskForCommand(id, "edit"),
      [resolved.id],
      "Agent can only defer tasks assigned to it",
    )
    if (denied) return denied
    const result = await repo.setDeferral(resolved.id, body.deferred, {
      updatedAt: body.updated_at, revision: body.deferral_revision,
    }, {
      id: locals.agentToken?.tokenId ?? locals.hassUserId ?? "user",
      type: locals.agentToken ? "agent" : "human",
      requestId: locals.requestId ?? crypto.randomUUID(),
    }, restrictedAssigneeId(locals.agentToken))
    if (result.ok) {
      return new Response(JSON.stringify(scopePermits(scope, { resource: "task", action: "read" }) ? { ...taskDetailHttpProjection(result.task, scope.boardId), status: normalizeStatus(result.task.status) } : { id: result.task.id }), { headers })
    }
    if (result.errorCode === "assignee_mismatch") return apiError("Agent can only defer tasks assigned to it", 403)
    if (result.errorCode === "unavailable") return apiError("Task not found", 404)
    if (result.errorCode === "conflict") {
      return new Response(JSON.stringify({
        error: "Task changed since your last read",
        errorCode: "TASK_VERSION_CONFLICT",
        server_updated_at: result.task.updated_at,
        client_updated_at: body.updated_at,
        server_deferral_revision: result.task.deferral_revision,
        client_deferral_revision: body.deferral_revision,
      }), { status: 409, headers })
    }
    if (result.errorCode === "blocked") {
      return new Response(JSON.stringify({
        error: "Cannot resume active work while dependencies are open",
        errorCode: "TASK_BLOCKED",
        blocked_by: result.blockers.map(({ id, title, status, ticket_number }) => ({
          id, title, status, ticket_key: ticket_number ? formatTicketKey(Number(ticket_number)) : null,
        })),
      }), { status: 409, headers })
    }
    return new Response(JSON.stringify({
      error: "Only open work can be deferred or resumed",
      errorCode: "TASK_DEFERRAL_TERMINAL",
    }), { status: 409, headers })
  } catch (error) {
    const scopeFailure = boardScopeErrorResponse(error)
    if (scopeFailure) return scopeFailure
    logApiError("PATCH", "/api/tasks/:id/deferral", error)
    return apiError("Failed to update deferral")
  }
})
