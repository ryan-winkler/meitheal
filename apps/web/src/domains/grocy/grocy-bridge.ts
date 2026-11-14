/**
 * Grocy Bridge — Bidirectional Sync with Grocy
 *
 * Syncs Grocy chores + tasks → Meitheal tasks (inbound)
 * Pushes task completions → Grocy chore/task API (outbound)
 * Consolidates shopping list → single "Go Shopping" task
 *
 * Mirrors todo-bridge.ts pattern: polling timer, confirmations table,
 * no-sync/loop-prevention labels, start/stop/status methods.
 *
 * @domain grocy
 * @bounded-context integration
 */
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability";
import { STATUS } from "../../lib/status-config";
import { GrocyAdapter, type GrocyChore, type GrocyTask } from "@meitheal/integration-core";
import type { SyncTaskMutation } from "@domains/tasks";
import type { Client } from "@libsql/client";
import { choreToTask, taskToTask, shoppingListToTask } from "./grocy-mapper.js";

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["integrations", "grocy"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: false,
});

const SYS_REQ = "grocy-sync";

// ═══════ Types ═══════

export interface GrocySyncConfig {
  syncEnabled: boolean;
  syncMode: "import" | "export" | "bidirectional";
  intervalMs: number;
}

interface GrocySyncState {
  config: GrocySyncConfig;
  adapter: GrocyAdapter | null;
  timer: ReturnType<typeof setInterval> | null;
  lastSyncAt: number | null;
  lastSyncError: string | null;
  itemCount: number;
  choreCount: number;
  taskCount: number;
  shoppingCount: number;
}

const state: GrocySyncState = {
  config: { syncEnabled: false, syncMode: "import", intervalMs: 15 * 60 * 1000 },
  adapter: null,
  timer: null,
  lastSyncAt: null,
  lastSyncError: null,
  itemCount: 0,
  choreCount: 0,
  taskCount: 0,
  shoppingCount: 0,
};

// ═══════ Lifecycle ═══════

/**
 * Start Grocy sync with polling timer.
 */
export function startGrocySync(config: GrocySyncConfig, adapter: GrocyAdapter): void {
  stopGrocySync();

  state.config = config;
  state.adapter = adapter;

  if (!config.syncEnabled) return;

  // Initial sync immediately
  syncFromGrocy().catch((err) => {
    logger.log("error", {
      event: "grocy.sync.initial_failed",
      domain: "integrations",
      component: "grocy-bridge",
      request_id: SYS_REQ,
      message: `Initial Grocy sync failed: ${err}`,
    });
  });

  // Set up polling timer (0 = manual only)
  if (config.intervalMs > 0) {
    state.timer = setInterval(() => { // nosemgrep
      syncFromGrocy().catch((err) => {
        logger.log("error", {
          event: "grocy.sync.poll_failed",
          domain: "integrations",
          component: "grocy-bridge",
          request_id: SYS_REQ,
          message: `Grocy poll sync failed: ${err}`,
        });
      });
    }, config.intervalMs);
  }

  logger.log("info", {
    event: "grocy.sync.started",
    domain: "integrations",
    component: "grocy-bridge",
    request_id: SYS_REQ,
    message: `Grocy sync started (mode: ${config.syncMode}, interval: ${config.intervalMs}ms)`,
  });
}

/**
 * Stop Grocy sync and clean up timer.
 */
export function stopGrocySync(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.config.syncEnabled = false;
  state.adapter = null;
}

/**
 * Get current sync status.
 */
export function getGrocySyncStatus() {
  return {
    active: state.config.syncEnabled && state.adapter !== null,
    syncMode: state.config.syncMode,
    intervalMs: state.config.intervalMs,
    lastSyncAt: state.lastSyncAt,
    lastSyncError: state.lastSyncError,
    itemCount: state.itemCount,
    choreCount: state.choreCount,
    taskCount: state.taskCount,
    shoppingCount: state.shoppingCount,
  };
}

/**
 * Get active config for outbound dispatcher checks.
 */
