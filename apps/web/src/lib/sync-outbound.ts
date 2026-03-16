/**
 * Outbound Sync Dispatcher
 *
 * Third dispatch channel in the unified event pipeline.
 * Called by dispatchTaskEvent on task.created / task.updated to push
 * changes to active HA Todo and Calendar syncs.
 *
 * Respects:
 *   - `no-sync` label → skip entirely
 *   - `synced from {entity}` label → don't push back to that entity (loop prevention)
 *   - Only pushes if sync direction is "outbound" or "bidirectional"
 *
 * @domain integrations
 * @bounded-context sync-outbound
 */
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability";

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["integrations"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: false,
});

const NO_SYNC_LABEL = "no-sync";
const SYNCED_FROM_PREFIX = "synced from ";

/**
 * Parse labels from task payload.
 * Labels can be a JSON string array or already an array.
 */
function parseLabels(payload: Record<string, unknown>): string[] {
  const raw = payload.labels;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((l): l is string => typeof l === "string");
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((l: unknown): l is string => typeof l === "string") : [];
    } catch { return []; }
  }
  return [];
}

/**
 * Extract which entities this task was synced FROM (to prevent push-back loops).
 */
function getSyncedFromEntities(labels: string[]): string[] {
  return labels
    .filter((l) => l.startsWith(SYNCED_FROM_PREFIX))
    .map((l) => l.slice(SYNCED_FROM_PREFIX.length));
}

/**
 * Push a task mutation to all active outbound sync targets.
 *
 * Called by dispatchTaskEvent — fire-and-forget, non-blocking.
 */
