import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { formatTicketKey } from "../../../lib/ticket-key"
import { exportFilename } from "../../../lib/export-filename"
import { logApiError } from "../../../lib/api-logger"
import { apiProblem } from "../../../lib/api-response"

export const GET: APIRoute = async ({ locals }) => {
    if (!locals.hassIsAdmin || locals.agentToken) {
        return apiProblem({ status: 403, title: "Admin Required", detail: "Task export requires admin access" })
    }
    try {
        await ensureSchema()
        const repo = new TaskRepository(getPersistenceClient())
        const allTasks = await repo.exportAll()

        if (allTasks.length === 0) {
            return new Response("ticket_key,id,parent_id,title,description,status,priority,task_type,area_id,labels,due_date,created_at,updated_at\n", {
                status: 200,
                headers: {
                    "Content-Type": "text/csv; charset=utf-8",
                    "Content-Disposition": `attachment; filename="${exportFilename("Tasks", "csv")}"`,
                },
            })
        }

        const headers = [
            "ticket_key", "id", "parent_id", "title", "description", "status", "priority",
            "task_type", "area_id", "labels", "due_date", "recurrence_rule",
            "checklists", "reminder_at", "created_at", "updated_at",
        ]

        const escapeCsv = (val: unknown) => {
            if (val === null || val === undefined) return '""'
            const str = String(val)
            if (str.includes(",") || str.includes("\n") || str.includes('"')) {
                return `"${str.replace(/"/g, '""')}"`
            }
            return `"${str}"`
        }

        const rows = allTasks.map(t => [
            escapeCsv(formatTicketKey(t.ticket_number != null ? Number(t.ticket_number) : null)),
            escapeCsv(t.id),
            escapeCsv(t.parent_id),
            escapeCsv(t.title),
            escapeCsv(t.description),
            escapeCsv(t.status),
            escapeCsv(t.priority),
            escapeCsv(t.task_type),
            escapeCsv(t.area_id),
            escapeCsv(t.labels),
            escapeCsv(t.due_date),
            escapeCsv(t.recurrence_rule),
            escapeCsv(t.checklists),
            escapeCsv(t.reminder_at),
            escapeCsv(t.created_at),
            escapeCsv(t.updated_at),
        ].join(","))

        // BOM for Excel UTF-8 compatibility
        const csvContent = "\uFEFF" + [headers.join(","), ...rows].join("\n")

        return new Response(csvContent, {
            status: 200,
            headers: {
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition": `attachment; filename="${exportFilename("Tasks", "csv")}"`,
            },
        })
    } catch (error) {
        logApiError("export-tasks-csv", "Failed to export tasks as CSV", error)
        return new Response(JSON.stringify({ error: "Export failed" }), { status: 500, headers: { "content-type": "application/json" } })
    }
}
