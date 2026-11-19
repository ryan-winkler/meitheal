import type { APIRoute } from "astro"
import { withBoardScope } from "@lib/board-http"
import { apiError } from "@lib/api-response"
import { GET as listTasks, POST as createTask } from "../../../tasks/index"

// The old tickets URL shares the rich command. Private receipt lookup stays canonical.
export const GET: APIRoute = withBoardScope({ resource: "task", action: "read" }, async (context, scope) => {
  if (context.url.searchParams.has("captureReceipt") || context.request.headers.has("X-Meitheal-Capture-Attempt")) return apiError("Use the canonical task receipt lookup.", 400)
  const headers = new Headers(context.request.headers)
  headers.set("X-Meitheal-Board-Id", scope.boardId)
  return listTasks({ ...context, request: new Request(context.request, { headers }) })
}, { boardParam: "id" })

export const POST: APIRoute = withBoardScope({ resource: "task", action: "create" }, async (context, scope) => {
  if (context.url.searchParams.has("captureReceipt")) return apiError("Use the canonical task receipt lookup.", 400)
  if (context.request.headers.has("X-Meitheal-Capture-Attempt") && context.request.headers.get("X-Meitheal-Board-Id") !== scope.boardId) return apiError("Capture requires its original explicit Board header.", 400)
  const body: unknown = await context.request.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body)) return apiError("Send a task object.", 400)
  const input = body as Record<string, unknown>
  const translated = { ...input }
  for (const [alias, field] of [["areaId", "area_id"], ["projectId", "project_id"], ["goalId", "goal_id"]] as const) {
    if (!(alias in input)) continue
    if (field in input) return apiError("Choose one placement format.", 400)
    translated[field] = input[alias]
    delete translated[alias]
  }
  const headers = new Headers(context.request.headers)
  headers.set("X-Meitheal-Board-Id", scope.boardId)
  const request = new Request(context.request, { headers, body: JSON.stringify(translated) })
  return createTask({ ...context, request })
}, { boardParam: "id" })
