/**
 * Grocy → Meitheal Field Mapper
 *
 * Anti-Corruption Layer per DDD: translates Grocy domain objects
 * into Meitheal task fields at the boundary. No Grocy types leak
 * into the core task domain.
 *
 * @domain grocy
 * @bounded-context integration
 */
import type { GrocyChore, GrocyTask } from "@meitheal/integration-core";
import { STATUS } from "../../lib/status-config";

interface MeithealTaskData {
  title: string;
  description: string | null;
  status: string;
  priority: number;
  dueDate: string | null;
  labels: string[];
  /** Board ID — defaults to 'default', set to Grocy category name when available (#12) */
  boardId?: string;
}

/**
 * Map a Grocy chore to Meitheal task fields.
 *
 * - Overdue chores get priority 1 (urgent)
 * - Due chores get priority 3 (normal)
 * - Labels: "grocy-chore", "synced from grocy", optional "overdue"
 */
export function choreToTask(chore: GrocyChore): MeithealTaskData {
  const labels = ["grocy-chore", "synced from grocy"];

  if (chore.isOverdue) {
    labels.push("overdue");
  }

  const assignee = chore.nextExecutionAssignedUser?.display_name;
  const description = [
    chore.periodType ? `Repeats: ${chore.periodType}${chore.periodInterval ? ` every ${chore.periodInterval}` : ""}` : null,
    assignee ? `Assigned to: ${assignee}` : null,
    chore.lastTrackedTime ? `Last done: ${chore.lastTrackedTime.split(" ")[0]}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  // Map periodType → boardId for logical grouping (e.g. "daily" → "daily-chores")
  const boardId = chore.periodType
    ? `${chore.periodType.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-chores` || "default"
    : "default";

  return {
    title: chore.choreName,
    description: description || null,
    status: chore.isOverdue ? STATUS.ACTIVE : STATUS.PENDING,
    priority: chore.isOverdue ? 1 : 3,
    dueDate: chore.nextEstimatedExecutionTime?.split(" ")[0] ?? null,
    labels,
    boardId,
  };
}

/**
 * Map a Grocy task to Meitheal task fields.
 *
 * - Grocy tasks are simpler (name, due_date, done, category)
 * - Labels: "grocy-task", "synced from grocy"
 * - Category name → boardId (slugified) when provided (#12)
 *
 * @param task - Grocy task from adapter
 * @param categoryName - Optional category name from getCategories() map
 */
export function taskToTask(task: GrocyTask, categoryName?: string): MeithealTaskData {
  const labels = ["grocy-task", "synced from grocy"];

  // Add category as a label if available
  if (categoryName) {
    labels.push(`category:${categoryName.toLowerCase()}`);
  }

  // Slugify category name for board ID (e.g. "House Chores" → "house-chores")
  const boardId = categoryName
    ? categoryName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default"
    : "default";

  return {
    title: task.name,
    description: task.description,
    status: task.done ? STATUS.COMPLETE : STATUS.PENDING,
    priority: 3,
    dueDate: task.dueDate,
    labels,
    boardId,
  };
}

/**
 * Consolidate Grocy shopping list items into a single Meitheal task.
 *
 * Creates one "🛒 Go Shopping (N items)" task with item summary in description.
 * Per persona audit: don't import individual items — Meitheal tells you WHEN
 * to go shopping, Grocy tells you WHAT to buy.
 *
 * @param items - Shopping list items from Grocy API
 * @param productNames - Optional Map<productId, name> from adapter.getProducts()
 */
export function shoppingListToTask(
  items: { id?: number; productId: number; amount: number; note?: string }[],
  productNames?: Map<number, string>,
): MeithealTaskData {
  const itemCount = items.length;

  const description = items
    .slice(0, 20)
    .map((item) => {
      const name = productNames?.get(item.productId) ?? `Item #${item.productId}`;
      const qty = item.amount > 1 ? ` ×${item.amount}` : "";
      const note = item.note ? ` — ${item.note}` : "";
      return `• ${name}${qty}${note}`;
    })
    .join("\n")
    + (itemCount > 20 ? `\n… and ${itemCount - 20} more items` : "");

  return {
    title: `🛒 Go Shopping (${itemCount} item${itemCount !== 1 ? "s" : ""})`,
    description,
    status: STATUS.PENDING,
    priority: 3,
    dueDate: null,
    labels: ["grocy-shopping", "synced from grocy"],
  };
}
