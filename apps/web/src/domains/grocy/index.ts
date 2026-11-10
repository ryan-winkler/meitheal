/**
 * Grocy Domain — Barrel Export
 * @domain grocy
 * @bounded-context integration
 */
export {
  startGrocySync,
  stopGrocySync,
  syncFromGrocy,
  pushCompletionToGrocy,
  pushNewTaskToGrocy,
  getGrocySyncStatus,
  getActiveGrocySyncConfig,
  type GrocySyncConfig,
} from "./grocy-bridge";

export {
  choreToTask,
  taskToTask,
  shoppingListToTask,
} from "./grocy-mapper";
