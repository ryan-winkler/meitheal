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
import type { SyncTaskMutation } from "@domains/tasks"
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
  fallbackTimer: ReturnType<typeof setTimeout> | null;
  lastSyncAt: number | null;
  itemCount: number;
  inboundSequence: number
  latestInboundSnapshot: number
}

const activeSyncs: Map<string, TodoSyncState> = new Map();
const inboundMerges = new Map<string, Promise<void>>()

function enqueueInboundSnapshot(state: TodoSyncState, sequence: number, items: HATodoItem[]): Promise<boolean> {
  const { entityId } = state.config
  const current = () => activeSyncs.get(entityId) === state && sequence >= state.latestInboundSnapshot
  if (!current()) return Promise.resolve(false)
  state.latestInboundSnapshot = sequence

  // The queue is per entity, so replacing a subscription cannot overlap an
  // already-running write from the previous subscription.
  const merge = (inboundMerges.get(entityId) ?? Promise.resolve()).then(async () => {
    if (!current()) return false
    if (items.length) await mergeHATodoItems(entityId, items)
    if (!current()) return false
    state.itemCount = items.length
    state.lastSyncAt = Date.now()
    return true
  })
  const settled = merge.then(() => {}, () => {})
  inboundMerges.set(entityId, settled)
  void settled.then(() => {
    if (inboundMerges.get(entityId) === settled) inboundMerges.delete(entityId)
  })
  return merge
}

// Cached persistence refs — avoids repeated dynamic imports in hot sync path
let _storeModule: typeof import("@domains/tasks") | null = null;
let _todoTableEnsured = false;

