/**
 * HA Service Caller — Server-Side
 *
 * Typed wrapper around HA service actions via server-side WebSocket.
 *
 * @domain ha
 * @bounded-context integration
 */
import { callService } from "home-assistant-js-websocket";
import { getHAConnection } from "./ha-connection";
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability";

const logger = createLogger({
  service: "meitheal-web", env: process.env.NODE_ENV ?? "development",
  minLevel: "info", enabledCategories: ["ha"],
  redactPatterns: defaultRedactionPatterns, auditEnabled: false,
});
const SYS_REQ = "ha-system";

// ── Calendar Services ──

export interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  uid?: string;
  recurrence_id?: string;
}

/** HA CalendarEntityFeature bitmask values */
export const CalendarFeature = {
  CREATE_EVENT: 1,
  DELETE_EVENT: 2,
  UPDATE_EVENT: 4,
} as const;

/**
 * Detect whether a date string is date-only (YYYY-MM-DD) vs datetime.
 * HA requires different field names: start_date/end_date vs start_date_time/end_date_time.
 */
function isDateOnly(dateStr: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

/**
 * Build the correct HA service_data fields for start/end based on whether
 * the event is all-day (date-only) or timed (datetime).
 */
function buildDateFields(start: string, end: string): Record<string, string> {
  if (isDateOnly(start)) {
    return { start_date: start, end_date: end };
  }
  return { start_date_time: start, end_date_time: end };
}

/** Feature detection cache — avoids re-fetching all states for every calendar operation */
const _featureCache = new Map<string, { features: number; cachedAt: number }>();
const FEATURE_CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Get supported calendar features for an entity from its state attributes.
 * Returns bitmask of CalendarFeature values. Cached for 60s.
 */
export async function getCalendarEntityFeatures(entityId: string): Promise<number> {
  // Check cache first
  const cached = _featureCache.get(entityId);
  if (cached && Date.now() - cached.cachedAt < FEATURE_CACHE_TTL_MS) {
    return cached.features;
  }

  const conn = await getHAConnection();
  if (!conn) return 0;
  try {
    const states = await conn.sendMessagePromise<Array<{ entity_id: string; attributes: Record<string, unknown> }>>({
      type: "get_states",
    });
    const entity = states.find((s) => s.entity_id === entityId);
    const features = (entity?.attributes?.supported_features as number) ?? 0;

    // Cache result
    _featureCache.set(entityId, { features, cachedAt: Date.now() });

    return features;
  } catch (err) {
    logger.log("warn", {
      event: "ha.calendar.features.failed", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Failed to get calendar features for ${entityId}: ${err}`,
    });
    return 0;
  }
}

export async function listCalendarEvents(
  entityId: string, startDate: string, endDate: string,
): Promise<CalendarEvent[]> {
  const conn = await getHAConnection();
  if (!conn) return [];
  try {
    const result = await conn.sendMessagePromise<Record<string, unknown>>({
      type: "call_service", domain: "calendar", service: "get_events",
      target: { entity_id: entityId },
      service_data: { start_date_time: startDate, end_date_time: endDate },
      return_response: true,
    });

    // HA WebSocket call_service with return_response wraps data in a `response` key
    // Try both: result.response[entityId].events AND result[entityId].events
    let events: CalendarEvent[] = [];
    const respObj = (result as { response?: Record<string, { events?: CalendarEvent[] }> });
    if (respObj?.response?.[entityId]?.events) {
      events = respObj.response[entityId].events!;
    } else {
      // Fallback: direct access (older HA versions or home-assistant-js-websocket unwrapping)
      const direct = result as Record<string, { events?: CalendarEvent[] }>;
      events = direct?.[entityId]?.events ?? [];
    }

    logger.log("debug", {
      event: "ha.calendar.list_events", domain: "ha", component: "ha-services",
      request_id: SYS_REQ,
      message: `Fetched ${events.length} events from ${entityId} (range: ${startDate} → ${endDate})`,
    });
    return events;
  } catch (err) {
    logger.log("error", {
      event: "ha.calendar.list_events.failed", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Failed to list calendar events: ${err}`,
    });
    return [];
  }
}

export async function createCalendarEvent(
  entityId: string, event: Omit<CalendarEvent, "uid">,
): Promise<boolean> {
  const conn = await getHAConnection();
  if (!conn) return false;
  try {
    const serviceData: Record<string, unknown> = {
      summary: event.summary,
      ...buildDateFields(event.start, event.end),
      description: event.description,
      location: event.location,
    };
    await callService(conn, "calendar", "create_event", serviceData, { entity_id: entityId });
    logger.log("info", {
      event: "ha.calendar.event_created", domain: "ha", component: "ha-services",
      request_id: SYS_REQ,
      message: `Created calendar event: ${event.summary} (all-day: ${isDateOnly(event.start)})`,
    });
    return true;
  } catch (err) {
    logger.log("error", {
      event: "ha.calendar.create_event.failed", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Failed to create calendar event: ${err}`,
    });
    return false;
  }
}

/**
 * Update an existing calendar event by uid.
 * Uses HA's calendar.update_event service (requires UPDATE_EVENT feature).
 * Falls back to delete + create if update service is not supported.
 * @see https://developers.home-assistant.io/docs/core/entity/calendar#update-events
 */
export async function updateCalendarEvent(
  entityId: string, event: CalendarEvent,
  options?: { recurrence_id?: string; recurrence_range?: string },
): Promise<boolean> {
  const conn = await getHAConnection();
  if (!conn) return false;

  const serviceData: Record<string, unknown> = {
    uid: event.uid,
    summary: event.summary,
    ...buildDateFields(event.start, event.end),
    description: event.description,
    location: event.location,
  };
  if (options?.recurrence_id) serviceData.recurrence_id = options.recurrence_id;
  if (options?.recurrence_range) serviceData.recurrence_range = options.recurrence_range;

  try {
    // Try HA's native calendar.update_event service first
    await callService(conn, "calendar", "update_event", serviceData, { entity_id: entityId });
    logger.log("info", {
      event: "ha.calendar.event_updated", domain: "ha", component: "ha-services",
      request_id: SYS_REQ,
      message: `Updated calendar event: ${event.summary} (uid: ${event.uid}, all-day: ${isDateOnly(event.start)})`,
    });
    return true;
  } catch (updateErr) {
    // Fallback: calendar may not support update_event — try delete + create
    logger.log("warn", {
      event: "ha.calendar.update_event.fallback", domain: "ha", component: "ha-services",
      request_id: SYS_REQ,
      message: `update_event failed for ${entityId}, falling back to delete+create: ${updateErr}`,
    });
    try {
      if (event.uid) {
        await callService(conn, "calendar", "delete_event", { uid: event.uid }, { entity_id: entityId });
      }
      const createData: Record<string, unknown> = {
        summary: event.summary,
        ...buildDateFields(event.start, event.end),
        description: event.description,
        location: event.location,
      };
      await callService(conn, "calendar", "create_event", createData, { entity_id: entityId });
      logger.log("info", {
        event: "ha.calendar.event_updated_via_recreate", domain: "ha", component: "ha-services",
        request_id: SYS_REQ, message: `Updated event via delete+create: ${event.summary}`,
      });
      return true;
    } catch (fallbackErr) {
      logger.log("error", {
        event: "ha.calendar.update_event.failed", domain: "ha", component: "ha-services",
        request_id: SYS_REQ, message: `Failed to update calendar event (all methods): ${fallbackErr}`,
      });
      return false;
    }
  }
}

/**
 * Delete a calendar event by uid.
 * Uses HA's calendar.delete_event service (requires DELETE_EVENT feature).
 * Supports recurring event deletion via recurrence_id and recurrence_range.
 * @see https://developers.home-assistant.io/docs/core/entity/calendar#delete-events
 */
export async function deleteCalendarEvent(
  entityId: string, uid: string,
  options?: { recurrence_id?: string; recurrence_range?: "THISANDFUTURE" },
): Promise<boolean> {
  const conn = await getHAConnection();
  if (!conn) return false;
  try {
    const serviceData: Record<string, unknown> = { uid };
    if (options?.recurrence_id) serviceData.recurrence_id = options.recurrence_id;
    if (options?.recurrence_range) serviceData.recurrence_range = options.recurrence_range;

    await callService(conn, "calendar", "delete_event", serviceData, { entity_id: entityId });
    logger.log("info", {
      event: "ha.calendar.event_deleted", domain: "ha", component: "ha-services",
      request_id: SYS_REQ,
      message: `Deleted calendar event: uid=${uid} from ${entityId}${options?.recurrence_id ? ` (recurrence: ${options.recurrence_id})` : ""}`,
    });
    return true;
  } catch (err) {
    logger.log("warn", {
      event: "ha.calendar.delete_event.failed", domain: "ha", component: "ha-services",
      request_id: SYS_REQ,
      message: `Failed to delete calendar event uid=${uid}: ${err} (may not be supported by calendar integration)`,
    });
    return false;
  }
}

// ── Todo Services ──

export interface TodoItem {
  uid?: string;
  summary: string;
  status?: "needs_action" | "completed";
  due?: string | undefined;
  description?: string | undefined;
  completed?: string;
}

/**
 * Get items from an HA todo list entity.
 * Uses call_service with return_response to fetch item data.
 */
export async function getTodoItems(
  entityId: string, status?: ("needs_action" | "completed")[],
): Promise<TodoItem[]> {
  const conn = await getHAConnection();
  if (!conn) return [];
  try {
    const serviceData: Record<string, unknown> = {};
    if (status && status.length > 0) serviceData.status = status;

    const result = await conn.sendMessagePromise<Record<string, unknown>>({
      type: "call_service", domain: "todo", service: "get_items",
      target: { entity_id: entityId },
      service_data: serviceData,
      return_response: true,
    });

    // HA WebSocket call_service with return_response wraps data in a `response` key
    // Try both: result.response[entityId].items AND result[entityId].items
    let items: TodoItem[] = [];
    const respObj = (result as { response?: Record<string, { items?: TodoItem[] }> });
    if (respObj?.response?.[entityId]?.items) {
      items = respObj.response[entityId].items!;
    } else {
      const direct = result as Record<string, { items?: TodoItem[] }>;
      items = direct?.[entityId]?.items ?? [];
    }

    logger.log("debug", {
      event: "ha.todo.get_items", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Fetched ${items.length} todo items from ${entityId}`,
    });
    return items;
  } catch (err) {
    logger.log("error", {
      event: "ha.todo.get_items.failed", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Failed to get todo items: ${err}`,
    });
    return [];
  }
}

/**
 * Add a new item to an HA todo list.
 * Supports both due_date (date-only) and due_datetime (date+time).
 */
export async function addTodoItem(
  entityId: string, item: Omit<TodoItem, "uid" | "status">,
): Promise<boolean> {
  const conn = await getHAConnection();
  if (!conn) return false;
  try {
    const serviceData: Record<string, unknown> = {
      item: item.summary,
      description: item.description,
    };
    // Detect date-only vs datetime and use the correct field
    if (item.due) {
      if (/[\sT]\d{2}:\d{2}/.test(item.due)) {
        serviceData.due_datetime = item.due;
      } else {
        serviceData.due_date = item.due;
      }
    }
    await callService(conn, "todo", "add_item", serviceData, { entity_id: entityId });
    logger.log("info", {
      event: "ha.todo.item_added", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Added todo item: ${item.summary}`,
    });
    return true;
  } catch (err) {
    logger.log("error", {
      event: "ha.todo.add_item.failed", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Failed to add todo item: ${err}`,
    });
    return false;
  }
}

/**
 * Update an existing item in an HA todo list.
 * Identifies the item by uid or summary text.
 */
export async function updateTodoItem(
  entityId: string,
  item: string,
  updates: { summary?: string | undefined; status?: "needs_action" | "completed" | undefined; description?: string | undefined; due_date?: string | undefined; due_datetime?: string | undefined },
): Promise<boolean> {
  const conn = await getHAConnection();
  if (!conn) return false;
  try {
    const serviceData: Record<string, unknown> = { item };
    if (updates.summary) serviceData.rename = updates.summary;
    if (updates.status) serviceData.status = updates.status;
    if (updates.description !== undefined) serviceData.description = updates.description;
    if (updates.due_date) serviceData.due_date = updates.due_date;
    if (updates.due_datetime) serviceData.due_datetime = updates.due_datetime;

    await callService(conn, "todo", "update_item", serviceData, { entity_id: entityId });
    logger.log("info", {
      event: "ha.todo.item_updated", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Updated todo item: ${item}`,
    });
    return true;
  } catch (err) {
    logger.log("error", {
      event: "ha.todo.update_item.failed", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Failed to update todo item: ${err}`,
    });
    return false;
  }
}

/**
 * Remove one or more items from an HA todo list.
 * Items are identified by uid or summary text.
 */
export async function removeTodoItem(
  entityId: string, items: string[],
): Promise<boolean> {
  const conn = await getHAConnection();
  if (!conn) return false;
  try {
    await callService(conn, "todo", "remove_item", { item: items }, { entity_id: entityId });
    logger.log("info", {
      event: "ha.todo.item_removed", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Removed ${items.length} todo item(s) from ${entityId}`,
    });
    return true;
  } catch (err) {
    logger.log("error", {
      event: "ha.todo.remove_item.failed", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Failed to remove todo item: ${err}`,
    });
    return false;
  }
}

/**
 * Remove all completed items from an HA todo list.
 */
export async function removeTodoCompletedItems(
  entityId: string,
): Promise<boolean> {
  const conn = await getHAConnection();
  if (!conn) return false;
  try {
    await callService(conn, "todo", "remove_completed_items", {}, { entity_id: entityId });
    logger.log("info", {
      event: "ha.todo.completed_items_removed", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Removed completed items from ${entityId}`,
    });
    return true;
  } catch (err) {
    logger.log("error", {
      event: "ha.todo.remove_completed.failed", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Failed to remove completed items: ${err}`,
    });
    return false;
  }
}

/**
 * Move/reorder an item within an HA todo list via WebSocket command.
 * Moves the item with `uid` to the position after `previousUid`.
 * Pass `undefined` for previousUid to move to the first position.
 */
export async function moveTodoItem(
  entityId: string, uid: string, previousUid?: string,
): Promise<boolean> {
  const conn = await getHAConnection();
  if (!conn) return false;
  try {
    const msg = {
      type: "todo/item/move" as const,
      entity_id: entityId,
      uid,
      ...(previousUid !== undefined ? { previous_uid: previousUid } : {}),
    };
    await conn.sendMessagePromise(msg);
    logger.log("info", {
      event: "ha.todo.item_moved", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Moved todo item ${uid} in ${entityId}`,
    });
    return true;
  } catch (err) {
    logger.log("error", {
      event: "ha.todo.move_item.failed", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Failed to move todo item: ${err}`,
    });
    return false;
  }
}

/**
 * Subscribe to real-time updates for a todo list entity via WebSocket.
 * Uses HA's `todo/item/subscribe` command for push-based updates.
 * Returns an unsubscribe function.
 */
export async function subscribeTodoItems(
  entityId: string,
  callback: (items: TodoItem[]) => void,
): Promise<() => void> {
  const conn = await getHAConnection();
  if (!conn) return () => {};
  try {
    const unsub = await conn.subscribeMessage<{ items?: TodoItem[] }>(
      (msg) => {
        const items = msg.items ?? [];
        callback(items);
      },
      { type: "todo/item/subscribe", entity_id: entityId },
    );
    logger.log("info", {
      event: "ha.todo.subscribed", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Subscribed to todo updates for ${entityId}`,
    });
    return unsub;
  } catch (err) {
    logger.log("error", {
      event: "ha.todo.subscribe.failed", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Failed to subscribe to todo updates: ${err}`,
    });
    return () => {};
  }
}

// ── Notification Services ──

export async function sendNotification(
  target: string, title: string, message: string, data?: Record<string, unknown>,
): Promise<boolean> {
  const conn = await getHAConnection();
  if (!conn) return false;
  try {
    await callService(conn, "notify", target, { title, message, data });
    logger.log("info", {
      event: "ha.notification.sent", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Sent notification to ${target}: ${title}`,
    });
    return true;
  } catch (err) {
    logger.log("error", {
      event: "ha.notification.failed", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Failed to send notification: ${err}`,
    });
    return false;
  }
}

// ── Conversation / Assist Services (Phase 52 → 58 enhanced) ──

/** Full response from HA conversation.process */
export interface AssistResponse {
  speech: string | null;
  conversationId: string | null;
  responseType: "action_done" | "query_answer" | "error" | null;
}

/** HA conversation agent descriptor */
export interface ConversationAgent {
  id: string;
  name: string;
  supported_languages: string[] | "*";
}

/**
 * Send text to HA's conversation.process service.
 * Supports multi-turn via conversation_id and agent selection via agent_id.
 * @see https://developers.home-assistant.io/docs/intent_conversation_api
 */
export async function askAssist(
  text: string,
  options?: { agentId?: string; conversationId?: string },
): Promise<AssistResponse> {
  const conn = await getHAConnection();
  if (!conn) return { speech: null, conversationId: null, responseType: null };
  try {
    const msgData: { type: "conversation/process"; text: string; agent_id?: string; conversation_id?: string } = {
      type: "conversation/process",
      text,
    };
    if (options?.agentId) msgData.agent_id = options.agentId;
    if (options?.conversationId) msgData.conversation_id = options.conversationId;

    const result = await conn.sendMessagePromise<Record<string, unknown>>(msgData as { type: string; [key: string]: unknown });

    // Parse full conversation response shape
    const payload = result as {
      response?: {
        response_type?: string;
        speech?: { plain?: { speech?: string } };
      };
      conversation_id?: string;
    };
    const speechText = payload?.response?.speech?.plain?.speech ?? null;
    const conversationId = payload?.conversation_id ?? null;
    const responseType = (payload?.response?.response_type as AssistResponse["responseType"]) ?? null;

    logger.log("info", {
      event: "ha.conversation.success", domain: "ha", component: "ha-services",
      request_id: SYS_REQ,
      message: `Asked Assist: "${text}" → ${responseType ?? "unknown"} (conv: ${conversationId ?? "new"})`,
    });
    return { speech: speechText, conversationId, responseType };
  } catch (err) {
    logger.log("error", {
      event: "ha.conversation.failed", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Failed to ask assist: ${err}`,
    });
    return { speech: null, conversationId: null, responseType: null };
  }
}

/**
 * List available HA conversation agents.
 * Uses the conversation/agent/list WebSocket command.
 */
export async function listConversationAgents(): Promise<ConversationAgent[]> {
  const conn = await getHAConnection();
  if (!conn) return [];
  try {
    const result = await conn.sendMessagePromise<{ agents?: ConversationAgent[] }>({
      type: "conversation/agent/list",
    });
    const agents = result?.agents ?? [];
    logger.log("debug", {
      event: "ha.conversation.agents_listed", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Found ${agents.length} conversation agent(s)`,
    });
    return agents;
  } catch (err) {
    logger.log("error", {
      event: "ha.conversation.agents_list_failed", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Failed to list conversation agents: ${err}`,
    });
    return [];
  }
}

// ── Generic Service Call ──

export async function callHAService(
  domain: string, service: string,
  serviceData?: Record<string, unknown>,
  target?: { entity_id?: string | string[]; device_id?: string | string[] },
): Promise<unknown> {
  const conn = await getHAConnection();
  if (!conn) return null;
  try {
    const result = await callService(conn, domain, service, serviceData, target);
    logger.log("debug", {
      event: "ha.service.called", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Called ${domain}.${service}`,
    });
    return result;
  } catch (err) {
    logger.log("error", {
      event: "ha.service.call_failed", domain: "ha", component: "ha-services",
      request_id: SYS_REQ, message: `Failed to call ${domain}.${service}: ${err}`,
    });
    return null;
  }
}
