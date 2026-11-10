/**
 * Todo Status Mapper — HA ↔ Meitheal Field Translation
 *
 * Maps between HA TodoItem shape and Meitheal task shape.
 * HA uses 2-state status (needs_action | completed).
 * Meitheal uses 4-state canonical status (backlog | pending | active | complete).
 *
 * Mapping rules:
 *   HA needs_action  → Meitheal pending
 *   HA completed     → Meitheal complete
 *   Meitheal backlog     → HA needs_action
 *   Meitheal pending     → HA needs_action
 *   Meitheal active      → HA needs_action (no HA equivalent)
 *   Meitheal complete    → HA completed
 *
 * @domain todo
 * @bounded-context integration
 */

export type HAStatus = "needs_action" | "completed";
export type MeithealStatus = "backlog" | "pending" | "active" | "complete";

export interface HATodoItem {
  uid?: string;
  summary: string;
  status?: HAStatus;
  due?: string;
  description?: string;
  completed?: string;
}

export interface MeithealTaskShape {
  id: string;
  title: string;
  status: MeithealStatus;
  due_date?: string | null;
  description?: string | null;
  priority?: number;
  labels?: string[];
}

// ── Status Mapping ──

export function haStatusToMeitheal(haStatus: HAStatus): MeithealStatus {
  switch (haStatus) {
    case "needs_action": return "pending";
    case "completed": return "complete";
    default: return "pending";
  }
}

export function meithealStatusToHA(meithealStatus: MeithealStatus | string): HAStatus {
  switch (meithealStatus) {
    case "backlog": return "needs_action";
    case "pending": return "needs_action";
    case "active": return "needs_action";
    case "complete": return "completed";
    // Legacy aliases — graceful fallback
    case "todo": return "needs_action";
    case "in_progress": return "needs_action";
    case "done": return "completed";
    default: return "needs_action";
  }
}

// ── Due Date Handling ──

/**
 * Detect whether a due string is a date-only or datetime.
 * HA distinguishes `due_date` (YYYY-MM-DD) from `due_datetime` (YYYY-MM-DD HH:MM:SS).
 */
export function isDueDateTime(due: string): boolean {
  // If it has a time component (T or space followed by time), it's datetime
  return /[\sT]\d{2}:\d{2}/.test(due);
}

/**
 * Build the service_data for HA add_item / update_item based on due string format.
 */
export function buildDueServiceData(due?: string | null): Record<string, string> {
  if (!due) return {};
  if (isDueDateTime(due)) {
    return { due_datetime: due };
  }
  return { due_date: due };
}

// ── Full Object Mapping ──

/**
 * Convert an HA TodoItem to a shape suitable for creating/updating a Meitheal task.
 */
export function mapHATodoToMeithealTask(
  todoItem: HATodoItem,
  defaults?: { priority?: number; labels?: string[] },
): Omit<MeithealTaskShape, "id"> {
  return {
    title: todoItem.summary,
    status: haStatusToMeitheal(todoItem.status ?? "needs_action"),
    due_date: todoItem.due ?? null,
    description: todoItem.description ?? null,
    priority: defaults?.priority ?? 3,
    labels: defaults?.labels ?? [],
  };
}

/**
 * Convert a Meitheal task to HA service call data for add_item / update_item.
 */
export function mapMeithealTaskToHATodo(task: MeithealTaskShape): {
  item: string;
  status: HAStatus;
  due_data: Record<string, string>;
  description: string | undefined;
} {
  return {
    item: task.title,
    status: meithealStatusToHA(task.status),
    due_data: buildDueServiceData(task.due_date),
    description: task.description ?? undefined,
  };
}
