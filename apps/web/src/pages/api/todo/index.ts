/**
 * Todo API — List Entities & Status
 *
 * GET /api/todo — returns configured HA todo entities and sync status.
 *
 * @domain todo
 * @bounded-context integration
 */
import type { APIRoute } from "astro";
import { getTodoEntities } from "@domains/ha";
import { getTodoSyncStatus } from "@domains/todo";
import { logApiError } from "../../../lib/api-logger";

export const GET: APIRoute = async () => {
  try {
    const entities = getTodoEntities();
    const syncStatuses = getTodoSyncStatus();

    const result = entities.map((entity) => {
      const sync = Array.isArray(syncStatuses)
        ? syncStatuses.find((s) => s.entityId === entity.entity_id)
        : syncStatuses?.entityId === entity.entity_id ? syncStatuses : null;

      return {
        entity_id: entity.entity_id,
        friendly_name: entity.attributes?.friendly_name ?? entity.entity_id,
        state: entity.state,
        icon: entity.attributes?.icon ?? "mdi:clipboard-list",
        supported_features: entity.attributes?.supported_features ?? 0,
        sync: sync ? {
          active: sync.active,
          direction: sync.direction,
          lastSyncAt: sync.lastSyncAt,
          itemCount: sync.itemCount,
        } : null,
      };
    });

    return new Response(JSON.stringify({ ok: true, entities: result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    logApiError("todo", "GET failed", err);
    return new Response(JSON.stringify({ ok: false, error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
