/**
 * Calendar Events API — GET /api/ha/events
 *
 * Exposes HA calendar event listing via HTTP for client-side use.
 * The underlying listCalendarEvents only works server-side via WebSocket.
 *
 * Query params:
 *   entity_id (required) — calendar entity ID (e.g., calendar.home)
 *   start (required) — ISO date/datetime for range start
 *   end (required) — ISO date/datetime for range end
 *
 * @domain ha
 * @bounded-context integration
 */
import type { APIRoute } from "astro"
import { listCalendarEvents, getCalendarEntityFeatures, CalendarFeature } from "@domains/ha"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"

const logger = createLogger({
  service: "meitheal-web", env: process.env.NODE_ENV ?? "development",
  minLevel: "info", enabledCategories: ["ha"],
  redactPatterns: defaultRedactionPatterns, auditEnabled: false,
})

export const GET: APIRoute = async ({ url }) => {
  const entityId = url.searchParams.get("entity_id")
  const start = url.searchParams.get("start")
  const end = url.searchParams.get("end")

  if (!entityId || !start || !end) {
    return new Response(JSON.stringify({
      ok: false,
      errorCode: "MISSING_PARAMS",
      message: "Required query params: entity_id, start, end",
    }), { status: 400, headers: { "content-type": "application/json" } })
  }

  try {
    const [events, features] = await Promise.all([
      listCalendarEvents(entityId, start, end),
      getCalendarEntityFeatures(entityId),
    ])

    logger.log("debug", {
      event: "api.ha.events", domain: "ha", component: "events-api",
      request_id: "api", message: `Returned ${events.length} events for ${entityId}`,
    })

    return new Response(JSON.stringify({
      ok: true,
      entity_id: entityId,
      events,
      supported_features: {
        create: (features & CalendarFeature.CREATE_EVENT) !== 0,
        update: (features & CalendarFeature.UPDATE_EVENT) !== 0,
        delete: (features & CalendarFeature.DELETE_EVENT) !== 0,
      },
    }), { status: 200, headers: { "content-type": "application/json" } })
  } catch (err) {
    logger.log("error", {
      event: "api.ha.events.failed", domain: "ha", component: "events-api",
      request_id: "api", message: `Failed to fetch calendar events: ${err}`,
    })
    return new Response(JSON.stringify({
      ok: false,
      errorCode: "FETCH_FAILED",
      message: `Failed to fetch events: ${err instanceof Error ? err.message : String(err)}`,
    }), { status: 500, headers: { "content-type": "application/json" } })
  }
}
