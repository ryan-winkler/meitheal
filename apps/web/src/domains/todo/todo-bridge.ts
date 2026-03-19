/**
 * Todo Bridge — Bidirectional Sync with HA Todo Entities
 *
 * Syncs Meitheal tasks with HA todo list entities:
 *   - HA todo → Meitheal: subscription-based real-time sync
 *   - Meitheal → HA: task create/update pushes to HA todo entity
 *
 * Mirrors the calendar-bridge.ts pattern but uses WebSocket subscriptions
 * instead of polling for real-time updates.
 *
 * @domain todo
 * @bounded-context integration
 */
import {
  getTodoItems,
  addTodoItem,
  updateTodoItem,
  removeTodoItem,
  subscribeTodoItems,
  type TodoItem,
} from "../ha";
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability";
import {
  haStatusToMeitheal,
  meithealStatusToHA,
  buildDueServiceData,
  type HATodoItem,
  type MeithealStatus,
} from "./todo-status-mapper";

const logger = createLogger({
  service: "meitheal-web", env: process.env.NODE_ENV ?? "development",
  minLevel: "info", enabledCategories: ["ha", "todo"],
  redactPatterns: defaultRedactionPatterns, auditEnabled: false,
});
const SYS_REQ = "ha-system";
const NO_SYNC_LABEL = "no-sync";

import { sanitizeTodoTitle } from "@lib/cleanup-corrupt-titles";

/** Strip outbound attribution text so it doesn't show in Meitheal's own UI. */
function stripMeithealAttribution(desc: string | null | undefined): string | null {
  if (!desc) return null;
  return desc.replace(/\n?\n?Added from Meitheal$/i, "").trim() || null;
}

export interface TodoSyncConfig {
  entityId: string;
  syncEnabled: boolean;
  writeBack: boolean;
  syncDirection: "inbound" | "outbound" | "bidirectional";
}

interface TodoSyncState {
  config: TodoSyncConfig;
  unsub: (() => void) | null;
  lastSyncAt: number | null;
  itemCount: number;
}

const activeSyncs: Map<string, TodoSyncState> = new Map();

// Cached persistence refs — avoids repeated dynamic imports in hot sync path
let _storeModule: typeof import("@domains/tasks/persistence/store") | null = null;
let _todoTableEnsured = false;

async function getStoreModule() {
  if (!_storeModule) _storeModule = await import("@domains/tasks/persistence/store");
  return _storeModule;
}

