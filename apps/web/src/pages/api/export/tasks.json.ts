import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { formatTicketKey } from "../../../lib/ticket-key"
import { exportFilename } from "../../../lib/export-filename"
import { logApiError } from "../../../lib/api-logger"
import { apiProblem } from "../../../lib/api-response"

/**
 * Export Tasks as JSON
 *
 * Downloads all server-side tasks as a formatted JSON file.
 * Filename format: meitheal-tasks-YYYY-MM-DD.json
 */
export const GET: APIRoute = async ({ locals }) => {
    if (!locals.hassIsAdmin && !locals.agentToken?.scopes.includes("settings:write")) {
        return apiProblem({ status: 403, title: "Admin Required", detail: "Task export requires admin access or settings:write scope" })
    }
    try {
        await ensureSchema()
        const repo = new TaskRepository(getPersistenceClient())
        const allRows = await repo.exportAll()

        const allTasks = allRows.map(row => {
            const r = row as Record<string, unknown>
            const tn = r.ticket_number != null ? Number(r.ticket_number) : null
            return { ...r, ticket_key: formatTicketKey(tn) }
        })

        const dataStr = JSON.stringify(allTasks, null, 2)

        return new Response(dataStr, {
            status: 200,
            headers: {
                "Content-Type": "application/json",
                "Content-Disposition": `attachment; filename="${exportFilename("Tasks", "json")}"`,
                "X-Content-Type-Options": "nosniff",
            },
        })
    } catch (error) {
        logApiError("export-tasks-json", "Failed to export tasks as JSON", error)
        return new Response(JSON.stringify({ error: "Export failed" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        })
    }
}
