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
  type TaskCalendarMeta,
} from "./calendar-bridge"
export { CALENDAR_ENTITY_SETTINGS, configuredCalendarEntityIds } from "./resolve-calendar-entities"
