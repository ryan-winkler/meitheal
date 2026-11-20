import type { APIRoute } from "astro"
import { withBoardScope } from "@lib/board-http"
import { GET as readArea, PUT as updateArea } from "../../../../tasks/[id]/home-assistant-area"

function alias(handler: APIRoute, action: "read" | "edit"): APIRoute {
  return withBoardScope({ resource: "task", action }, async (context, scope) => {
    const headers = new Headers(context.request.headers)
    headers.set("X-Meitheal-Board-Id", scope.boardId)
    return handler({ ...context, params: { ...context.params, id: context.params.ticket }, request: new Request(context.request, { headers }) })
  }, { boardParam: "id", recordResource: "task", recordParam: "ticket" })
}
export const GET = alias(readArea, "read")
export const PUT = alias(updateArea, "edit")