export function getActiveGrocySyncConfig(): GrocySyncConfig | null {
  if (!state.config.syncEnabled || !state.adapter) return null;
  return state.config;
}

/**
 * Get the active Grocy adapter instance (if sync is running).
 * Used by the stock API endpoint to avoid creating duplicate adapter instances.
 */
export function getGrocyAdapter(): GrocyAdapter | null {
  return state.adapter;
}

// ═══════ Inbound: Grocy → Meitheal ═══════

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

/** Retry a Grocy API call if the error is retryable. */
async function withRetry<T>(fn: () => Promise<import("@meitheal/integration-core").GrocyResult<T>>): Promise<import("@meitheal/integration-core").GrocyResult<T>> {
  let lastResult: import("@meitheal/integration-core").GrocyResult<T> | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    lastResult = await fn();
    if (lastResult.ok) return lastResult;
    if (!lastResult.retryable || attempt === MAX_RETRIES) return lastResult;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
  }
  return lastResult!;
}

/**
 * Pull chores, tasks, and shopping list from Grocy → create/update Meitheal tasks.
 * Includes: retry on retryable errors, product name resolution, stale task cleanup.
 */
export async function syncFromGrocy(): Promise<{
  chores: number;
  tasks: number;
  shopping: number;
  errors: number;
}> {
  const adapter = state.adapter;
  if (!adapter) {
    return { chores: 0, tasks: 0, shopping: 0, errors: 0 };
  }

  const result = { chores: 0, tasks: 0, shopping: 0, errors: 0 };

  // Only import if mode allows
  if (state.config.syncMode === "export") {
    return result;
  }

  // Pre-fetch product name map for shopping list (Fix #2)
  let productNames = new Map<number, string>();
  try {
    const productsResult = await adapter.getProducts();
    if (productsResult.ok) productNames = productsResult.data;
  } catch { /* product names are best-effort */ }

  // Pre-fetch task categories for board mapping (#12)
  let categoryNames = new Map<number, string>();
  try {
    const categoriesResult = await adapter.getCategories();
    if (categoriesResult.ok) categoryNames = categoriesResult.data;
  } catch { /* category names are best-effort */ }

  // Track all Grocy entity keys seen this sync for stale detection (Fix #3)
  const seenEntityKeys = new Set<string>();

  // 1. Sync chores (with retry — Fix #5)
  try {
    const choresResult = await withRetry(() => adapter.getChores());
    if (choresResult.ok) {
      for (const c of choresResult.data) seenEntityKeys.add(`chore:${c.choreId}`);
      result.chores = await mergeGrocyChores(choresResult.data);
    } else {
      result.errors++;
      logger.log("error", {
        event: "grocy.sync.chores_failed",
        domain: "integrations",
        component: "grocy-bridge",
        request_id: SYS_REQ,
        message: `Failed to fetch chores: ${choresResult.message}`,
      });
    }
  } catch (err) {
    result.errors++;
    logger.log("error", {
      event: "grocy.sync.chores_error",
      domain: "integrations",
      component: "grocy-bridge",
      request_id: SYS_REQ,
      message: `Chore sync error: ${err}`,
    });
  }

  // 2. Sync tasks — fetch ALL (including completed) to detect status drift (Fix #6)
  try {
    const tasksResult = await withRetry(() => adapter.getTasks(true));
    if (tasksResult.ok) {
      for (const t of tasksResult.data) seenEntityKeys.add(`task:${t.taskId}`);
      result.tasks = await mergeGrocyTasks(tasksResult.data, categoryNames);
    } else {
      result.errors++;
      logger.log("error", {
        event: "grocy.sync.tasks_failed",
        domain: "integrations",
        component: "grocy-bridge",
        request_id: SYS_REQ,
        message: `Failed to fetch tasks: ${tasksResult.message}`,
      });
    }
  } catch (err) {
    result.errors++;
    logger.log("error", {
      event: "grocy.sync.tasks_error",
      domain: "integrations",
      component: "grocy-bridge",
      request_id: SYS_REQ,
      message: `Task sync error: ${err}`,
    });
  }

  // 3. Consolidate shopping list (with product names — Fix #2)
  try {
    const shoppingResult = await adapter.getShoppingList();
    if (shoppingResult.ok && shoppingResult.data.length > 0) {
      seenEntityKeys.add("shopping:list-1");
      result.shopping = await mergeShoppingList(
        shoppingResult.data as { id?: number; productId: number; amount: number; note?: string }[],
        productNames,
      );
    }
  } catch (err) {
    result.errors++;
    logger.log("error", {
      event: "grocy.sync.shopping_error",
      domain: "integrations",
      component: "grocy-bridge",
      request_id: SYS_REQ,
      message: `Shopping list sync error: ${err}`,
    });
  }

  // 4. Clean stale tasks — archive Meitheal tasks whose Grocy source was deleted (Fix #3)
  if (result.errors === 0) {
    try {
      await cleanStaleTasks(seenEntityKeys);
    } catch (err) {
      logger.log("warn", {
        event: "grocy.sync.stale_cleanup_failed",
        domain: "integrations",
        component: "grocy-bridge",
        request_id: SYS_REQ,
        message: `Stale cleanup failed: ${err}`,
      });
    }
  }

  // Update state
  state.lastSyncAt = Date.now();
  state.lastSyncError = result.errors > 0 ? `${result.errors} sync error(s)` : null;
  state.choreCount = result.chores;
  state.taskCount = result.tasks;
  state.shoppingCount = result.shopping;
  state.itemCount = result.chores + result.tasks + result.shopping;

  logger.log("info", {
    event: "grocy.sync.complete",
    domain: "integrations",
    component: "grocy-bridge",
    request_id: SYS_REQ,
    message: `Grocy sync: ${result.chores} chores, ${result.tasks} tasks, ${result.shopping} shopping — ${result.errors} errors`,
  });

  return result;
}

