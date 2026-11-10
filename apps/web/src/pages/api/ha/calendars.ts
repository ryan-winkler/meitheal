/**
 * HA Calendar API Endpoints
 *
 * GET /api/ha/calendars — list available HA calendar entities
 * GET /api/ha/calendars?entity_id=X&start=Y&end=Z — get events
 * POST /api/ha/calendars — trigger manual sync
 *
 * @domain calendar
 * @bounded-context integration
 */
import type { APIRoute } from "astro";
import { getCalendarEntities, listCalendarEvents } from "../../../domains/ha";
import { getCalendarSyncStatus, syncFromHA } from "../../../domains/calendar/calendar-bridge";

export const GET: APIRoute = async ({ url }) => {
  try {
    const entityId = url.searchParams.get("entity_id");
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");

    if (entityId && start && end) {
      // Get events for a specific calendar
      const events = await listCalendarEvents(entityId, start, end);
      return new Response(JSON.stringify({ entity_id: entityId, events }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }

    // List all calendar entities
    const entities = getCalendarEntities().map((e) => ({
      entity_id: e.entity_id,
      friendly_name: e.attributes?.friendly_name ?? e.entity_id,
      state: e.state,
    }));

    const syncStatus = getCalendarSyncStatus();

    return new Response(JSON.stringify({ calendars: entities, sync: syncStatus }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Calendar API error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    let entityId: string | undefined;
    let resolvedEntities: string[] = [];
    try {
      const body = await request.json() as { entity_id?: string };
      entityId = body.entity_id;
    } catch { /* no body or invalid JSON — will resolve from settings */ }

    if (entityId) {
      resolvedEntities = [entityId];
    } else {
      // Resolve via shared helper (uses SettingsRepository)
      const { resolveCalendarEntities } = await import("../../../domains/calendar/resolve-calendar-entities");
      resolvedEntities = await resolveCalendarEntities();
    }

    if (resolvedEntities.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "No calendar entities configured" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    // Sync each entity individually — bypasses activeSyncs guard
    const results = await Promise.allSettled(
      resolvedEntities.map((eid) => syncFromHA(eid)),
    );
    const aggregated = { created: 0, updated: 0, total: 0 };
    for (const r of results) {
      if (r.status === "fulfilled") {
        aggregated.created += r.value.created;
        aggregated.updated += r.value.updated;
        aggregated.total += r.value.total;
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      message: `Synced ${aggregated.total} events (${aggregated.created} new, ${aggregated.updated} updated) across ${resolvedEntities.length} calendar(s)`,
      ...aggregated,
      entities: resolvedEntities,
    }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Calendar sync failed";
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
};
