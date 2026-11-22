import { boardScopeErrorResponse } from "@lib/board-http"
import { scopePermits } from "@domains/tasks/board-scope"
import { withBoardScope } from "@lib/board-http"
import type { APIRoute } from "astro"
import { rejectBoardSelectionInJson } from "@domains/tasks/board-availability"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskRepository, prepareTaskCreation, dispatchTaskCreation, type taskCreationPayload } from "@domains/tasks"
import { taskHttpProjection } from "@lib/task-http-projection"
import { taskEventAuthorityHeaders } from "@lib/webhook-dispatcher"
import { resolveRecentActivityActor } from "@lib/recent-activity-actor"
import { apiError, apiJson } from "../../../../lib/api-response"
import { formatTicketKey } from "../../../../lib/ticket-key"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"

const logger = createLogger({
    service: "meitheal-web",
    env: process.env.NODE_ENV ?? "development",
    minLevel: "info",
    enabledCategories: ["tasks", "audit", "observability"],
    redactPatterns: defaultRedactionPatterns,
    auditEnabled: true,
})

/**
 * POST /api/tasks/[id]/duplicate — Clone a task with a new ID.
 * Competitive parity: Jira, Asana, Linear all have "Clone/Duplicate" actions.
 * Copies all fields except id, created_at, updated_at, and calendar_sync_state.
 */
export const POST: APIRoute = withBoardScope({ resource: "task", action: "create" }, async ({ params, request, locals }, scope) => {
    try {
        const boardSelection = await rejectBoardSelectionInJson(request)
        if (boardSelection) return boardSelection

        await ensureSchema()
        const repo = new TaskRepository(getPersistenceClient(), scope)
        const sourceId = params.id!

        if (!scopePermits(scope, { resource: "task", action: "read" })) return apiError("Source task unavailable", 404)
        // Fetch source task
        const row = await repo.findById(sourceId)
        if (!row) {
            return apiError("Task not found", 404)
        }

        const newTitle = `${String(row.title)} (copy)`
        const newId = crypto.randomUUID()

        const prepared = await prepareTaskCreation(repo, {
          ...taskHttpProjection(row, scope.boardId),
          title: newTitle, status: "pending", assigned_to: null,
          is_promoted: false, progress: 0,
          // A copied occurrence is ordinary work, not a second completion of its source Routine.
          task_kind: row.task_kind === "routine_instance" ? "standard_action" : row.task_kind,
          source_template_id: null,
        }, { id: newId, useDefaultAssignee: false })
        if (!prepared.ok) return apiError("The source task cannot be duplicated in its current placement.", 409)
        const created = await repo.createWorkCommand(prepared.task, { activityActor: resolveRecentActivityActor(locals, request) })
        if (!created.ok) return apiError("The task could not be duplicated.", created.errorCode === "denied" ? 403 : 409)
        const payload = taskHttpProjection(created.task, scope.boardId)
        const authority = await taskEventAuthorityHeaders(["task.created"], scope)
        dispatchTaskCreation(payload as ReturnType<typeof taskCreationPayload>, undefined, undefined, authority, scope)


        logger.audit({
            event: "audit.task.duplicated",
            domain: "audit",
            component: "duplicate-api",
            request_id: crypto.randomUUID(),
            task_id: created.task.id,
            message: `Task duplicated from ${sourceId}`,
        })

        return apiJson({
            id: created.task.id,
            ticket_number: created.ticketNumber,
            ticket_key: payload.ticket_key,
            title: newTitle,
            source_id: sourceId,
            created_at: created.task.created_at,
        }, 201)
    } catch (err) {
    const scopeFailure = boardScopeErrorResponse(err)
    if (scopeFailure) return scopeFailure
        logger.log("error", {
            event: "api.duplicate.post.failed",
            domain: "tasks",
            component: "duplicate-api",
            request_id: crypto.randomUUID(),
            message: "Internal server error",
        })
        return apiError("Failed to duplicate task")
    }
})
