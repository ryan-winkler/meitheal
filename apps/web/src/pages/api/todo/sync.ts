import type { APIRoute } from "astro"
import { bindingAllows, hasBoardSelection, type WorkOperation } from "@domains/tasks"
import { syncTodoFromHA, getTodoSyncStatus, startTodoSync, stopTodoSync } from "@domains/todo"
import { getHAConnectionStatus } from "@domains/ha"
import { withBoardScope } from "@lib/board-http"
import { apiError, apiJson } from "@lib/api-response"
import { currentSettingsAccess } from "@lib/current-settings-access"
import { readBoardRequest } from "@lib/named-board-request"
import { todoRequestBinding, visibleTodoBindings } from "./index"

export const GET: APIRoute = withBoardScope({ resource: "task", action: "read" }, async (_context, scope) => {
  const bindings = await visibleTodoBindings(scope)
  return apiJson({ ok: true, sync: bindings.flatMap(binding => { const status = getTodoSyncStatus(binding.id); return status?.generation === binding.generation ? [status] : [] }), ha_connected: getHAConnectionStatus().connected })
})

export const POST: APIRoute = async context => {
  const body = await readBoardRequest(context.request)
  if (body && hasBoardSelection(body)) return apiError("Select the Board using the request context.", 400)
  if (!body) return apiError("Choose a current Todo binding and action.", 400)
  const action = body.action ?? "sync"
  if (!["sync", "enable", "disable"].includes(String(action))) return apiError("Choose sync, enable or disable.", 400)
  const operation: WorkOperation = { resource: "board", action: "manage" }
  return withBoardScope(operation, async (requestContext, scope) => {
    if (action !== "sync") {
      const configurationAccess = await currentSettingsAccess(requestContext.request, requestContext.locals, true)
      if (configurationAccess instanceof Response) return configurationAccess
    }
    const binding = await todoRequestBinding(scope, body, operation)
    if (!binding) return apiError("This Todo binding is unavailable.", 404)
    if (action === "disable") {
      stopTodoSync(binding.binding.id, binding.binding.generation)
      return apiJson({ ok: true })
    }
    if (action === "enable") {
      const direction = body.direction ?? "bidirectional"
      if (!["inbound", "outbound", "bidirectional"].includes(String(direction))) return apiError("Choose a valid sync direction.", 400)
      if (direction !== "outbound" && (!bindingAllows(binding.binding, { resource: "task", action: "create" }) || !bindingAllows(binding.binding, { resource: "task", action: "edit" }))) return apiError("This binding does not permit inbound work.", 403)
      await startTodoSync({ bindingId: binding.binding.id, generation: binding.binding.generation, entityId: binding.binding.sourceId,
        syncEnabled: true, syncDirection: direction as "inbound" | "outbound" | "bidirectional", writeBack: direction !== "inbound" }, binding)
      return apiJson({ ok: true, status: getTodoSyncStatus(binding.binding.id) })
    }
    // Manual sync never invents or auto-starts an unapproved source/destination.
    if (getTodoSyncStatus(binding.binding.id)?.generation !== binding.binding.generation) return apiError("Enable this approved Todo binding before syncing.", 409)
    const result = await syncTodoFromHA(binding.binding.id, scope)
    return apiJson({ ok: result.errors === 0, ...result, status: getTodoSyncStatus(binding.binding.id) }, result.errors ? 409 : 200)
  }, { write: true })(context)
}
