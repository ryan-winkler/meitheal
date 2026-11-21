import type { APIRoute } from "astro"
import { getPersistenceClient, readWorkDestinations, type WorkOperation } from "@domains/tasks"
import { getCalendarSyncStatus, syncFromHA, syncCalDAVEvents, startCalendarSync,
  stopCalendarSync, stopCalDAVSync, type CalendarSyncMode } from "@domains/calendar"
import { withBoardScope } from "@lib/board-http"
import { currentSettingsAccess } from "@lib/current-settings-access"
import { apiJson, apiError } from "@lib/api-response"
import { requestIntegrationBinding } from "@lib/integration-binding-access"
import { calendarSyncResult } from "@domains/calendar/calendar-sync-result"

export const GET: APIRoute = withBoardScope({ resource: "task", action: "read" }, async (_context, scope) =>
  apiJson({ ok: true, sync: await getCalendarSyncStatus(scope) }))

export const POST: APIRoute = async context => {
  const raw: unknown = await context.request.json().catch(() => null)
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return apiError("Choose a Calendar action and approved source.", 400)
  const body = raw as Record<string, unknown>
  if (Object.hasOwn(body, "board_id")) return apiError("Select the Board using the request context.", 400)
  const action = body.action ?? "sync"
  if (!["sync", "enable", "disable"].includes(String(action))) return apiError("Choose sync, enable or disable.", 400)
  const operation: WorkOperation = { resource: "board", action: "manage" }
  return withBoardScope(operation, async (requestContext, scope) => {
    if (action !== "sync") {
      const access = await currentSettingsAccess(requestContext.request, requestContext.locals, true)
      if (access instanceof Response) return access
    }
    const candidates = (await readWorkDestinations(getPersistenceClient()))?.bindings.filter(binding => binding.enabled &&
      binding.destination.boardId === scope.boardId && binding.purpose === "calendar.sync" &&
      ["calendar", "caldav"].includes(binding.integration) &&
      (body.binding_id === undefined || binding.id === body.binding_id) &&
      (body.generation === undefined || binding.generation === body.generation) &&
      (body.entity_id === undefined || binding.sourceId === body.entity_id) &&
      (body.entities === undefined || Array.isArray(body.entities) && body.entities.includes(binding.sourceId))) ?? []
    if (!candidates.length) return apiError("Choose a current Calendar destination in this Board.", 404)
    if (action === "sync") {
      const pending = candidates.map(async binding => {
        const approved = await requestIntegrationBinding(scope, binding.integration, "calendar.sync", { binding_id: binding.id, generation: binding.generation }, operation)
        if (!approved?.ok) throw new Error("Calendar approval unavailable")
        return binding.integration === "caldav" ? syncCalDAVEvents(binding.id, scope, operation) : syncFromHA(binding.id, scope, operation)
      })
      const outcome = calendarSyncResult(candidates.map(binding => binding.id), await Promise.allSettled(pending))
      return apiJson(outcome, outcome.ok ? 200 : 502)
    }
    for (const binding of candidates) {
      if (action === "disable") {
        if (binding.integration === "caldav") stopCalDAVSync(binding.id, binding.generation)
        else stopCalendarSync(binding.id, binding.generation)
        continue
      }
      if (binding.integration !== "calendar") return apiError("Save and enable the approved CalDAV profile before syncing.", 409)
      const modes = body.sync_modes && typeof body.sync_modes === "object" && !Array.isArray(body.sync_modes) ? body.sync_modes as Record<string, unknown> : {}
      const mode = modes[binding.sourceId] ?? body.sync_mode ?? "bidirectional"
      const interval = body.interval_ms ?? 300000
      if (!["import", "export", "bidirectional"].includes(String(mode)) || typeof interval !== "number" || !Number.isFinite(interval) || interval < 0 ||
        (body.write_back !== undefined && typeof body.write_back !== "boolean") ||
        (body.write_ticket_details !== undefined && typeof body.write_ticket_details !== "boolean")) return apiError("Choose a valid Calendar mode and interval.", 400)
      const approved = await requestIntegrationBinding(scope, "calendar", "calendar.sync", { binding_id: binding.id, generation: binding.generation }, operation)
      if (!approved?.ok) return apiError("Calendar approval changed.", 409)
      const writeTicketDetails = body.write_ticket_details ?? true
      await startCalendarSync({ bindingId: binding.id, generation: binding.generation, entityId: binding.sourceId, syncEnabled: true,
        syncMode: mode as CalendarSyncMode, writeBack: mode !== "import" && body.write_back === true,
        writeTicketDetails: mode !== "import" ? writeTicketDetails : false, syncIntervalMs: interval })
    }
    return apiJson({ ok: true })
  }, { write: true })(context)
}
