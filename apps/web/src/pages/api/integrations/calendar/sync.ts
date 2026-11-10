/**
 * Calendar Sync API — Manual Sync Trigger & Status
 *
 * POST /api/integrations/calendar/sync — trigger manual sync or enable/disable
 * GET  /api/integrations/calendar/sync — get sync status
 *
 * Supports multi-calendar: enable accepts `entities` array.
 * Mirrors /api/todo/sync pattern for API consistency.
 *
 * @domain calendar
 * @bounded-context integration
 */
import type { APIRoute } from "astro";
import type { CalendarSyncMode } from "@domains/calendar/calendar-bridge";
import {
  startCalendarSync,
  startMultiCalendarSync,
  stopCalendarSync,
  getCalendarSyncStatus,
  syncFromHA,
} from "@domains/calendar/calendar-bridge";
import { logApiError } from "../../../../lib/api-logger";

/**
 * GET /api/integrations/calendar/sync — returns current sync status
 */
export const GET: APIRoute = async () => {
  try {
    const status = getCalendarSyncStatus();
    return new Response(JSON.stringify({ ok: true, sync: status }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    logApiError("calendar-sync", "GET failed", err);
    return new Response(
      JSON.stringify({ ok: false, error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};

/**
 * POST /api/integrations/calendar/sync
 * Body: {
 *   action: "sync" | "enable" | "disable",
 *   entity_id?: string,         // single entity (legacy)
 *   entities?: string[],         // multi-entity support
 *   write_back?: boolean,
 *   interval_ms?: number,
 * }
 */
export const POST: APIRoute = async ({ request }) => {
  try {
    let body: {
      action?: "sync" | "enable" | "disable";
      entity_id?: string;
      entities?: string[];
      write_back?: boolean;
      interval_ms?: number;
      sync_mode?: CalendarSyncMode;
      sync_modes?: Record<string, CalendarSyncMode>;
    };

    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const action = body.action ?? "enable";

    switch (action) {
      case "sync": {
        // Trigger an immediate sync — all configured entities or specific one
        try {
          let entityId = body.entity_id;
          let resolvedEntities: string[] = [];

          // Fall back to settings DB if no entity provided
          if (!entityId) {
            const { resolveCalendarEntities } = await import("@domains/calendar/resolve-calendar-entities");
            resolvedEntities = await resolveCalendarEntities();
          } else {
            resolvedEntities = [entityId];
          }

          if (resolvedEntities.length === 0) {
            return new Response(
              JSON.stringify({ ok: false, error: "No calendar entities configured. Go to Settings → Integrations → Calendar to select calendars." }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }

          // Sync each resolved entity individually — bypasses activeSyncs check
          // so manual sync works even if background sync wasn't auto-started
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

          return new Response(
            JSON.stringify({
              ok: true,
              message: `Calendar sync complete: ${aggregated.created} created, ${aggregated.updated} updated from ${aggregated.total} events across ${resolvedEntities.length} calendar(s)`,
              ...aggregated,
              entities: resolvedEntities,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        } catch (err) {
          return new Response(
            JSON.stringify({ ok: false, error: `Sync failed: ${err}` }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      case "enable": {
        const intervalMs = body.interval_ms ?? 5 * 60 * 1000;
        const writeBack = body.write_back ?? false;
        const globalMode: CalendarSyncMode = body.sync_mode ?? "bidirectional";
        const perEntityModes = body.sync_modes ?? {};

        // Multi-entity enable
        if (body.entities && body.entities.length > 0) {
          const configs = body.entities.map((entityId) => {
            const entityMode = perEntityModes[entityId] ?? globalMode;
            return {
              entityId,
              syncEnabled: true,
              syncMode: entityMode,
              writeBack: entityMode !== "import" ? writeBack : false,
              syncIntervalMs: intervalMs,
            };
          });
          startMultiCalendarSync(configs);
          return new Response(
            JSON.stringify({
              ok: true,
              message: `Calendar sync enabled for ${body.entities.length} entities`,
              entities: body.entities,
              sync_modes: configs.reduce((acc, c) => ({ ...acc, [c.entityId]: c.syncMode }), {} as Record<string, CalendarSyncMode>),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        // Legacy single-entity enable
        if (!body.entity_id) {
          return new Response(
            JSON.stringify({ ok: false, error: "entity_id or entities[] required" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        const singleMode = perEntityModes[body.entity_id] ?? globalMode;
        startCalendarSync({
          entityId: body.entity_id,
          syncEnabled: true,
          syncMode: singleMode,
          writeBack: singleMode !== "import" ? writeBack : false,
          syncIntervalMs: intervalMs,
        });
        return new Response(
          JSON.stringify({
            ok: true,
            message: `Calendar sync enabled for ${body.entity_id} (${singleMode})`,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      case "disable": {
        stopCalendarSync();
        return new Response(
          JSON.stringify({ ok: true, message: "Calendar sync disabled" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      default:
        return new Response(
          JSON.stringify({ ok: false, error: "Unknown action" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
    }
  } catch (err) {
    logApiError("calendar-sync", "POST failed", err);
    return new Response(
      JSON.stringify({ ok: false, error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
