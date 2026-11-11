import type { APIRoute } from "astro"
import { rejectBoardSelectionInJson } from "@domains/tasks/board-availability"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
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
export const POST: APIRoute = async ({ params, request }) => {
    try {
        const boardSelection = await rejectBoardSelectionInJson(request)
        if (boardSelection) return boardSelection

        await ensureSchema()
        const repo = new TaskRepository(getPersistenceClient())
        const sourceId = params.id!

        // Fetch source task
        const row = await repo.findById(sourceId)
        if (!row) {
            return apiError("Task not found", 404)
        }

        const newTitle = `${String(row.title)} (copy)`
        const newId = crypto.randomUUID()

        const ticket_number = await repo.createTask({
            id: newId,
            title: newTitle,
            description: row.description ? String(row.description) : "",
            status: "pending",
            priority: row.priority != null ? Number(row.priority) : 3,
            due_date: row.due_date ? String(row.due_date) : null,
            labels: row.labels ? String(row.labels) : "[]",
            framework_payload: row.framework_payload ? String(row.framework_payload) : "{}",
            parent_id: row.parent_id ? String(row.parent_id) : null,
            area_id: row.area_id ? String(row.area_id) : "default",
            custom_fields: row.custom_fields ? String(row.custom_fields) : "{}",
            start_date: row.start_date ? String(row.start_date) : null,
            end_date: row.end_date ? String(row.end_date) : null,
            progress: row.progress != null ? Number(row.progress) : 0,
            color: row.color ? String(row.color) : null,
            is_favorite: row.is_favorite ? Number(row.is_favorite) : 0,
            task_type: row.task_type ? String(row.task_type) : "task",
            assigned_to: null,
        })

        logger.audit({
            event: "audit.task.duplicated",
            domain: "audit",
            component: "duplicate-api",
            request_id: crypto.randomUUID(),
            task_id: newId,
            message: `Task duplicated from ${sourceId}`,
        })

        const now = Date.now()
        return apiJson({
            id: newId,
            ticket_number,
            ticket_key: formatTicketKey(ticket_number),
            title: newTitle,
            source_id: sourceId,
            created_at: now,
        }, 201)
    } catch (err) {
        logger.log("error", {
            event: "api.duplicate.post.failed",
            domain: "tasks",
            component: "duplicate-api",
            request_id: crypto.randomUUID(),
            message: "Internal server error",
        })
        return apiError("Failed to duplicate task")
    }
}