async function getClient() {
  const mod = await getStoreModule();
  await mod.ensureSchema();
  const client = mod.getPersistenceClient();
  if (!_todoTableEnsured) {
    await client.execute({
      sql: `CREATE TABLE IF NOT EXISTS todo_sync_confirmations (
        confirmation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        ha_entity_id TEXT NOT NULL,
        ha_todo_uid TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'ha.todo_sync',
        sync_direction TEXT NOT NULL DEFAULT 'inbound',
        payload TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      args: [],
    });
    await client.execute({
      sql: `CREATE INDEX IF NOT EXISTS idx_todo_sync_entity_uid ON todo_sync_confirmations(ha_entity_id, ha_todo_uid)`,
      args: [],
    });
    await client.execute({
      sql: `CREATE INDEX IF NOT EXISTS idx_todo_sync_task ON todo_sync_confirmations(task_id)`,
      args: [],
    });
    _todoTableEnsured = true;
  }
  return client;
}

/**
 * Initialize todo sync with one or more HA todo entities.
 */
export function startTodoSync(configs: TodoSyncConfig | TodoSyncConfig[]): void {
  const configList = Array.isArray(configs) ? configs : [configs];

  for (const config of configList) {
    // Stop existing sync for this entity if active
    const existing = activeSyncs.get(config.entityId);
    if (existing?.unsub) existing.unsub();

    if (!config.syncEnabled) {
      activeSyncs.delete(config.entityId);
      continue;
    }

    const state: TodoSyncState = {
      config,
      unsub: null,
      lastSyncAt: null,
      itemCount: 0,
    };
    activeSyncs.set(config.entityId, state);

    // Subscribe to real-time updates via WebSocket
    if (config.syncDirection !== "outbound") {
      subscribeTodoItems(config.entityId, async (items: TodoItem[]) => {
        logger.log("info", {
          event: "todo.sync.ws_update", domain: "todo", component: "todo-bridge",
          request_id: SYS_REQ,
          message: `Real-time update: ${items.length} items from ${config.entityId}`,
        });
        state.itemCount = items.length;
        await mergeHATodoItems(config.entityId, items as HATodoItem[]);
      }).then((unsub: () => void) => {
        state.unsub = unsub;
      }).catch((err: unknown) => {
        logger.log("error", {
          event: "todo.sync.subscribe_failed", domain: "todo", component: "todo-bridge",
          request_id: SYS_REQ, message: `Failed to subscribe to ${config.entityId}: ${err}`,
        });
      });
    }

    // Initial full sync
    syncTodoFromHA(config.entityId).catch((err) => {
      logger.log("error", {
        event: "todo.sync.initial_failed", domain: "todo", component: "todo-bridge",
        request_id: SYS_REQ, message: `Initial todo sync failed for ${config.entityId}: ${err}`,
      });
    });

    logger.log("info", {
      event: "todo.sync.started", domain: "todo", component: "todo-bridge",
      request_id: SYS_REQ,
      message: `Todo sync started for ${config.entityId} (direction: ${config.syncDirection})`,
    });
  }
}

/**
 * Sync items FROM a specific HA todo entity TO Meitheal tasks table.
 */
export async function syncTodoFromHA(entityId?: string): Promise<{ synced: number; errors: number }> {
  const totals = { synced: 0, errors: 0 };
  const targets = entityId
    ? [activeSyncs.get(entityId)].filter(Boolean) as TodoSyncState[]
    : Array.from(activeSyncs.values()).filter((s) => s.config.syncDirection !== "outbound");

  for (const state of targets) {
    const { config } = state;

    try {
      const items = await getTodoItems(config.entityId);
      if (items.length === 0) {
        logger.log("debug", {
          event: "todo.sync.from_ha", domain: "todo", component: "todo-bridge",
          request_id: SYS_REQ, message: `No items to sync from ${config.entityId}`,
        });
        continue;
      }
      totals.synced += items.length;

      await mergeHATodoItems(config.entityId, items as HATodoItem[]);
      state.lastSyncAt = Date.now();
      state.itemCount = items.length;
    } catch (err) {
      totals.errors++;
      logger.log("error", {
        event: "todo.sync.from_ha.failed", domain: "todo", component: "todo-bridge",
        request_id: SYS_REQ, message: `Failed to sync from ${config.entityId}: ${err}`,
      });
    }
  }
  return totals;
}

/**
 * Merge HA todo items into Meitheal tasks table with deduplication.
 */
async function mergeHATodoItems(entityId: string, items: HATodoItem[]): Promise<void> {
  try {
    const client = await getClient();

    let created = 0;
    let updated = 0;
    let skipped = 0;

    // Backfill: assign ticket_number to any existing tasks missing one
    // (e.g. synced tasks created before ticket_number was added to this path)
    const orphans = await client.execute(
      "SELECT id FROM tasks WHERE ticket_number IS NULL ORDER BY created_at ASC",
    );
    if (orphans.rows.length > 0) {
      const baseResult = await client.execute(
        "SELECT COALESCE(MAX(ticket_number), 0) AS max_num FROM tasks",
      );
      let nextNum = Number((baseResult.rows[0] as Record<string, unknown>)?.max_num ?? 0) + 1;
      for (const row of orphans.rows) {
        await client.execute({
          sql: "UPDATE tasks SET ticket_number = ? WHERE id = ?",
          args: [nextNum, row.id as string],
        });
        nextNum++;
      }
      logger.log("info", {
        event: "todo.sync.backfill_tickets", domain: "todo", component: "todo-bridge",
        request_id: SYS_REQ,
        message: `Backfilled ticket_number for ${orphans.rows.length} tasks`,
      });
    }

    for (const item of items) {
      const uid = item.uid ?? `ha-todo-${entityId}-${item.summary}`;
      const meithealStatus = haStatusToMeitheal(item.status ?? "needs_action");

      // ── Loop prevention: skip items that Meitheal pushed outbound ──
      // If we see our own attribution text, this item came from us via pushTaskToTodoList.
      // Re-importing it would create a duplicate, closing the sync loop.
      if (item.description && /Added from Meitheal$/i.test(item.description)) {
        skipped++;
        continue;
      }

      // Sanitize the title upfront to strip any recursive MTH-NN prefixes
      const cleanTitle = sanitizeTodoTitle(item.summary);

      // Check if we already track this todo item (primary key: entity + uid)
      const existing = await client.execute({
        sql: "SELECT task_id FROM todo_sync_confirmations WHERE ha_entity_id = ? AND ha_todo_uid = ?",
        args: [entityId, uid],
      });

      // Fallback dedup: if UID lookup fails, check if a task with this title already exists.
      // This catches items that were pushed outbound (different UID) coming back in.
      if (existing.rows.length === 0 && cleanTitle) {
        const titleMatch = await client.execute({
          sql: "SELECT id FROM tasks WHERE title = ? AND status != 'complete' LIMIT 1",
          args: [cleanTitle],
        });
        if (titleMatch.rows.length > 0) {
          // Found existing task by title — link it and skip creation
          const matchedTaskId = titleMatch.rows[0]!.id as string;
          const nowMs = Date.now();
          await client.execute({
            sql: `INSERT OR IGNORE INTO todo_sync_confirmations (
              confirmation_id, task_id, request_id, ha_entity_id, ha_todo_uid,
              source, sync_direction, payload, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'ha.todo_sync', 'inbound', ?, ?, ?)`,
            args: [
              crypto.randomUUID(), matchedTaskId, crypto.randomUUID(),
              entityId, uid,
              JSON.stringify({ summary: item.summary, status: item.status, due: item.due }),
              nowMs, nowMs,
            ],
          });
          skipped++;
          continue;
        }
      }

      if (existing.rows.length > 0) {
        // Non-destructive update: only sync from HA if task hasn't been
        // locally modified since last sync (preserves user edits)
        const taskId = existing.rows[0]!.task_id as string;
        const nowMs = Date.now();

        // Check if user edited the task locally since last sync
        const taskRow = await client.execute({
          sql: "SELECT updated_at FROM tasks WHERE id = ?",
          args: [taskId],
        });
        const syncRow = await client.execute({
          sql: "SELECT updated_at FROM todo_sync_confirmations WHERE ha_entity_id = ? AND ha_todo_uid = ?",
          args: [entityId, uid],
        });

        const taskUpdatedAt = (taskRow.rows[0]?.updated_at as number) ?? 0;
        const lastSyncAt = (syncRow.rows[0]?.updated_at as number) ?? 0;

        if (taskUpdatedAt > lastSyncAt) {
          // Task was locally modified — skip HA overwrite to preserve user edits
          skipped++;
          continue;
        }

        await client.execute({
          sql: `UPDATE tasks SET
            title = ?,
            status = ?,
            due_date = ?,
            description = COALESCE(?, description),
            updated_at = ?
          WHERE id = ?`,
          args: [
            cleanTitle,
            meithealStatus,
            item.due ?? null,
            stripMeithealAttribution(item.description),
            nowMs,
            taskId,
          ],
        });

        // Update sync confirmation timestamp
        await client.execute({
          sql: "UPDATE todo_sync_confirmations SET payload = ?, updated_at = ? WHERE ha_entity_id = ? AND ha_todo_uid = ?",
          args: [
            JSON.stringify({ summary: item.summary, status: item.status, due: item.due }),
            nowMs,
            entityId,
            uid,
          ],
        });

        updated++;
      } else {
        // Create new task from todo item
        const taskId = crypto.randomUUID();
        const reqId = crypto.randomUUID();
        const nowMs = Date.now();

        const syncLabel = `synced from ${entityId}`;

        // Assign next sequential ticket_number for clean MTH-N display key
        const nextNumResult = await client.execute(
          "SELECT COALESCE(MAX(ticket_number), 0) + 1 AS next_num FROM tasks",
        );
        const ticketNumber = Number(
          (nextNumResult.rows[0] as Record<string, unknown>)?.next_num ?? 1,
        );

        await client.execute({
          sql: `INSERT INTO tasks (id, title, description, status, priority, due_date,
                  labels, framework_payload, calendar_sync_state, area_id,
                  custom_fields, task_type, task_kind, ticket_number, idempotency_key, request_id,
                  created_at, updated_at)
                VALUES (?, ?, ?, ?, 3, ?, ?, '{}', 'synced', 'default',
                  '{}', 'task', 'standard_action', ?, ?, ?, ?, ?)`,
          args: [
            taskId,
            cleanTitle,
            stripMeithealAttribution(item.description) ?? "",
            meithealStatus,
            item.due ?? null,
            JSON.stringify([syncLabel]),
            ticketNumber,
            `todo-sync-${uid}`,
            reqId,
            nowMs,
            nowMs,
          ],
        });

        // Record sync confirmation for deduplication
        await client.execute({
          sql: `INSERT INTO todo_sync_confirmations (
            confirmation_id, task_id, request_id, ha_entity_id, ha_todo_uid,
            source, sync_direction, payload, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'ha.todo_sync', 'inbound', ?, ?, ?)`,
          args: [
            crypto.randomUUID(),
            taskId,
            reqId,
            entityId,
            uid,
            JSON.stringify({ summary: item.summary, status: item.status, due: item.due }),
            nowMs,
            nowMs,
          ],
        });

        created++;
      }
    }

    logger.log("info", {
      event: "todo.sync.merge_complete", domain: "todo", component: "todo-bridge",
      request_id: SYS_REQ,
      message: `Todo sync: ${created} created, ${updated} updated, ${skipped} skipped from ${items.length} items`,
      metadata: { entity_id: entityId, item_count: items.length, created, updated, skipped },
    });
  } catch (err) {
    logger.log("error", {
      event: "todo.sync.merge_failed", domain: "todo", component: "todo-bridge",
      request_id: SYS_REQ, message: `Failed to merge todo items from ${entityId}: ${err}`,
    });
  }
}

/**
 * Push a Meitheal task TO an HA todo entity.
 */
export async function pushTaskToTodoList(
  taskId: string,
  title: string,
  status: string,
  entityId: string,
  dueDate?: string | null,
  description?: string,
  labels?: string[],
): Promise<boolean> {
  // Respect 'no-sync' label — user opted this task out of sync
  if (labels?.includes(NO_SYNC_LABEL)) {
    logger.log("debug", {
      event: "todo.sync.push_skipped", domain: "todo", component: "todo-bridge",
      request_id: SYS_REQ, message: `Skipped push for "${title}" — has '${NO_SYNC_LABEL}' label`,
    });
    return false;
  }

  const syncState = activeSyncs.get(entityId);
  if (!syncState || syncState.config.syncDirection === "inbound") {
    return false;
  }

  try {
    const client = await getClient();

    // Check if this task already has a sync confirmation (outbound already pushed)
    const existing = await client.execute({
      sql: "SELECT ha_todo_uid, payload FROM todo_sync_confirmations WHERE task_id = ? AND ha_entity_id = ?",
      args: [taskId, entityId],
    });

    if (existing.rows.length > 0) {
      // Update existing HA todo item
      const uid = existing.rows[0]!.ha_todo_uid as string;
      const haStatus = meithealStatusToHA(status as MeithealStatus | string);
      const dueData = buildDueServiceData(dueDate);

      // Use the stored summary (original title) as the item identifier for HA's
      // todo.update_item service, which identifies items by summary text.
      let itemIdentifier = title; // fallback to current title
      const rawPayload = existing.rows[0]!.payload as string | null;
      if (rawPayload) {
        try {
          const parsed = JSON.parse(rawPayload) as { summary?: string };
          if (parsed.summary) itemIdentifier = parsed.summary;
        } catch { /* use current title */ }
      }

      const descWithAttribution = [description, "Added from Meitheal"].filter(Boolean).join("\n\n");
      const success = await updateTodoItem(entityId, itemIdentifier, {
        summary: title,
        status: haStatus,
        description: descWithAttribution,
        ...dueData,
      });

      if (success) {
        await client.execute({
          sql: "UPDATE todo_sync_confirmations SET payload = ?, updated_at = ? WHERE task_id = ? AND ha_entity_id = ?",
          args: [
            JSON.stringify({ summary: title, status: haStatus }),
            Date.now(),
            taskId,
            entityId,
          ],
        });

        logger.log("info", {
          event: "todo.sync.pushed_to_ha", domain: "todo", component: "todo-bridge",
          request_id: SYS_REQ,
          message: `Updated task "${title}" in HA todo ${entityId}`,
          metadata: { task_id: taskId },
        });
      }

      return success;
    } else {
      // Create new HA todo item
      const descWithAttribution = [description, "Added from Meitheal"].filter(Boolean).join("\n\n");
      const success = await addTodoItem(entityId, {
        summary: title,
        due: dueDate ?? undefined,
        description: descWithAttribution,
      });

      if (success) {
        const nowMs = Date.now();
        const outboundUid = `meitheal-${taskId}`;

        await client.execute({
          sql: `INSERT INTO todo_sync_confirmations (
            confirmation_id, task_id, request_id, ha_entity_id, ha_todo_uid,
            source, sync_direction, payload, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'meitheal.todo_push', 'outbound', ?, ?, ?)`,
          args: [
            crypto.randomUUID(),
            taskId,
            crypto.randomUUID(),
            entityId,
            outboundUid,
            JSON.stringify({ summary: title }),
            nowMs,
            nowMs,
          ],
        });

        logger.log("info", {
          event: "todo.sync.pushed_to_ha", domain: "todo", component: "todo-bridge",
          request_id: SYS_REQ,
          message: `Pushed task "${title}" to HA todo ${entityId}`,
          metadata: { task_id: taskId },
        });
      }

      return success;
    }
  } catch (err) {
    logger.log("error", {
      event: "todo.sync.push_failed", domain: "todo", component: "todo-bridge",
      request_id: SYS_REQ, message: `Failed to push task to ${entityId}: ${err}`,
      metadata: { task_id: taskId },
    });
    return false;
  }
}

/**
 * Remove a Meitheal task from all synced HA todo lists.
 *
 * Looks up `todo_sync_confirmations` for the task_id, calls
 * `removeTodoItem()` for each linked HA entity, and deletes
 * the confirmation rows.
 *
 * Called by:
 *   - `DELETE /api/tasks/[id]` (direct cleanup)
 *   - `sync-outbound.ts` on `task.deleted` event
 *
 * @returns Number of HA todo items removed
 */
export async function removeTaskFromTodoList(taskId: string): Promise<number> {
  let removed = 0;
  try {
    const client = await getClient();

    // Find all sync confirmations for this task
    const rows = await client.execute({
      sql: "SELECT ha_entity_id, ha_todo_uid, payload FROM todo_sync_confirmations WHERE task_id = ?",
      args: [taskId],
    });

    if (rows.rows.length === 0) {
      logger.log("debug", {
        event: "todo.sync.remove_skipped", domain: "todo", component: "todo-bridge",
        request_id: SYS_REQ,
        message: `No sync confirmations found for task ${taskId} — nothing to remove`,
      });
      return 0;
    }

    for (const row of rows.rows) {
      const entityId = row.ha_entity_id as string;
      const rawPayload = row.payload as string | null;

      // HA's todo.remove_item identifies items by summary text
      let summary: string | null = null;
      if (rawPayload) {
        try {
          const parsed = JSON.parse(rawPayload) as { summary?: string };
          if (parsed.summary) summary = parsed.summary;
        } catch { /* fall through */ }
      }

      if (!summary) {
        logger.log("warn", {
          event: "todo.sync.remove_no_summary", domain: "todo", component: "todo-bridge",
          request_id: SYS_REQ,
          message: `Sync confirmation for task ${taskId} in ${entityId} has no stored summary — skipping`,
        });
        continue;
      }

      const success = await removeTodoItem(entityId, [summary]);
      if (success) {
        removed++;
        logger.log("info", {
          event: "todo.sync.removed_from_ha", domain: "todo", component: "todo-bridge",
          request_id: SYS_REQ,
          message: `Removed "${summary}" from HA todo ${entityId}`,
          metadata: { task_id: taskId },
        });
      } else {
        logger.log("warn", {
          event: "todo.sync.remove_failed", domain: "todo", component: "todo-bridge",
          request_id: SYS_REQ,
          message: `Failed to remove "${summary}" from HA todo ${entityId}`,
          metadata: { task_id: taskId },
        });
      }
    }

    // Clean up all sync confirmation rows for this task
    await client.execute({
      sql: "DELETE FROM todo_sync_confirmations WHERE task_id = ?",
      args: [taskId],
    });

    logger.log("info", {
      event: "todo.sync.confirmations_cleaned", domain: "todo", component: "todo-bridge",
      request_id: SYS_REQ,
      message: `Cleaned ${rows.rows.length} sync confirmation(s) for task ${taskId}`,
    });
  } catch (err) {
    logger.log("error", {
      event: "todo.sync.remove_error", domain: "todo", component: "todo-bridge",
      request_id: SYS_REQ, message: `Error removing task ${taskId} from HA todo lists: ${err}`,
    });
  }

  return removed;
}

/**
 * Stop all or specific todo syncs and clean up.
 */
export function stopTodoSync(entityId?: string): void {
  if (entityId) {
    const state = activeSyncs.get(entityId);
    if (state?.unsub) state.unsub();
    activeSyncs.delete(entityId);
  } else {
    for (const [, state] of activeSyncs) {
      if (state.unsub) state.unsub();
    }
    activeSyncs.clear();
  }
}

/**
 * Get current sync status for all or specific todo entities.
 */
export function getTodoSyncStatus(entityId?: string) {
  if (entityId) {
    const state = activeSyncs.get(entityId);
    if (!state) return null;
    return {
      entityId: state.config.entityId,
      active: true,
      direction: state.config.syncDirection,
      writeBack: state.config.writeBack,
      lastSyncAt: state.lastSyncAt,
      itemCount: state.itemCount,
    };
  }

  return Array.from(activeSyncs.entries()).map(([id, state]) => ({
    entityId: id,
    active: true,
    direction: state.config.syncDirection,
    writeBack: state.config.writeBack,
    lastSyncAt: state.lastSyncAt,
    itemCount: state.itemCount,
  }));
}

/**
 * Get active todo sync configs for outbound dispatching.
 * Returns only syncs that support outbound/bidirectional push.
 */
export function getActiveTodoSyncConfigs(): TodoSyncConfig[] {
  return Array.from(activeSyncs.values())
    .filter((s) => s.config.syncDirection !== "inbound")
    .map((s) => s.config);
}