// ═══════ Outbound: Meitheal → Grocy ═══════

/**
 * Push a task completion to Grocy when a synced task is marked done.
 * Called by the outbound sync dispatcher for tasks with grocy confirmations.
 */
export async function pushCompletionToGrocy(taskId: string): Promise<boolean> {
  const adapter = state.adapter;
  if (!adapter) return false;

  if (state.config.syncMode === "import") return false;

  try {
    const client = await getClient();

    // Look up the grocy sync confirmation for this task
    const row = await client.execute({
      sql: "SELECT grocy_entity_type, grocy_entity_id FROM grocy_sync_confirmations WHERE task_id = ? LIMIT 1",
      args: [taskId],
    });

    if (row.rows.length === 0) return false;

    const entityType = String(row.rows[0]!.grocy_entity_type);
    const entityId = Number(row.rows[0]!.grocy_entity_id);

    if (entityType === "chore") {
      const result = await adapter.trackChoreExecution(entityId);
      if (result.ok) {
        logger.log("info", {
          event: "grocy.sync.chore_completed",
          domain: "integrations",
          component: "grocy-bridge",
          request_id: SYS_REQ,
          message: `Marked chore ${entityId} as done in Grocy`,
        });
        return true;
      }
      logger.log("error", {
        event: "grocy.sync.chore_completion_failed",
        domain: "integrations",
        component: "grocy-bridge",
        request_id: SYS_REQ,
        message: `Failed to mark chore ${entityId} done: ${result.message}`,
      });
    } else if (entityType === "task") {
      const result = await adapter.markTaskCompleted(entityId);
      if (result.ok) {
        logger.log("info", {
          event: "grocy.sync.task_completed",
          domain: "integrations",
          component: "grocy-bridge",
          request_id: SYS_REQ,
          message: `Marked task ${entityId} as done in Grocy`,
        });
        return true;
      }
      logger.log("error", {
        event: "grocy.sync.task_completion_failed",
        domain: "integrations",
        component: "grocy-bridge",
        request_id: SYS_REQ,
        message: `Failed to mark task ${entityId} done: ${result.message}`,
      });
    } else if (entityType === "shopping") {
      // Fix #7: Clear shopping list when "Go Shopping" task is marked done
      const result = await adapter.clearShoppingList();
      if (result.ok) {
        logger.log("info", {
          event: "grocy.sync.shopping_cleared",
          domain: "integrations",
          component: "grocy-bridge",
          request_id: SYS_REQ,
          message: "Cleared Grocy shopping list (task marked done)",
        });
        return true;
      }
      logger.log("error", {
        event: "grocy.sync.shopping_clear_failed",
        domain: "integrations",
        component: "grocy-bridge",
        request_id: SYS_REQ,
        message: `Failed to clear shopping list: ${result.message}`,
      });
    }

    return false;
  } catch (err) {
    logger.log("error", {
      event: "grocy.sync.push_failed",
      domain: "integrations",
      component: "grocy-bridge",
      request_id: SYS_REQ,
      message: `Failed to push completion for task ${taskId}: ${err}`,
    });
    return false;
  }
}

