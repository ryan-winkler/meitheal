/**
 * Todo Sync API — Manual Sync Trigger & Status
 *
 * POST /api/todo/sync — trigger manual sync
 * GET  /api/todo/sync — get sync status
 *
 * @domain todo
 * @bounded-context integration
 */
import type { APIRoute } from "astro";
import { syncTodoFromHA, getTodoSyncStatus, startTodoSync, stopTodoSync } from "@domains/todo";
import { getHAConnectionStatus } from "@domains/ha/ha-connection";
import { logApiError } from "../../../lib/api-logger";

/**
 * GET /api/todo/sync — returns current sync status for all entities
 */
export const GET: APIRoute = async () => {
  try {
    const status = getTodoSyncStatus();
    const haStatus = getHAConnectionStatus();
    return new Response(JSON.stringify({
      ok: true,
      sync: status,
      ha_connected: haStatus.connected,
      ha_version: haStatus.haVersion,
      ha_error: haStatus.lastError,
    }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    logApiError("todo-sync", "GET failed", err);
    return new Response(JSON.stringify({ ok: false, error: "Internal server error" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
};

/**
 * POST /api/todo/sync
 * Body: { action: "sync" | "enable" | "disable", entity_id?, direction? }
 */
export const POST: APIRoute = async ({ request }) => {
  try {
    let body: {
      action?: "sync" | "enable" | "disable";
      entity_id?: string;
      entities?: string[];
      direction?: "inbound" | "outbound" | "bidirectional";
    };

    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "Invalid JSON body" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    const action = body.action ?? "sync";

    switch (action) {
      case "sync": {
        // Auto-start sync if entity_id provided but not yet active
        if (body.entity_id) {
          const existing = getTodoSyncStatus(body.entity_id);
          if (!existing) {
            startTodoSync({
              entityId: body.entity_id,
              syncEnabled: true,
              writeBack: body.direction === "outbound" || body.direction === "bidirectional",
              syncDirection: body.direction ?? "bidirectional",
            });
          }
        }
        const result = await syncTodoFromHA(body.entity_id);
        const status = getTodoSyncStatus(body.entity_id);
        const haStatus = getHAConnectionStatus();
        return new Response(JSON.stringify({
          ok: true,
          status,
          ha_connected: haStatus.connected,
          synced: result.synced,
          errors: result.errors,
          message: !haStatus.connected
            ? "HA not connected — check SUPERVISOR_TOKEN and addon context"
            : result.synced > 0
              ? `Synced ${result.synced} item(s)`
              : result.errors > 0 ? "Sync encountered errors" : "No items to sync",
        }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }

      case "enable": {
        // Support multi-entity: body.entities array or single body.entity_id
        const entities: string[] = Array.isArray((body as Record<string, unknown>).entities)
          ? ((body as Record<string, unknown>).entities as string[]).filter((e) => typeof e === "string" && e.length > 0)
          : body.entity_id ? [body.entity_id] : [];

        if (entities.length === 0) {
          return new Response(JSON.stringify({ ok: false, error: "entity_id or entities[] required" }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }
        startTodoSync(
          entities.map((entityId) => ({
            entityId,
            syncEnabled: true,
            writeBack: body.direction === "outbound" || body.direction === "bidirectional",
            syncDirection: body.direction ?? "bidirectional",
          })),
        );
        return new Response(JSON.stringify({ ok: true, message: `Sync enabled for ${entities.length} entity/entities: ${entities.join(", ")}` }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }

      case "disable": {
        // Stop specific entity or all active syncs
        if (body.entity_id) {
          stopTodoSync(body.entity_id);
        } else {
          stopTodoSync(); // stop all
        }
        return new Response(JSON.stringify({ ok: true, message: body.entity_id ? `Sync disabled for ${body.entity_id}` : "All todo syncs disabled" }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }

      default:
        return new Response(JSON.stringify({ ok: false, error: "Unknown action" }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
    }
  } catch (err) {
    logApiError("todo-sync", "POST failed", err);
    return new Response(JSON.stringify({ ok: false, error: "Internal server error" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
};
