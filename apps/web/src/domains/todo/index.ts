/**
 * Todo Domain — Barrel Export
 *
 * Bidirectional sync between HA Todo entities and Meitheal tasks.
 *
 * @domain todo
 * @bounded-context integration
 */
export {
  startTodoSync,
  stopTodoSync,
  getTodoSyncStatus,
  getActiveTodoSyncConfigs,
  pushTaskToTodoList,
  removeTaskFromTodoList,
  syncTodoFromHA,
  mergeHATodoItems,
} from "./todo-bridge";

export type { TodoSyncConfig, TodoSyncStatus } from "./todo-bridge";

export {
  haStatusToMeitheal,
  meithealStatusToHA,
  isDueDateTime,
  buildDueServiceData,
  mapHATodoToMeithealTask,
  mapMeithealTaskToHATodo,
} from "./todo-status-mapper";

export type {
  HAStatus,
  MeithealStatus,
  HATodoItem,
  MeithealTaskShape,
} from "./todo-status-mapper";
