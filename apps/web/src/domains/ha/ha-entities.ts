/**
 * HA Entity Subscriber — Server-Side
 *
 * Subscribes to HA entity state changes and maintains in-memory cache.
 *
 * @domain ha
 * @bounded-context integration
 */
import { subscribeEntities, type HassEntities, type HassEntity } from "home-assistant-js-websocket";
import { getHAConnection } from "./ha-connection";
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability";

const logger = createLogger({
  service: "meitheal-web", env: process.env.NODE_ENV ?? "development",
  minLevel: "info", enabledCategories: ["ha"],
  redactPatterns: defaultRedactionPatterns, auditEnabled: false,
});
const SYS_REQ = "ha-system";

let entityCache: HassEntities = {};
let subscribed = false;
let unsubscribe: (() => void) | null = null;
const changeListeners: Map<string, Set<(entity: HassEntity) => void>> = new Map();

export async function initEntitySubscription(): Promise<void> {
  if (subscribed) return;
  const conn = await getHAConnection();
  if (!conn) return;
  try {
    unsubscribe = subscribeEntities(conn, (entities) => {
      const prevCache = entityCache;
      entityCache = entities;
      for (const [entityId, entity] of Object.entries(entities)) {
        const prev = prevCache[entityId];
        if (!prev || prev.state !== entity.state || prev.last_updated !== entity.last_updated) {
          const listeners = changeListeners.get(entityId);
          if (listeners) {
            for (const listener of listeners) {
              try { listener(entity); } catch (err) {
                logger.log("error", {
                  event: "ha.entity.listener_error", domain: "ha", component: "ha-entities",
                  request_id: SYS_REQ, message: `Entity change listener error for ${entityId}: ${err}`,
                });
              }
            }
          }
        }
      }
    });
    subscribed = true;
    logger.log("info", {
      event: "ha.entities.subscribed", domain: "ha", component: "ha-entities",
      request_id: SYS_REQ, message: "Subscribed to HA entity state changes",
    });
  } catch (err) {
    logger.log("error", {
      event: "ha.entities.subscribe_failed", domain: "ha", component: "ha-entities",
      request_id: SYS_REQ, message: `Failed to subscribe to entities: ${err}`,
    });
  }
}

export function getAllEntities(): HassEntities { return entityCache; }
export function getEntity(entityId: string): HassEntity | undefined { return entityCache[entityId]; }
export function getEntitiesByDomain(domain: string): HassEntity[] {
  return Object.values(entityCache).filter((e) => e.entity_id.startsWith(`${domain}.`));
}
export function getCalendarEntities(): HassEntity[] { return getEntitiesByDomain("calendar"); }
export function getTodoEntities(): HassEntity[] { return getEntitiesByDomain("todo"); }

const MAX_LISTENERS_PER_ENTITY = 50;
const MAX_ENTITY_SUBSCRIPTIONS = 500;

export function onEntityChange(entityId: string, callback: (entity: HassEntity) => void): () => void {
  // Defensive cap — prevent unbounded listener growth in long-running processes
  if (changeListeners.size >= MAX_ENTITY_SUBSCRIPTIONS && !changeListeners.has(entityId)) {
    logger.log("warn", {
      event: "ha.entity.listener_cap_reached", domain: "ha", component: "ha-entities",
      request_id: SYS_REQ, message: `Entity subscription cap reached (${MAX_ENTITY_SUBSCRIPTIONS}) — rejecting listener for ${entityId}`,
    });
    return () => {}; // no-op unsubscribe
  }

  if (!changeListeners.has(entityId)) changeListeners.set(entityId, new Set());
  const listeners = changeListeners.get(entityId)!;

  if (listeners.size >= MAX_LISTENERS_PER_ENTITY) {
    logger.log("warn", {
      event: "ha.entity.listener_cap_per_entity", domain: "ha", component: "ha-entities",
      request_id: SYS_REQ, message: `Listener cap per entity reached (${MAX_LISTENERS_PER_ENTITY}) for ${entityId}`,
    });
    return () => {};
  }

  listeners.add(callback);
  return () => {
    const l = changeListeners.get(entityId);
    if (l) { l.delete(callback); if (l.size === 0) changeListeners.delete(entityId); }
  };
}

export function stopEntitySubscription(): void {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  subscribed = false;
  entityCache = {};
  changeListeners.clear();
}
