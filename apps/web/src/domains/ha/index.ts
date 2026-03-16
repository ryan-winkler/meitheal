/**
 * HA Domain — Barrel Export
 * @domain ha
 * @bounded-context integration
 */
export { getHAConnection, getHAConnectionStatus, getHAConfig, closeHAConnection, getIngressEntry } from "./ha-connection";
export { initEntitySubscription, getAllEntities, getEntity, getEntitiesByDomain, getCalendarEntities, getTodoEntities, onEntityChange, stopEntitySubscription } from "./ha-entities";
export { initHAIntegrations } from "./ha-startup";
export { listCalendarEvents, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, getCalendarEntityFeatures, CalendarFeature, addTodoItem, getTodoItems, updateTodoItem, removeTodoItem, removeTodoCompletedItems, moveTodoItem, subscribeTodoItems, sendNotification, callHAService } from "./ha-services";
export type { CalendarEvent, TodoItem } from "./ha-services";
export { fireHAEvent, emitTaskCreated, emitTaskUpdated, emitTaskCompleted, emitTaskDeleted, emitTaskOverdue, emitBoardUpdated, emitCalendarSynced, emitCalendarEventCreated } from "./ha-events";
export type { MeithealEventType, MeithealTaskEventData, MeithealBoardEventData, MeithealCalendarEventData } from "./ha-events";