/**
 * Fix #10: Push a new task to Grocy when created in Meitheal (bidirectional mode).
 * Only pushes tasks that don't already have a grocy sync confirmation
 * and don't have the "synced from grocy" label (loop prevention).
 */
export async function pushNewTaskToGrocy(
  taskId: string,
  title: string,
  options?: { description?: string | undefined; dueDate?: string | undefined },
): Promise<boolean> {
  const adapter = state.adapter;
  if (!adapter) return false;

  // Only push in bidirectional mode (export-only doesn't make sense for task creation)
  if (state.config.syncMode !== "bidirectional") return false;

  try {
    const client = (await getClient());

    // Check if this task already has a grocy confirmation (was synced FROM grocy)
    const existing = await client.execute({
      sql: "SELECT 1 FROM grocy_sync_confirmations WHERE task_id = ? LIMIT 1",
      args: [taskId],
    });
    if (existing.rows.length > 0) return false; // Already synced — don't duplicate

    const createOpts: { description?: string; dueDate?: string } = {};
    if (options?.description) createOpts.description = options.description;
    if (options?.dueDate) createOpts.dueDate = options.dueDate;
    const result = await adapter.createTask(title, createOpts);

    if (!result.ok) {
      logger.log("error", {
        event: "grocy.sync.create_task_failed",
        domain: "integrations",
        component: "grocy-bridge",
        request_id: SYS_REQ,
        message: `Failed to create task in Grocy: ${result.message}`,
      });
      return false;
    }

    // Record the confirmation so future syncs don't duplicate
    const nowMs = Date.now();
    await client.execute({
      sql: `INSERT INTO grocy_sync_confirmations (confirmation_id, task_id, grocy_entity_type, grocy_entity_id, sync_direction, payload, created_at, updated_at)
            VALUES (?, ?, 'task', ?, 'outbound', ?, ?, ?)`,
      args: [crypto.randomUUID(), taskId, String(result.data.taskId), JSON.stringify({ title }), nowMs, nowMs],
    });

    logger.log("info", {
      event: "grocy.sync.task_created",
      domain: "integrations",
      component: "grocy-bridge",
      request_id: SYS_REQ,
      message: `Created task "${title}" in Grocy (id: ${result.data.taskId})`,
    });
    return true;
  } catch (err) {
    logger.log("error", {
      event: "grocy.sync.create_task_error",
      domain: "integrations",
      component: "grocy-bridge",
      request_id: SYS_REQ,
      message: `Failed to push new task to Grocy: ${err}`,
    });
    return false;
  }
}

// ═══════ Merge Helpers ═══════

let _tasksModule: typeof import("@domains/tasks") | null = null;
async function getTasksModule() {
  if (!_tasksModule) _tasksModule = await import("@domains/tasks");
  return _tasksModule;
}

/** Helper: get persistence client + ensure tables exist. */
async function getClient() {
  const mod = await getTasksModule();
  await mod.ensureSchema();
  const client = mod.getPersistenceClient();
  await ensureGrocySyncTable(client);
  return client;
}

