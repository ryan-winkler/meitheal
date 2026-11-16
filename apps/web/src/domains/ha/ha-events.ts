/**
 * HA Event Emitter — Server-Side
 *
 * Fires custom events on the HA event bus for automation triggers.
 *
 * @domain ha
 * @bounded-context integration
 */
import { getHAConnection } from "./ha-connection";
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability";

const logger = createLogger({
  service: "meitheal-web", env: process.env.NODE_ENV ?? "development",
  minLevel: "info", enabledCategories: ["ha"],
  redactPatterns: defaultRedactionPatterns, auditEnabled: false,
});
const SYS_REQ = "ha-system";

export type MeithealEventType =
  | "meitheal_task_created" | "meitheal_task_updated"
  | "meitheal_task_completed" | "meitheal_task_deleted"
  | "meitheal_task_overdue" | "meitheal_task_commented" | "meitheal_area_updated"
  | "meitheal_calendar_synced" | "meitheal_calendar_event_created"
  | "meitheal_test";

export interface MeithealTaskEventData {
  task_id: string;
  title: string;
  area_id?: string;
  area_name?: string;
  priority?: string;
  due_date?: string;
  assigned_to?: string;
  completed_at?: string;
  // Phase 61: Enriched fields for Node-RED/n8n
  status?: string;
  labels?: string;
  ticket_key?: string;
  task_type?: string;
  description?: string;
  comment_id?: number;
  author?: string;
}

export interface MeithealAreaEventData {
  area_id: string; area_name: string; task_count?: number;
}

export interface MeithealCalendarEventData {
  entity_id: string;
  summary?: string;
  sync_direction?: "inbound" | "outbound" | "bidirectional";
  events_created?: number;
  events_updated?: number;
  events_deleted?: number;
  total_events?: number;
}

export async function fireHAEvent(
  eventType: MeithealEventType,
  eventData: MeithealTaskEventData | MeithealAreaEventData | MeithealCalendarEventData,
): Promise<boolean> {
  const conn = await getHAConnection();
  if (!conn) return false;
  try {
    await conn.sendMessagePromise({
      type: "fire_event", event_type: eventType,
      event_data: { ...eventData, domain: "meitheal", source: "meitheal", timestamp: new Date().toISOString() },
    });
    logger.log("info", {
      event: "ha.event.fired", domain: "ha", component: "ha-events",
      request_id: SYS_REQ, message: `Fired HA event: ${eventType}`,
    });
    return true;
  } catch (err) {
    logger.log("error", {
      event: "ha.event.fire_failed", domain: "ha", component: "ha-events",
      request_id: SYS_REQ, message: `Failed to fire HA event ${eventType}: ${err}`,
    });
    return false;
  }
}

export const emitTaskCreated = (d: MeithealTaskEventData) => fireHAEvent("meitheal_task_created", d);
export const emitTaskUpdated = (d: MeithealTaskEventData) => fireHAEvent("meitheal_task_updated", d);
export const emitTaskCompleted = (d: MeithealTaskEventData) => fireHAEvent("meitheal_task_completed", d);
export const emitTaskDeleted = (d: MeithealTaskEventData) => fireHAEvent("meitheal_task_deleted", d);
export const emitTaskOverdue = (d: MeithealTaskEventData) => fireHAEvent("meitheal_task_overdue", d);
export const emitTaskCommented = (d: MeithealTaskEventData) => fireHAEvent("meitheal_task_commented", d);
export const emitAreaUpdated = (d: MeithealAreaEventData) => fireHAEvent("meitheal_area_updated", d);
export const emitCalendarSynced = (d: MeithealCalendarEventData) => fireHAEvent("meitheal_calendar_synced", d);
export const emitCalendarEventCreated = (d: MeithealCalendarEventData) => fireHAEvent("meitheal_calendar_event_created", d);
