import { getPersistenceClient } from "@domains/tasks"
import { normalizeTaskLocatorKey } from "./board-request-context"
import { supervisorFetch } from "./supervisor-fetch"

/** Readable ticket key (`MTH-4`) for a task on this Board, or null when it has none. */
async function boardTicketKey(boardId: string, taskId: string): Promise<string | null> {
  try {
    const { rows: [row] } = await getPersistenceClient().execute({
      sql: `SELECT COALESCE(task.ticket_ref, legacy.ticket_prefix || '-' || task.ticket_number) AS ticket_key
        FROM tasks AS task
        LEFT JOIN task_boards AS legacy ON task.task_board_id IS NULL AND legacy.storage_encoding = 'legacy_null_v1'
        WHERE task.id = ? AND COALESCE(task.task_board_id, legacy.id) = ?`,
      args: [taskId, boardId],
    })
    return typeof row?.ticket_key === "string" ? normalizeTaskLocatorKey(row.ticket_key) : null
  } catch {
    return null
  }
}

/** Keep `/` readable in the panel route; the value stays a single query parameter. */
function panelRouteParam(route: string): string {
  return encodeURIComponent(route).replace(/%2F/gi, "/")
}

/**
 * Stable Home Assistant panel path; never publish a Supervisor ingress session token.
 * Tasks link to their ticket key (`/meitheal?meitheal=/tickets/MTH-4`); the ticket page finds the Board.
 */
export async function homeAssistantWorkLink(boardId: string, taskId?: string): Promise<string | null> {
  if (!process.env.SUPERVISOR_TOKEN) return null
  try {
    const response = await supervisorFetch("/addons/self/info")
    if (!response?.ok) { await response?.body?.cancel().catch(() => {}); return null }
    const payload: unknown = await response.json()
    const data = payload && typeof payload === "object" && "data" in payload ? payload.data : null
    const slug = data && typeof data === "object" && "slug" in data ? data.slug : null
    if (typeof slug !== "string" || !/^[a-z0-9_-]{1,128}$/.test(slug)) return null
    const key = taskId ? await boardTicketKey(boardId, taskId) : null
    const work = key
      ? `/tickets/${key}`
      : `/boards/${encodeURIComponent(boardId)}${taskId ? `?open=${encodeURIComponent(taskId)}` : ""}`
    return `/${slug}?meitheal=${panelRouteParam(work)}`
  } catch { return null }
}