async function mergeGrocyChores(chores: GrocyChore[]): Promise<number> {
  if (chores.length === 0) return 0;
  const mod = await getTasksModule();
  await getClient();
  const entityIds = chores.map((c) => String(c.choreId));
  const existing = await mod.findTasksByExternalSyncIds({
    source: "grocy",
    grocyEntityType: "chore",
    externalIds: entityIds,
  });
  const nowMs = Date.now();
  const mutations: SyncTaskMutation[] = [];

  for (const chore of chores) {
    const taskData = choreToTask(chore);
    const match = existing.get(String(chore.choreId));

    if (match) {
      // Skip if locally modified after last sync
      if (match.taskUpdatedAt > match.syncUpdatedAt) continue;

      mutations.push({
        kind: "update",
        taskId: match.taskId,
        title: taskData.title,
        status: taskData.status,
        dueDate: taskData.dueDate,
        updateDueDate: true,
        description: taskData.description,
        updatedAt: nowMs,
        confirmation: {
          source: "grocy",
          grocyEntityType: "chore",
          externalId: String(chore.choreId),
          payload: JSON.stringify(chore),
        },
      });
    } else {
      mutations.push({
        kind: "create",
        taskId: crypto.randomUUID(),
        idempotencyKey: `grocy-chore-${chore.choreId}`,
        title: taskData.title,
        description: taskData.description ?? "",
        status: taskData.status,
        priority: taskData.priority,
        dueDate: taskData.dueDate,
        labels: taskData.labels,
        areaId: "default",
        taskType: "task",
        createdAt: nowMs,
        confirmation: {
          source: "grocy",
          grocyEntityType: "chore",
          externalId: String(chore.choreId),
          syncDirection: "inbound",
          payload: JSON.stringify(chore),
        },
      });
    }
  }

  const res = await mod.commitSyncMutationChunks(mutations);
  return res.created + res.updated;
}

async function mergeGrocyTasks(
  tasks: GrocyTask[],
  categoryNames?: Map<number, string>,
): Promise<number> {
  if (tasks.length === 0) return 0;
  const mod = await getTasksModule();
  await getClient();
  const entityIds = tasks.map((t) => String(t.taskId));
  const existing = await mod.findTasksByExternalSyncIds({
    source: "grocy",
    grocyEntityType: "task",
    externalIds: entityIds,
  });
  const nowMs = Date.now();
  const mutations: SyncTaskMutation[] = [];

  for (const task of tasks) {
    const categoryName = task.categoryId ? categoryNames?.get(task.categoryId) : undefined;
    const taskData = taskToTask(task, categoryName);
    const match = existing.get(String(task.taskId));

    if (match) {
      // Fix #6: If locally modified, only allow Grocy-side completion to override
      if (match.taskUpdatedAt > match.syncUpdatedAt && !task.done) continue;

      mutations.push({
        kind: "update",
        taskId: match.taskId,
        title: taskData.title,
        status: taskData.status,
        dueDate: taskData.dueDate,
        updateDueDate: true,
        description: taskData.description,
        areaId: taskData.areaId ?? "default",
        updatedAt: nowMs,
        confirmation: {
          source: "grocy",
          grocyEntityType: "task",
          externalId: String(task.taskId),
          payload: JSON.stringify(task),
        },
      });
    } else {
      mutations.push({
        kind: "create",
        taskId: crypto.randomUUID(),
        idempotencyKey: `grocy-task-${task.taskId}`,
        title: taskData.title,
        description: taskData.description ?? "",
        status: taskData.status,
        priority: taskData.priority,
        dueDate: taskData.dueDate,
        labels: taskData.labels,
        areaId: taskData.areaId ?? "default",
        taskType: "task",
        createdAt: nowMs,
        confirmation: {
          source: "grocy",
          grocyEntityType: "task",
          externalId: String(task.taskId),
          syncDirection: "inbound",
          payload: JSON.stringify(task),
        },
      });
    }
  }

  const res = await mod.commitSyncMutationChunks(mutations);
  return res.created + res.updated;
}

