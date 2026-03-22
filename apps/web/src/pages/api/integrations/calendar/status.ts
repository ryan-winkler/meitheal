/**
 * Calendar Integration Status API
 *
 * GET /api/integrations/calendar/status — returns available calendar entities
 * and current sync status for the settings panel hydration.
 *
 * @domain calendar
 * @bounded-context integration
 */
import type { APIRoute } from "astro"
import { getCalendarEntities } from "../../../../domains/ha"
import { getCalendarSyncStatus } from "../../../../domains/calendar/calendar-bridge"
import { logApiError } from "../../../../lib/api-logger"

export const GET: APIRoute = async () => {
  try {
    // List calendar.* entities from HA state cache
    const entities = getCalendarEntities().map((e) => ({
      entity_id: e.entity_id,
      friendly_name: e.attributes?.friendly_name ?? e.entity_id,
      state: e.state,
    }))

    const syncStatus = getCalendarSyncStatus()

    return new Response(JSON.stringify({
      ok: true,
      calendars: entities,
      sync: {
        active: syncStatus.active,
        entityId: syncStatus.entityId ?? "",
        lastSyncAt: syncStatus.lastSyncAt ?? null,
        eventCount: syncStatus.lastSyncEventCount ?? 0,
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  } catch (err) {
    logApiError("calendar-status", "Failed to fetch calendar status", err)
    return new Response(JSON.stringify({
      ok: false,
      calendars: [],
      sync: { active: false, entityId: "", lastSyncAt: null, eventCount: 0 },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
}