async function getStoreModule() {
  if (!_storeModule) _storeModule = await import("@domains/tasks");
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
 * Deduplicates initial hydration by awaiting the first `todo/item/subscribe` snapshot
 * (falling back to `syncTodoFromHA` only if no WS snapshot arrives within 3,000 ms).
 */
export function startTodoSync(configs: TodoSyncConfig | TodoSyncConfig[]): Promise<void> {
  const configList = Array.isArray(configs) ? configs : [configs];
  const initialHydrations: Promise<void>[] = [];

  for (const config of configList) {
    // Stop existing sync for this entity if active
    const existing = activeSyncs.get(config.entityId);
    if (existing?.fallbackTimer) clearTimeout(existing.fallbackTimer);
    if (existing?.unsub) existing.unsub();

    if (!config.syncEnabled) {
      activeSyncs.delete(config.entityId);
      continue;
    }

    const state: TodoSyncState = {
      config,
      unsub: null,
      fallbackTimer: null,
      lastSyncAt: null,
      itemCount: 0,
      inboundSequence: 0,
      latestInboundSnapshot: 0,
    };
    activeSyncs.set(config.entityId, state);

    // Subscribe to real-time updates via WebSocket (delivers initial snapshot without duplicate get_items)
    if (config.syncDirection !== "outbound") {
      const hydrationPromise = new Promise<void>((resolveInitial) => {
        let initialSettled = false;
        let snapshotReceived = false;
        const finishInitial = () => {
          if (!initialSettled) {
            initialSettled = true;
            resolveInitial();
          }
        };

        state.fallbackTimer = setTimeout(() => {
          state.fallbackTimer = null;
          if (!snapshotReceived && activeSyncs.get(config.entityId) === state) {
            snapshotReceived = true;
            syncTodoFromHA(config.entityId).catch((err) => {
              logger.log("error", {
                event: "todo.sync.initial_failed", domain: "todo", component: "todo-bridge",
                request_id: SYS_REQ, message: `Initial todo sync failed for ${config.entityId}: ${err}`,
              });
            }).finally(finishInitial);
          } else {
            finishInitial();
          }
        }, 3_000);
        state.fallbackTimer.unref?.();

        subscribeTodoItems(config.entityId, (items: TodoItem[]) => {
          const isFirst = !snapshotReceived;
          snapshotReceived = true;
          if (state.fallbackTimer) {
            clearTimeout(state.fallbackTimer);
            state.fallbackTimer = null;
          }
          logger.log("info", {
            event: "todo.sync.ws_update", domain: "todo", component: "todo-bridge",
            request_id: SYS_REQ,
            message: `Real-time update: ${items.length} items from ${config.entityId}`,
          });
          // The merge logs failures. Keep a callback rejection out of the WS client.
          const merged = enqueueInboundSnapshot(state, ++state.inboundSequence, items as HATodoItem[]).catch(() => false);
          if (isFirst) void merged.finally(finishInitial);
        }).then((unsub: () => void) => {
          if (activeSyncs.get(config.entityId) === state) {
            state.unsub = unsub;
          } else {
            unsub();
            finishInitial();
          }
        }).catch((err: unknown) => {
          logger.log("error", {
            event: "todo.sync.subscribe_failed", domain: "todo", component: "todo-bridge",
            request_id: SYS_REQ, message: `Failed to subscribe to ${config.entityId}: ${err}`,
          });
          if (!snapshotReceived && activeSyncs.get(config.entityId) === state) {
            snapshotReceived = true;
            if (state.fallbackTimer) {
              clearTimeout(state.fallbackTimer);
              state.fallbackTimer = null;
            }
            syncTodoFromHA(config.entityId).catch((syncErr) => {
              logger.log("error", {
                event: "todo.sync.initial_failed", domain: "todo", component: "todo-bridge",
                request_id: SYS_REQ, message: `Initial todo sync failed for ${config.entityId}: ${syncErr}`,
              });
            }).finally(finishInitial);
          } else {
            finishInitial();
          }
        });
      });
      initialHydrations.push(hydrationPromise);
    }

    logger.log("info", {
      event: "todo.sync.started", domain: "todo", component: "todo-bridge",
      request_id: SYS_REQ,
      message: `Todo sync started for ${config.entityId} (direction: ${config.syncDirection})`,
    });
  }

  return Promise.allSettled(initialHydrations).then(() => {});
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
      const sequence = ++state.inboundSequence
      const items = await getTodoItems(config.entityId);
      if (items.length === 0) {
        logger.log("debug", {
          event: "todo.sync.from_ha", domain: "todo", component: "todo-bridge",
          request_id: SYS_REQ, message: `No items to sync from ${config.entityId}`,
        });
        continue;
      }
      if (await enqueueInboundSnapshot(state, sequence, items as HATodoItem[])) {
        totals.synced += items.length
      }
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
    const mod = await getStoreModule();
    const client = await getClient();

    let created = 0;
    let updated = 0;
    let skipped = 0;

    // Backfill: assign ticket_number to any existing tasks missing one
    const orphans = await client.execute(
      "SELECT id FROM tasks WHERE ticket_number IS NULL ORDER BY created_at ASC",
    );
    if (orphans.rows.length > 0) {
      for (const row of orphans.rows) {
        await client.execute({
          sql: `UPDATE tasks SET ticket_number = (SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM tasks)
                WHERE id = ? AND ticket_number IS NULL`,
          args: [row.id as string],
        });
      }
      logger.log("info", {
        event: "todo.sync.backfill_tickets", domain: "todo", component: "todo-bridge",
        request_id: SYS_REQ,
        message: `Backfilled ticket_number for ${orphans.rows.length} tasks`,
      });
    }

    const candidates: Array<{
      item: HATodoItem;
      uid: string;
      haStatus: string;
      meithealStatus: MeithealStatus;
      cleanTitle: string;
    }> = [];

    for (const item of items) {
      if (item.description && /Added from Meitheal$/i.test(item.description)) {
        skipped++;
        continue;
      }
      const uid = item.uid ?? `ha-todo-${entityId}-${item.summary}`;
      const haStatus = item.status ?? "needs_action";
      const meithealStatus = haStatusToMeitheal(haStatus);
      const cleanTitle = sanitizeTodoTitle(item.summary);
      candidates.push({ item, uid, haStatus, meithealStatus, cleanTitle });
    }

    if (candidates.length > 0) {
      const existingMap = await mod.findTasksByExternalSyncIds({
        source: "ha_todo",
        entityId,
        externalIds: candidates.map((c) => c.uid),
      });

      const unmatchedTitles = [
        ...new Set(
          candidates
            .filter((c) => !existingMap.has(c.uid) && c.cleanTitle.length > 0)
            .map((c) => c.cleanTitle),
        ),
      ];
      const openTitleToTaskId = new Map<string, string>();
      for (let offset = 0; offset < unmatchedTitles.length; offset += 200) {
        const titleChunk = unmatchedTitles.slice(offset, offset + 200);
        const placeholders = titleChunk.map(() => "?").join(", ");
        const titleMatches = await client.execute({
          sql: `SELECT id, title FROM tasks WHERE status != 'complete' AND title IN (${placeholders}) ORDER BY rowid ASC`,
          args: titleChunk,
        });
        for (const row of titleMatches.rows) {
          const titleKey = String(row.title);
          if (!openTitleToTaskId.has(titleKey)) {
            openTitleToTaskId.set(titleKey, String(row.id));
          }
        }
      }

      const mutations: SyncTaskMutation[] = [];
      const syncLabel = `synced from ${entityId}`;
      const nowMs = Date.now();

      for (const { item, uid, haStatus, meithealStatus, cleanTitle } of candidates) {
        const payload = JSON.stringify({ summary: item.summary, status: item.status, due: item.due });
        const existingMatch = existingMap.get(uid);

        if (existingMatch) {
          mutations.push({
            kind: "update",
            taskId: existingMatch.taskId,
            title: cleanTitle,
            status: meithealStatus,
            openEcho: haStatus === "needs_action",
            dueDate: item.due ?? null,
            updateDueDate: true,
            description: stripMeithealAttribution(item.description),
            updatedAt: nowMs,
            confirmation: {
              source: "ha_todo",
              confirmationId: existingMatch.confirmationId,
              entityId,
              externalId: uid,
              payload,
              requireUnmodifiedSinceSync: true,
            },
          });
          continue;
        }

        const matchedTaskId = cleanTitle ? openTitleToTaskId.get(cleanTitle) : undefined;
        if (matchedTaskId) {
          mutations.push({
            kind: "link",
            taskId: matchedTaskId,
            createdAt: nowMs,
            confirmation: {
              source: "ha_todo",
              entityId,
              externalId: uid,
              syncDirection: "inbound",
              payload,
            },
          });
          skipped++;
          continue;
        }

        const taskId = crypto.randomUUID();
        if (cleanTitle) {
          openTitleToTaskId.set(cleanTitle, taskId);
        }
        mutations.push({
          kind: "create",
          taskId,
          idempotencyKey: `todo-sync-${uid}`,
          title: cleanTitle,
          description: stripMeithealAttribution(item.description) ?? "",
          status: meithealStatus,
          priority: 3,
          dueDate: item.due ?? null,
          labels: [syncLabel],
          areaId: "default",
          taskType: "task",
          taskKind: "standard_action",
          createdAt: nowMs,
          confirmation: {
            source: "ha_todo",
            entityId,
            externalId: uid,
            syncDirection: "inbound",
            payload,
          },
        });
      }

      const commitResult = await mod.commitSyncMutationChunks(mutations);
      created += commitResult.created;
      updated += commitResult.updated;
      skipped += commitResult.skipped;
      for (const itemErr of commitResult.errors) {
        logger.log("error", {
          event: "todo.sync.item_error", domain: "todo", component: "todo-bridge",
          request_id: SYS_REQ,
          message: `Failed to merge todo item #${itemErr.index} from ${entityId}: ${itemErr.message}`,
        });
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
    throw err
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
    if (state?.fallbackTimer) clearTimeout(state.fallbackTimer);
    if (state?.unsub) state.unsub();
    activeSyncs.delete(entityId);
  } else {
    for (const [, state] of activeSyncs) {
      if (state.fallbackTimer) clearTimeout(state.fallbackTimer);
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