/** Fix #2: Shopping list now accepts product name map for human-readable descriptions. */
async function mergeShoppingList(
  items: { id?: number; productId: number; amount: number; note?: string }[],
  productNames?: Map<number, string>,
): Promise<number> {
  const mod = await getTasksModule();
  await getClient();
  const taskData = shoppingListToTask(items, productNames);
  const nowMs = Date.now();
  const existing = await mod.findTasksByExternalSyncIds({
    source: "grocy",
    grocyEntityType: "shopping",
    externalIds: ["list-1"],
  });
  const match = existing.get("list-1");

  const mutation: SyncTaskMutation = match
    ? {
        kind: "update",
        taskId: match.taskId,
        title: taskData.title,
        description: taskData.description,
        replaceDescription: true,
        status: STATUS.PENDING,
        updatedAt: nowMs,
        confirmation: {
          source: "grocy",
          grocyEntityType: "shopping",
          externalId: "list-1",
          payload: JSON.stringify({ itemCount: items.length }),
        },
      }
    : {
        kind: "create",
        taskId: crypto.randomUUID(),
        idempotencyKey: "grocy-shopping-list-1",
        title: taskData.title,
        description: taskData.description,
        status: STATUS.PENDING,
        priority: 3,
        dueDate: null,
        labels: taskData.labels,
        areaId: "default",
        taskType: "task",
        createdAt: nowMs,
        confirmation: {
          source: "grocy",
          grocyEntityType: "shopping",
          externalId: "list-1",
          syncDirection: "inbound",
          payload: JSON.stringify({ itemCount: items.length }),
        },
      };

  const res = await mod.commitSyncMutationChunks([mutation]);
  return res.created + res.updated;
}

/**
 * Fix #3: Archive orphaned tasks — Grocy items deleted since last sync.
 * Only runs when all API calls succeeded (no partial data).
 */
async function cleanStaleTasks(seenEntityKeys: Set<string>): Promise<void> {
  const client = await getClient();
  const nowMs = Date.now();

  const allConfirmations = await client.execute({
    sql: "SELECT confirmation_id, task_id, grocy_entity_type, grocy_entity_id FROM grocy_sync_confirmations",
    args: [],
  });

  for (const row of allConfirmations.rows) {
    const key = `${row.grocy_entity_type}:${row.grocy_entity_id}`;
    const taskId = String(row.task_id);
    const confirmationId = String(row.confirmation_id);
    if (!seenEntityKeys.has(key)) {
      // This entity no longer exists in Grocy — archive the task
      await client.execute({
        sql: `UPDATE tasks SET status = '${STATUS.COMPLETE}', updated_at = ? WHERE id = ? AND status != '${STATUS.COMPLETE}'`,
        args: [nowMs, taskId],
      });
      await client.execute({
        sql: "DELETE FROM grocy_sync_confirmations WHERE confirmation_id = ?",
        args: [confirmationId],
      });
      logger.log("info", {
        event: "grocy.sync.stale_archived",
        domain: "integrations",
        component: "grocy-bridge",
        request_id: SYS_REQ,
        message: `Archived stale task ${row.task_id} (Grocy ${key} no longer exists)`,
      });
    }
  }
}

// ═══════ Table Bootstrap ═══════

async function ensureGrocySyncTable(client: Client): Promise<void> {
  await client.execute({
    sql: `CREATE TABLE IF NOT EXISTS grocy_sync_confirmations (
      confirmation_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      grocy_entity_type TEXT NOT NULL,
      grocy_entity_id TEXT NOT NULL,
      sync_direction TEXT NOT NULL DEFAULT 'inbound',
      payload TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    args: [],
  });
  await client.execute({
    sql: `CREATE INDEX IF NOT EXISTS idx_grocy_sync_entity ON grocy_sync_confirmations(grocy_entity_type, grocy_entity_id)`,
    args: [],
  });
  await client.execute({
    sql: `CREATE INDEX IF NOT EXISTS idx_grocy_sync_task ON grocy_sync_confirmations(task_id)`,
    args: [],
  });
}
