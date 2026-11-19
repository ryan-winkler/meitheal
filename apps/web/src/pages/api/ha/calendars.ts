import type { APIRoute } from "astro"
import { getCalendarEntities, listCalendarEvents } from "@domains/ha"
import { getCalendarSyncStatus } from "@domains/calendar"
import { canReadBoardAggregate, getPersistenceClient, validateIntegrationScope } from "@domains/tasks"
import { withBoardScope } from "@lib/board-http"
import { currentSettingsAccess } from "@lib/current-settings-access"
import { requestIntegrationBinding, visibleIntegrationBindings } from "@lib/integration-binding-access"
import { apiJson, apiError } from "@lib/api-response"
import { POST as syncCalendar } from "../integrations/calendar/sync"

export const GET: APIRoute = withBoardScope({ resource: "task", action: "read" }, async ({ request, url, locals }, scope) => {
  const bindings = await visibleIntegrationBindings(scope, ["calendar"])
  const ids = new Set(bindings.map(binding => binding.sourceId))
  if (url.searchParams.get("configured") === "1") return apiJson({ entities: [...ids] })
  const entityId = url.searchParams.get("entity_id"), start = url.searchParams.get("start"), end = url.searchParams.get("end")
  if (entityId && start && end) {
    const access = await currentSettingsAccess(request, locals, true)
    if (access instanceof Response) return access
    const approved = await requestIntegrationBinding(scope, "calendar", "calendar.sync", { entity_id: entityId }, { resource: "task", action: "read" })
    const db = getPersistenceClient()
    if (!approved?.ok || !await canReadBoardAggregate(db, scope)) return apiError("This Calendar source is unavailable.", 404)
    const operationAllowed = async () => (await validateIntegrationScope(approved.value, db, { resource: "task", action: "read" })).ok && await canReadBoardAggregate(db, scope)
    const events = await listCalendarEvents(entityId, start, end, { operationAllowed })
    if (!await operationAllowed()) return apiError("Calendar access changed.", 409)
    return apiJson({ entity_id: entityId, events })
  }
  const access = await currentSettingsAccess(request, locals, false)
  const calendars = getCalendarEntities().filter(entity => !(access instanceof Response) && access.admin || ids.has(entity.entity_id)).map(entity => ({
    entity_id: entity.entity_id, friendly_name: entity.attributes?.friendly_name ?? entity.entity_id,
  }))
  return apiJson({ calendars, sync: await getCalendarSyncStatus(scope) })
})

export const POST: APIRoute = syncCalendar