export async function pushToActiveSyncs(
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Only handle creates, updates, and deletes
  if (eventType !== "task.created" && eventType !== "task.updated" && eventType !== "task.deleted") return;

  const labels = parseLabels(payload);

  // Respect no-sync label
  if (labels.includes(NO_SYNC_LABEL)) {
    logger.log("debug", {
      event: "sync.outbound.skipped_no_sync", domain: "integrations",
      component: "sync-outbound", request_id: "system",
      message: `Skipping outbound push for "${payload.title}" — has no-sync label`,
    });
    return;
  }

  // ── Handle task deletion: remove from all synced HA todo lists ──
  if (eventType === "task.deleted") {
    const taskId = String(payload.id ?? "");
    if (!taskId) return;

    try {
      const { removeTaskFromTodoList } = await import("@domains/todo/todo-bridge");
      const removed = await removeTaskFromTodoList(taskId);
      if (removed > 0) {
        logger.log("info", {
          event: "sync.outbound.todo.deleted", domain: "integrations",
          component: "sync-outbound", request_id: "system",
          message: `Removed ${removed} HA todo item(s) for deleted task ${taskId}`,
        });
      }
    } catch (err) {
      logger.log("error", {
        event: "sync.outbound.todo.delete_failed", domain: "integrations",
        component: "sync-outbound", request_id: "system",
        message: `Failed to remove HA todo items for deleted task: ${err}`,
      });
    }
    return; // No further sync needed for deleted tasks
  }

  // Entities this task originated from (loop prevention)
  const syncedFromEntities = getSyncedFromEntities(labels);

  const taskId = String(payload.id ?? "");
  const title = String(payload.title ?? "");
  const status = String(payload.status ?? "pending");
  const dueDate = payload.due_date ? String(payload.due_date) : undefined;
  const description = payload.description ? String(payload.description) : undefined;

  if (!taskId || !title) return;

  // ── Todo Sync: push to active todo entities ──
  try {
    const { getActiveTodoSyncConfigs, pushTaskToTodoList } = await import("@domains/todo/todo-bridge");
    const todoConfigs = getActiveTodoSyncConfigs();

    for (const config of todoConfigs) {
      // Loop prevention: don't push back to the entity this task came from
      if (syncedFromEntities.includes(config.entityId)) {
        logger.log("debug", {
          event: "sync.outbound.todo.loop_prevented", domain: "integrations",
          component: "sync-outbound", request_id: "system",
          message: `Skipping push to ${config.entityId} — task synced from there`,
        });
        continue;
      }

      pushTaskToTodoList(
        taskId, title, status, config.entityId, dueDate, description, labels,
      ).catch((err) => {
        logger.log("error", {
          event: "sync.outbound.todo.failed", domain: "integrations",
          component: "sync-outbound", request_id: "system",
          message: `Failed to push to ${config.entityId}: ${err}`,
        });
      });
    }
  } catch (err) {
    logger.log("error", {
      event: "sync.outbound.todo.import_failed", domain: "integrations",
      component: "sync-outbound", request_id: "system",
      message: `Failed to import todo bridge: ${err}`,
    });
  }

  // ── Calendar Sync: push to active calendar entities (if due_date exists) ──
  if (dueDate) {
    try {
      const { pushTaskToCalendar, getCalendarSyncConfigs } = await import("@domains/calendar/calendar-bridge");
      const calConfigs = getCalendarSyncConfigs();
      // Only push to calendars with export/bidirectional mode AND writeBack enabled
      const hasWriteBack = calConfigs.some((c) => c.writeBack && c.syncMode !== "import");

      if (hasWriteBack) {
        // Build metadata for rich calendar description
        const priority = typeof payload.priority === 'number' ? payload.priority : undefined;
        const ticketNumber = typeof payload.ticket_number === 'number' ? payload.ticket_number : undefined;
        let checklists: Array<{ text: string; done: boolean }> | undefined;
        try {
          const raw = typeof payload.checklists === 'string' ? JSON.parse(payload.checklists) : payload.checklists;
          if (Array.isArray(raw)) checklists = raw;
        } catch { /* ignore */ }

        const meta = {
          status,
          priority,
          labels,
          checklists,
          ticketKey: ticketNumber ? `MTH-${ticketNumber}` : undefined,
        };

        // pushTaskToCalendar already handles per-entity mode checks and dedup internally
        pushTaskToCalendar(taskId, title, dueDate, description, undefined, meta).catch((err) => {
          logger.log("error", {
            event: "sync.outbound.calendar.failed", domain: "integrations",
            component: "sync-outbound", request_id: "system",
            message: `Failed to push to calendar: ${err}`,
          });
        });
      }
    } catch (err) {
      logger.log("error", {
        event: "sync.outbound.calendar.import_failed", domain: "integrations",
        component: "sync-outbound", request_id: "system",
        message: `Failed to import calendar bridge: ${err}`,
      });
    }
  }

  // ── Grocy Sync: push completions to Grocy when task marked done ──
  // NOTE: Unlike Todo/Calendar, Grocy completions SHOULD push back even for
  // tasks that originated from Grocy. The inbound creates the task; the outbound
  // completes it. That's the bidirectional contract — no loop because Grocy
  // doesn't re-create completed chores/tasks.
  if (status === "complete") {
    try {
      const { getActiveGrocySyncConfig, pushCompletionToGrocy } = await import("@domains/grocy");
      const grocyConfig = getActiveGrocySyncConfig();

      if (grocyConfig && (grocyConfig.syncMode === "export" || grocyConfig.syncMode === "bidirectional")) {
        pushCompletionToGrocy(taskId).catch((err) => {
          logger.log("error", {
            event: "sync.outbound.grocy.failed", domain: "integrations",
            component: "sync-outbound", request_id: "system",
            message: `Failed to push completion to Grocy: ${err}`,
          });
        });
      }
    } catch (err) {
      logger.log("error", {
        event: "sync.outbound.grocy.import_failed", domain: "integrations",
        component: "sync-outbound", request_id: "system",
        message: `Failed to import grocy bridge: ${err}`,
      });
    }
  }

  // ── Grocy Sync: push new task creation to Grocy (bidirectional) ──
  // Only fires on task.created and only if the task didn't originate from Grocy
  if (eventType === "task.created" && !syncedFromEntities.includes("grocy")) {
    try {
      const { getActiveGrocySyncConfig, pushNewTaskToGrocy } = await import("@domains/grocy");
      const grocyConfig = getActiveGrocySyncConfig();

      if (grocyConfig && grocyConfig.syncMode === "bidirectional") {
        pushNewTaskToGrocy(taskId, title, { description, dueDate }).catch((err) => {
          logger.log("error", {
            event: "sync.outbound.grocy.create_failed", domain: "integrations",
            component: "sync-outbound", request_id: "system",
            message: `Failed to push new task to Grocy: ${err}`,
          });
        });
      }
    } catch (err) {
      logger.log("error", {
        event: "sync.outbound.grocy.create_import_failed", domain: "integrations",
        component: "sync-outbound", request_id: "system",
        message: `Failed to import grocy bridge for task creation: ${err}`,
      });
    }
  }
}
