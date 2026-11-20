import type { APIRoute } from "astro"
import { getCalendarEntities } from "@domains/ha"
import { getCalendarSyncStatus } from "@domains/calendar"
import { withBoardScope } from "@lib/board-http"
import { currentSettingsAccess } from "@lib/current-settings-access"
import { visibleIntegrationBindings } from "@lib/integration-binding-access"
import { apiJson } from "@lib/api-response"

export const GET: APIRoute = withBoardScope({ resource: "task", action: "read" }, async ({ request, locals }, scope) => {
  const bindings = await visibleIntegrationBindings(scope, ["calendar", "caldav"])
  const access = await currentSettingsAccess(request, locals, false)
  const ids = new Set(bindings.map(binding => binding.sourceId))
  const entities = getCalendarEntities().filter(entity => !(access instanceof Response) && access.admin || ids.has(entity.entity_id)).map(entity => ({
    entity_id: entity.entity_id, friendly_name: entity.attributes?.friendly_name ?? entity.entity_id,
  }))
  const status = await getCalendarSyncStatus(scope)
  return apiJson({ ok: true, calendars: entities, bindings, sync: { ...status, eventCount: status.lastSyncEventCount } })
})
