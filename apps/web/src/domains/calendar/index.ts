/**
 * Calendar Domain — Barrel Export
 * @domain calendar
 * @bounded-context integration
 */
export {
  startMultiCalendarSync,
  startCalendarSync,
  stopCalendarSync,
  syncFromHA,
  pushTaskToCalendar,
  buildCalendarDescription,
  removeTaskCalendarEvent,
  getCalendarSyncStatus,
  getCalendarSyncConfigs,
  getCalendarSyncConfig,
  startCalDAVSync,
  stopCalDAVSync,
  syncCalDAVEvents,
  isImportedCalendarTask,
  type CalendarSyncConfig,
  type CalendarSyncMode,
  type CalendarSyncStatusEntity,
  type TaskCalendarMeta
} from "./calendar-bridge"
export { CALENDAR_ENTITY_SETTINGS, configuredCalendarEntityIds } from "./resolve-calendar-entities"
export { hasCalendarSyncOptOut } from "./calendar-policy"

export type { CalDAVOperationOptions } from "./caldav-client"
export {
  isHtmlDescription,
  stripHtmlTags,
  normalizeCalendarDescription,
  isMeithealOriginatedEvent,
  stripCalendarReminderWrappers,
} from "./calendar-event-identity"
