/**
 * Calendar Bridge — Multi-Calendar Bi-Directional Sync
 *
 * Syncs Meitheal tasks with multiple HA calendar entities simultaneously:
 *   - HA calendar → Meitheal: entity state changes trigger event fetch
 *   - Meitheal → HA: task due dates create/update HA calendar events
 *
 * Supports:
 *   - Multiple calendar entities syncing concurrently
 *   - Configurable sync interval per entity (or global)
 *   - CalDAV external calendars (future: caldav-client.ts)
 *   - Write-back deduplication and all-day event handling
 *
 * @domain calendar
 * @bounded-context integration
 */
import { onEntityChange, listCalendarEvents, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from "../ha";
import { emitCalendarSynced } from "../ha";
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability";
import type { SyncTaskMutation } from "@domains/tasks";
import { STATUS } from "../../lib/status-config";

const logger = createLogger({
  service: "meitheal-web", env: process.env.NODE_ENV ?? "development",
  minLevel: "info", enabledCategories: ["ha", "calendar"],
  redactPatterns: defaultRedactionPatterns, auditEnabled: false,
});
const SYS_REQ = "ha-system";

/**
 * Strip outbound enriched description metadata so it doesn't loop back on inbound sync.
 * Removes: "Added from Meitheal" attribution, 📋/Status/Priority line, 🏷️ labels,
 * 📝 Checklist header + ✅/☐ items — everything buildCalendarDescription appends.
 */
function stripMeithealAttribution(desc: string | null | undefined): string | null {
  if (!desc) return null;
  const lines = desc.split("\n").filter((line) => {
    const t = line.trim();
    if (!t) return true; // preserve blank lines in user content
    if (/^Added from Meitheal$/i.test(t)) return false;
    if (/^📋\s/.test(t)) return false;              // ticket key + status + priority line
    if (/^🏷️\s/.test(t)) return false;              // labels line
    if (/^📝\s*Checklist\b/.test(t)) return false;   // checklist header
    if (/^\s*(✅|☐)\s/.test(t)) return false;        // checklist items
    if (/^Status:\s/.test(t)) return false;           // bare status line
    return true;
  });
  return lines.join("\n").trim() || null;
}

/** Sync direction — matches Grocy bridge pattern */
export type CalendarSyncMode = "import" | "export" | "bidirectional";
export interface CalendarSyncCounts {
  created: number
  updated: number
  total: number
  skipped?: string
  failed?: string
}

export interface CalendarSyncConfig {
  entityId: string;
  syncEnabled: boolean;
  syncMode: CalendarSyncMode; // per-entity direction control
  writeBack: boolean; // legacy compat — derived from syncMode at runtime
  syncIntervalMs: number;
}

export interface CalendarSyncStatusEntity {
  entityId: string;
  source: "ha" | "caldav";
  syncMode: CalendarSyncMode;
  writeBack: boolean;
  syncIntervalMs: number;
  lastSyncAt: number | null;
  lastSyncEventCount: number | null;
  lastSyncError: string | null;
}

/** Per-entity sync state — tracks timer, unsubscribers, and metadata */
interface EntitySyncState {
  config: CalendarSyncConfig;
  timer: ReturnType<typeof setInterval> | null;
  unsubscribers: (() => void)[];
  abortController: AbortController;
  lastSyncAt: number | null;
  lastSyncEventCount: number | null;
  lastSyncError: string | null;
  consecutiveFailures: number;
}

/** Hard cap: prevent runaway entity registration (memory safety) */
const MAX_ENTITIES = 10;
const CALENDAR_MAX_CONCURRENCY = 2;

async function runWithConcurrency<T, R>(
  items: readonly T[],
  maxConcurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, maxConcurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const idx = nextIndex++;
        try {
          results[idx] = { status: "fulfilled", value: await worker(items[idx]!) };
        } catch (reason) {
          results[idx] = { status: "rejected", reason };
        }
      }
    }),
  );
  return results;
}

/** Sync timeout per entity — prevents hung syncs from blocking forever */
const SYNC_TIMEOUT_MS = 30_000;

/** Map of entityId → sync state for multi-calendar support */
const activeSyncs = new Map<string, EntitySyncState>();

// Cached persistence refs — avoids repeated dynamic imports in hot sync path
let _storeModule: typeof import("@domains/tasks") | null = null;
async function getStoreModule() {
  if (!_storeModule) _storeModule = await import("@domains/tasks");
  return _storeModule;
}

/** Ensure schema via store's per-client singleton bootstrap */
async function ensureSchemaOnce() {
  const mod = await getStoreModule();
  await mod.ensureSchema();
}

/** Concurrency guard — prevents overlapping syncs for the same entity */
const syncingEntities = new Set<string>();

/** Debounce timers — stored separately so stopSingleEntitySync can cancel them */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Simple trailing debounce with cancellation — returns [debouncedFn, cancelFn] */
function debounceWithCancel<T extends (...args: unknown[]) => unknown>(
  fn: T, delayMs: number, key: string,
): [(...args: Parameters<T>) => void, () => void] {
  const debouncedFn = (...args: Parameters<T>) => {
    const existing = debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => { debounceTimers.delete(key); fn(...args); }, delayMs);
    debounceTimers.set(key, timer);
  };
  const cancelFn = () => {
    const timer = debounceTimers.get(key);
    if (timer) { clearTimeout(timer); debounceTimers.delete(key); }
  };
  return [debouncedFn, cancelFn];
}

/**
 * Start simultaneous sync for multiple HA calendar entities.
 * Replaces any previously active syncs.
 */
export function startMultiCalendarSync(configs: CalendarSyncConfig[]): Promise<void> {
  stopCalendarSync();

  const enabled = configs.filter(c => c.syncEnabled);

  // Memory safety: cap entity count to prevent runaway resource usage
  if (enabled.length > MAX_ENTITIES) {
    logger.log("warn", {
      event: "calendar.sync.entity_cap", domain: "calendar", component: "calendar-bridge",
      request_id: SYS_REQ,
      message: `Too many calendar entities (${enabled.length}). Capping at ${MAX_ENTITIES} to prevent memory issues.`,
      metadata: { requested: enabled.length, cap: MAX_ENTITIES },
    });
  }

  const capped = enabled.slice(0, MAX_ENTITIES);
  for (const config of capped) {
    startSingleEntitySync(config, true);
  }

  logger.log("info", {
    event: "calendar.sync.multi_started", domain: "calendar", component: "calendar-bridge",
    request_id: SYS_REQ,
    message: `Multi-calendar sync started for ${capped.length} entities`,
    metadata: { entities: capped.map(c => c.entityId) },
  });

  const inboundConfigs = capped.filter(c => c.syncMode !== "export");
  return runWithConcurrency(inboundConfigs, CALENDAR_MAX_CONCURRENCY, async (config) => {
    try {
      await syncEntityFromHA(config.entityId);
    } catch (err) {
      logger.log("error", {
        event: "calendar.sync.initial_failed", domain: "calendar", component: "calendar-bridge",
        request_id: SYS_REQ, message: `Initial calendar sync failed for ${config.entityId}: ${err}`,
      });
    }
  }).then(() => {});
}

/**
 * Legacy single-entity start — wraps into multi-calendar API.
 * Kept for backward compatibility with existing API routes.
 */
export function startCalendarSync(config: CalendarSyncConfig): void {
  // If this specific entity is already syncing, stop it first
  const existing = activeSyncs.get(config.entityId);
  if (existing) {
    stopSingleEntitySync(config.entityId);
  }

  if (!config.syncEnabled) return;
  startSingleEntitySync(config, false);
}

/** Internal: start sync for a single entity */
function startSingleEntitySync(config: CalendarSyncConfig, deferInitialSync = false): void {
  const state: EntitySyncState = {
    config,
    timer: null,
    unsubscribers: [],
    abortController: new AbortController(),
    lastSyncAt: null,
    lastSyncEventCount: null,
    lastSyncError: null,
    consecutiveFailures: 0,
  };

  // Export-only entities don't need inbound machinery — they push on task save only
  if (config.syncMode !== "export") {
    // Subscribe to state changes — debounced to avoid sync churn from frequent entity updates
    const [debouncedSync, cancelDebounce] = debounceWithCancel(async () => {
      logger.log("info", {
        event: "calendar.sync.entity_changed", domain: "calendar", component: "calendar-bridge",
        request_id: SYS_REQ, message: `Calendar entity ${config.entityId} changed — syncing (debounced)`,
      });
      try {
        await syncEntityFromHA(config.entityId)
      } catch (err) {
        logger.log("error", {
          event: "calendar.sync.entity_change_failed", domain: "calendar", component: "calendar-bridge",
          request_id: SYS_REQ, message: `Calendar change sync failed for ${config.entityId}: ${err}`,
        })
      }
    }, 10_000, `entity-change-${config.entityId}`);
    const unsub = onEntityChange(config.entityId, debouncedSync);
    // Store cancel function so stopSingleEntitySync can clean up the pending timer
    state.unsubscribers.push(unsub, cancelDebounce);

    // Periodic full sync — wrapped in error boundary to prevent unhandled rejection crash
    if (config.syncIntervalMs > 0) {
      state.timer = setInterval(() => {
        syncEntityFromHA(config.entityId).catch((err) => {
          logger.log("error", {
            event: "calendar.sync.interval_error", domain: "calendar", component: "calendar-bridge",
            request_id: SYS_REQ, message: `Periodic sync failed for ${config.entityId}: ${err}`,
          });
        });
      }, config.syncIntervalMs);
    }
  }

  activeSyncs.set(config.entityId, state);

  // Initial inbound sync (skipped for export-only via mode guard in syncEntityFromHA)
  if (!deferInitialSync && config.syncMode !== "export") {
    syncEntityFromHA(config.entityId).catch((err) => {
      logger.log("error", {
        event: "calendar.sync.initial_failed", domain: "calendar", component: "calendar-bridge",
        request_id: SYS_REQ, message: `Initial calendar sync failed for ${config.entityId}: ${err}`,
      });
    });
  }

  logger.log("info", {
    event: "calendar.sync.entity_started", domain: "calendar", component: "calendar-bridge",
    request_id: SYS_REQ,
    message: `Calendar sync started for ${config.entityId} (mode: ${config.syncMode}, interval: ${config.syncIntervalMs}ms, writeBack: ${config.writeBack})`,
    metadata: { entity_id: config.entityId, sync_mode: config.syncMode, write_back: config.writeBack, interval_ms: config.syncIntervalMs },
  });
}

/**
 * Sync events FROM all configured HA calendars TO Meitheal.
 * Manual retry resets failure backoff; background triggers retain it.
 * Returns aggregated results across all entities, including committed partial work.
 */
export async function syncFromHA(overrideEntityId?: string): Promise<CalendarSyncCounts> {
  // If a specific entity is requested, sync just that one
  if (overrideEntityId) {
    return syncEntityFromHA(overrideEntityId, true);
  }

  // If no entities configured, return empty
  if (activeSyncs.size === 0) {
    logger.log("warn", {
      event: "calendar.sync.no_entities", domain: "calendar", component: "calendar-bridge",
      request_id: SYS_REQ, message: "syncFromHA called with no entities configured",
    });
    throw new Error("No active calendar sync is configured");
  }

  // Sync configured entities with bounded concurrency (max 2 concurrent workers)
  const results = await runWithConcurrency(
    Array.from(activeSyncs.keys()),
    CALENDAR_MAX_CONCURRENCY,
    (entityId) => syncEntityFromHA(entityId, true),
  );

  const aggregated: CalendarSyncCounts = { created: 0, updated: 0, total: 0 };
  let failures = 0
  for (const result of results) {
    if (result.status === "fulfilled") {
      aggregated.created += result.value.created;
      aggregated.updated += result.value.updated;
      aggregated.total += result.value.total;
      if (result.value.failed || result.value.skipped) failures++
    } else {
      failures++
    }
  }
  if (failures > 0) aggregated.failed = `${failures} calendar(s) failed or skipped`

  logger.log(failures > 0 ? "warn" : "info", {
    event: failures > 0 ? "calendar.sync.multi_incomplete" : "calendar.sync.multi_complete", domain: "calendar", component: "calendar-bridge",
    request_id: SYS_REQ,
    message: `Multi-calendar sync: ${aggregated.created} created, ${aggregated.updated} updated from ${aggregated.total} events across ${activeSyncs.size} calendars; ${failures} failed or skipped`,
  });

  return aggregated;
}

/**
 * Sync events FROM a single HA calendar entity TO Meitheal.
 * Merges calendar events into the tasks table with deduplication
 * via the calendar_confirmations table (keyed by provider_event_id).
 */
async function syncEntityFromHA(entityId: string, manualRetry = false): Promise<CalendarSyncCounts> {
  // Mode guard — export-only calendars skip inbound sync
  const state = activeSyncs.get(entityId);
  if (state?.config.syncMode === "export") {
    logger.log("debug", {
      event: "calendar.sync.skipped_export_only", domain: "calendar", component: "calendar-bridge",
      request_id: SYS_REQ, message: `Inbound sync skipped for ${entityId} — export-only mode`,
      metadata: { sync_mode: "export" },
    });
    return { created: 0, updated: 0, total: 0, skipped: "export-only calendar" };
  }

  // Concurrency guard — skip if already syncing this entity
  if (syncingEntities.has(entityId)) {
    logger.log("debug", {
      event: "calendar.sync.skipped_concurrent", domain: "calendar", component: "calendar-bridge",
      request_id: SYS_REQ, message: `Sync already in progress for ${entityId} — skipping`,
    });
    return { created: 0, updated: 0, total: 0, skipped: "sync already running" };
  }
  if (state && manualRetry) state.consecutiveFailures = 0
  syncingEntities.add(entityId);
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    // Wrap in timeout to prevent hung syncs from blocking indefinitely
    const result = await Promise.race([
      _syncEntityFromHAInner(entityId, state ?? null),
      new Promise<CalendarSyncCounts>((_, reject) =>
        timeout = setTimeout(() => reject(new Error(`Sync timeout after ${SYNC_TIMEOUT_MS}ms`)), SYNC_TIMEOUT_MS)
      ),
    ]);
    // This wrapper is the single owner of failure accounting, including partial merges.
    if (state && !result.skipped) {
      state.lastSyncAt = Date.now()
      state.lastSyncEventCount = result.total
      state.lastSyncError = result.failed ?? null
      state.consecutiveFailures = result.failed ? state.consecutiveFailures + 1 : 0
    }
    return result;
  } catch (err) {
    // Timeout or unexpected error — still update state
    if (state) {
      state.lastSyncError = String(err);
      state.lastSyncAt = Date.now();
      state.consecutiveFailures++;
    }
    logger.log("error", {
      event: "calendar.sync.timeout_or_error", domain: "calendar", component: "calendar-bridge",
      request_id: SYS_REQ, message: `Sync failed for ${entityId}: ${err}`,
    });
    throw err;
  } finally {
    clearTimeout(timeout)
    syncingEntities.delete(entityId);
  }
}

/** Inner sync logic — always called within concurrency guard */
async function _syncEntityFromHAInner(entityId: string, state: EntitySyncState | null): Promise<CalendarSyncCounts> {

  // Backoff: skip sync after 5 consecutive failures (reset via stopSingleEntitySync or manual)
  if (state && state.consecutiveFailures >= 5) {
    logger.log("warn", {
      event: "calendar.sync.backoff", domain: "calendar", component: "calendar-bridge",
      request_id: SYS_REQ,
      message: `Sync backoff for ${entityId} — ${state.consecutiveFailures} consecutive failures (last: ${state.lastSyncError})`,
    });
    return { created: 0, updated: 0, total: 0, skipped: "calendar sync is in failure backoff" };
  }

  const now = new Date();
  const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const events = await listCalendarEvents(entityId, start, end);

  if (events.length === 0) {
    logger.log("debug", {
      event: "calendar.sync.from_ha", domain: "calendar", component: "calendar-bridge",
      request_id: SYS_REQ, message: `No events to sync from ${entityId}`,
    });
    return { created: 0, updated: 0, total: 0 };
  }

  try {
    await ensureSchemaOnce();
    const mod = await getStoreModule();
    const client = mod.getPersistenceClient();

    let created = 0;
    let updated = 0;
    let skipped = 0;

    // Batch dedup: pre-fetch existing provider_event_ids scoped to entityId in <= 200-param chunks
    const eventUids = events.map((evt) => evt.uid ?? `ha-cal-${entityId}-${evt.summary}-${evt.start}`);
    const existingLookup = await mod.findTasksByExternalSyncIds({
      source: "calendar",
      entityId,
      externalIds: eventUids,
    });
    const existingMap = new Map<string, string>();
    for (const [uid, match] of existingLookup.entries()) {
      existingMap.set(uid, match.taskId);
    }

    const unmatchedSummaries = [
      ...new Set(
        events
          .map((evt, idx) => ({ evt, uid: eventUids[idx]! }))
          .filter(({ evt, uid }) => !existingMap.has(uid) && Boolean(evt.summary) && !(evt.description && /Added from Meitheal/i.test(evt.description)))
          .map(({ evt }) => evt.summary),
      ),
    ];
    const openTitleToTaskId = new Map<string, string>();
    for (let offset = 0; offset < unmatchedSummaries.length; offset += 200) {
      const chunk = unmatchedSummaries.slice(offset, offset + 200);
      const placeholders = chunk.map(() => "?").join(", ");
      const titleMatches = await client.execute({
        sql: `SELECT id, title FROM tasks WHERE status != 'complete' AND title IN (${placeholders}) ORDER BY rowid ASC`,
        args: chunk,
      });
      for (const row of titleMatches.rows) {
        const titleKey = String(row.title);
        if (!openTitleToTaskId.has(titleKey)) {
          openTitleToTaskId.set(titleKey, String(row.id));
        }
      }
    }

    let errors = 0;
    const mutations: SyncTaskMutation[] = [];
    const mutationSummaries: string[] = [];
    const nowMs = Date.now();

    for (let i = 0; i < events.length; i++) {
      const evt = events[i]!;
      const uid = eventUids[i]!;
      let existingTaskId = existingMap.get(uid);

      // ── Loop prevention: skip events that Meitheal pushed outbound ──
      if (evt.description && /Added from Meitheal/i.test(evt.description)) {
        skipped++;
        continue;
      }

      const confirmationPayload = JSON.stringify({
        summary: evt.summary,
        start: evt.start,
        end: evt.end,
        entity_id: entityId,
      });

      // Fallback dedup: if UID lookup fails, check if an open task with this title exists.
      if (!existingTaskId && evt.summary) {
        const titleMatchedId = openTitleToTaskId.get(evt.summary);
        if (titleMatchedId) {
          existingTaskId = titleMatchedId;
          mutations.push({
            kind: "link",
            taskId: existingTaskId,
            createdAt: nowMs,
            confirmation: {
              source: "calendar",
              entityId,
              externalId: uid,
              confirmationSource: "ha.calendar_sync",
              payload: confirmationPayload,
            },
          });
          mutationSummaries.push(evt.summary);
        }
      }

      if (existingTaskId) {
        const descParts: string[] = [];
        if (evt.location) descParts.push(`📍 ${evt.location}`);
        const stripped = stripMeithealAttribution(evt.description);
        if (stripped) descParts.push(stripped);
        const inboundDesc = descParts.length > 0 ? descParts.join("\n\n") : null;

        mutations.push({
          kind: "update",
          taskId: existingTaskId,
          dueDate: evt.start,
          updateDueDate: true,
          description: inboundDesc,
          ensureCalendarSyncLabel: true,
          updatedAt: nowMs,
        });
        mutationSummaries.push(evt.summary);
      } else {
        const taskId = crypto.randomUUID();
        if (evt.summary) {
          openTitleToTaskId.set(evt.summary, taskId);
        }
        const newDescParts: string[] = [];
        if (evt.location) newDescParts.push(`📍 ${evt.location}`);
        if (evt.description) newDescParts.push(evt.description);
        const newDesc = newDescParts.length > 0 ? newDescParts.join("\n\n") : "";

        mutations.push({
          kind: "create",
          taskId,
          idempotencyKey: `cal-sync-${uid}`,
          title: evt.summary,
          description: newDesc,
          status: "pending",
          priority: 3,
          dueDate: evt.start,
          labels: ["calendar-sync"],
          areaId: "default",
          taskType: "task",
          createdAt: nowMs,
          confirmation: {
            source: "calendar",
            entityId,
            externalId: uid,
            confirmationSource: "ha.calendar_sync",
            payload: confirmationPayload,
          },
        });
        mutationSummaries.push(evt.summary);
      }
    }

    if (mutations.length > 0) {
      const commitRes = await mod.commitSyncMutationChunks(mutations);
      created += commitRes.created;
      updated += commitRes.updated;
      errors += commitRes.errors.length;
      for (const itemErr of commitRes.errors) {
        const summary = mutationSummaries[itemErr.index] ?? `index ${itemErr.index}`;
        logger.log("error", {
          event: "calendar.sync.event_error", domain: "calendar", component: "calendar-bridge",
          request_id: SYS_REQ,
          message: `Failed to process event "${summary}" from ${entityId}: ${itemErr.message}`,
        });
      }
    }

    // Stale event detection: archive tasks whose calendar events were deleted
    // Only run when no per-event errors to avoid false positives from partial API failures
    // Scoped to import/bidirectional modes — export-only never creates inbound tasks
    const staleMode = state?.config.syncMode ?? "bidirectional";
    if (errors === 0 && events.length > 0 && staleMode !== "export") {
      try {
        const allConfirmations = await client.execute({
          sql: `SELECT c.confirmation_id, c.task_id, c.provider_event_id
                FROM calendar_confirmations c
                WHERE c.source = 'ha.calendar_sync'
                  AND json_extract(c.payload, '$.entity_id') = ?`,
          args: [entityId],
        });
        const currentUids = new Set(eventUids);
        for (const row of allConfirmations.rows) {
          const eventUid = String(row.provider_event_id);
          if (!currentUids.has(eventUid)) {
            const taskId = String(row.task_id);
            await client.execute({
              sql: `UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status != ?`,
              args: [STATUS.COMPLETE, Date.now(), taskId, STATUS.COMPLETE],
            });
            logger.log("info", {
              event: "calendar.sync.stale_archived", domain: "calendar", component: "calendar-bridge",
              request_id: SYS_REQ,
              message: `Archived task ${taskId} — calendar event ${eventUid} no longer exists in ${entityId}`,
            });
          }
        }
      } catch (staleErr) {
        errors++
        logger.log("warn", {
          event: "calendar.sync.stale_check_failed", domain: "calendar", component: "calendar-bridge",
          request_id: SYS_REQ, message: `Stale event check failed for ${entityId}: ${staleErr}`,
        });
      }
    }

    if (errors > 0) {
      return { created, updated, total: events.length, failed: `${errors} calendar merge or reconciliation operation(s) failed` }
    }

    logger.log("info", {
      event: "calendar.sync.from_ha", domain: "calendar", component: "calendar-bridge",
      request_id: SYS_REQ,
      message: `Calendar sync complete for ${entityId}: ${created} created, ${updated} updated, ${skipped} skipped from ${events.length} events`,
      metadata: { entity_id: entityId, sync_mode: state?.config.syncMode ?? "bidirectional", event_count: events.length, created, updated, skipped },
    });

    // Emit HA event for Node-RED/n8n automation
    const syncMode = state?.config.syncMode ?? "bidirectional"
    const directionMap = { import: "inbound", export: "outbound", bidirectional: "bidirectional" } as const
    emitCalendarSynced({
      entity_id: entityId,
      sync_direction: directionMap[syncMode] ?? "bidirectional",
      events_created: created,
      events_updated: updated,
      total_events: events.length,
    }).catch(() => { /* fire-and-forget */ });

    return { created, updated, total: events.length };
  } catch (err) {
    logger.log("error", {
      event: "calendar.sync.merge_failed", domain: "calendar", component: "calendar-bridge",
      request_id: SYS_REQ, message: `Failed to merge calendar events from ${entityId}: ${err}`,
    });
    throw err;
  }
}

/** Task metadata for rich calendar event descriptions */
export interface TaskCalendarMeta {
  status?: string | undefined;
  priority?: number | undefined;
  labels?: string[] | undefined;
  checklists?: Array<{ text: string; done: boolean }> | undefined;
  ticketKey?: string | undefined; // e.g. "MTH-42"
}

const PRIORITY_LABELS = ['', '🔴 Critical', '🟠 High', '🟡 Medium', '🔵 Low', '⚪ Lowest'] as const;

/** Build a rich, human-readable description for a calendar event from task data */
function buildCalendarDescription(
  description: string | undefined,
  meta?: TaskCalendarMeta,
): string {
  const parts: string[] = [];

  // Task description
  if (description?.trim()) {
    parts.push(description.trim());
  }

  // Status + Priority line
  const statusParts: string[] = [];
  if (meta?.ticketKey) statusParts.push(`📋 ${meta.ticketKey}`);
  if (meta?.status) statusParts.push(`Status: ${meta.status}`);
  if (meta?.priority && meta.priority >= 1 && meta.priority <= 5) {
    statusParts.push(PRIORITY_LABELS[meta.priority]!);
  }
  if (statusParts.length > 0) parts.push(statusParts.join(' · '));

  // Labels (exclude internal ones)
  const displayLabels = (meta?.labels ?? []).filter(
    (l) => l !== 'calendar-sync' && l !== 'no-sync' && !l.startsWith('synced from '),
  );
  if (displayLabels.length > 0) {
    parts.push(`🏷️ ${displayLabels.join(', ')}`);
  }

  // Checklists
  if (meta?.checklists && meta.checklists.length > 0) {
    const done = meta.checklists.filter((c) => c.done).length;
    parts.push(`📝 Checklist (${done}/${meta.checklists.length})`);
    for (const item of meta.checklists) {
      parts.push(`  ${item.done ? '✅' : '☐'} ${item.text}`);
    }
  }

  // Attribution
  parts.push('Added from Meitheal');

  return parts.join('\n');
}

/**
 * Push a task due date TO HA calendar — supports write-back deduplication.
 * If dueDate has no time component (YYYY-MM-DD only), creates an all-day event.
 */
export async function pushTaskToCalendar(
  taskId: string, title: string, dueDate: string, description?: string,
  targetEntityId?: string, meta?: TaskCalendarMeta,
): Promise<boolean> {
  // Find the first entity with export/bidirectional mode, or use targetEntityId
  let writeBackEntity: CalendarSyncConfig | undefined;
  if (targetEntityId) {
    const targetState = activeSyncs.get(targetEntityId);
    // Mode guard — import-only calendars skip outbound push
    if (targetState?.config.syncMode === "import") {
      logger.log("debug", {
        event: "calendar.writeback.skipped_import_only", domain: "calendar", component: "calendar-bridge",
        request_id: SYS_REQ, message: `Outbound push skipped for ${targetEntityId} — import-only mode`,
        metadata: { sync_mode: "import", task_id: taskId },
      });
      return false;
    }
    writeBackEntity = targetState?.config;
  } else {
    for (const [, state] of activeSyncs) {
      // Accept export or bidirectional mode for outbound writes
      if (state.config.syncMode !== "import" && state.config.writeBack) {
        writeBackEntity = state.config;
        break;
      }
    }
  }

  if (!writeBackEntity?.writeBack) return false;

  // Check if we already pushed this task — if so, UPDATE instead of creating duplicate
  let isUpdate = false;
  try {
    await ensureSchemaOnce();
    const mod = await getStoreModule();
    const client = mod.getPersistenceClient();
    const existing = await client.execute({
      sql: "SELECT confirmation_id FROM calendar_confirmations WHERE task_id = ? AND source = 'ha.write_back'",
      args: [taskId],
    });
    if (existing.rows.length > 0) {
      isUpdate = true;
      logger.log("debug", {
        event: "calendar.writeback.update", domain: "calendar", component: "calendar-bridge",
        request_id: SYS_REQ, message: `Write-back exists for task ${taskId} — updating event`,
      });
    }
  } catch { /* DB not available — proceed with create */ }

  // All-day event detection: if dueDate is YYYY-MM-DD (no time), create all-day
  const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(dueDate);

  let start: string;
  let end: string;
  if (isAllDay) {
    start = dueDate;
    // All-day events: end date is exclusive (next day)
    const d = new Date(dueDate);
    d.setDate(d.getDate() + 1);
    end = d.toISOString().slice(0, 10);
  } else {
    start = dueDate;
    // Default 1-hour duration
    end = new Date(new Date(dueDate).getTime() + 60 * 60 * 1000).toISOString();
  }

  const richDescription = buildCalendarDescription(description, meta);

  // Use update path when event already exists, create otherwise
  let success: boolean;
  if (isUpdate) {
    success = await updateCalendarEvent(writeBackEntity.entityId, {
      summary: title,
      start,
      end,
      description: richDescription,
      uid: `writeback-${taskId}`,
    });
  } else {
    success = await createCalendarEvent(writeBackEntity.entityId, {
      summary: title,
      start,
      end,
      description: richDescription,
    });
  }

  if (success) {
    // Record write-back confirmation for deduplication
    try {
      const mod = await getStoreModule();
      const client = mod.getPersistenceClient();
      await client.execute({
        sql: `INSERT INTO calendar_confirmations (confirmation_id, task_id, request_id, provider_event_id,
                source, payload, created_at) VALUES (?, ?, ?, ?, 'ha.write_back', ?, ?)`,
        args: [
          crypto.randomUUID(),
          taskId,
          crypto.randomUUID(),
          `writeback-${taskId}`,
          JSON.stringify({ entity_id: writeBackEntity.entityId, title, start, end }),
          Date.now(),
        ],
      });
    } catch { /* non-critical */ }

    logger.log("info", {
      event: "calendar.sync.pushed_to_ha", domain: "calendar", component: "calendar-bridge",
      request_id: SYS_REQ, message: `Pushed task "${title}" to HA calendar ${writeBackEntity.entityId}`,
      metadata: { task_id: taskId, all_day: isAllDay },
    });
  }

  return success;
}

/**
 * Remove a calendar event associated with a task (outbound delete).
 * Looks up the write-back confirmation and calls deleteCalendarEvent.
 * Safe to call even if no calendar event exists — returns false silently.
 */
export async function removeTaskCalendarEvent(taskId: string): Promise<boolean> {
  try {
    await ensureSchemaOnce();
    const mod = await getStoreModule();
    const client = mod.getPersistenceClient();

    // Find the write-back confirmation to get entity_id
    const conf = await client.execute({
      sql: "SELECT confirmation_id, payload FROM calendar_confirmations WHERE task_id = ? AND source = 'ha.write_back' LIMIT 1",
      args: [taskId],
    });

    if (conf.rows.length === 0) return false; // No calendar event to delete

    const row = conf.rows[0] as Record<string, unknown>;
    const payload = JSON.parse(String(row.payload ?? "{}"));
    const entityId = payload.entity_id as string | undefined;

    if (!entityId) return false;

    // Delete the event from HA calendar
    const uid = `writeback-${taskId}`;
    const deleted = await deleteCalendarEvent(entityId, uid);

    // Clean up confirmation record regardless of HA response
    await client.execute({
      sql: "DELETE FROM calendar_confirmations WHERE task_id = ? AND source = 'ha.write_back'",
      args: [taskId],
    });

    if (deleted) {
      logger.log("info", {
        event: "calendar.sync.deleted_from_ha", domain: "calendar", component: "calendar-bridge",
        request_id: SYS_REQ, message: `Deleted calendar event for task ${taskId} from ${entityId}`,
      });
    }

    return deleted;
  } catch (err) {
    logger.log("warn", {
      event: "calendar.sync.delete_failed", domain: "calendar", component: "calendar-bridge",
      request_id: SYS_REQ, message: `Failed to remove calendar event for task ${taskId}: ${err}`,
    });
    return false;
  }
}

/** Stop sync for a single entity */
function stopSingleEntitySync(entityId: string): void {
  const state = activeSyncs.get(entityId);
  if (!state) return;

  // Clear periodic interval
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }

  // Abort any in-flight fetch/sync operations
  state.abortController.abort();

  // Call all unsubscribers (entity change listeners + debounce cancel fns)
  state.unsubscribers.forEach((u) => u());

  // Cleanup any orphaned debounce timers for this entity
  const debounceKey = `entity-change-${entityId}`;
  const orphanedTimer = debounceTimers.get(debounceKey);
  if (orphanedTimer) {
    clearTimeout(orphanedTimer);
    debounceTimers.delete(debounceKey);
  }

  activeSyncs.delete(entityId);
}

/**
 * Stop all calendar syncs and clean up.
 */
export function stopCalendarSync(): void {
  // Copy keys to array first — stopSingleEntitySync deletes from the map,
  // so iterating the map directly risks ConcurrentModificationError
  const entityIds = Array.from(activeSyncs.keys());
  for (const entityId of entityIds) {
    stopSingleEntitySync(entityId);
  }
}

/**
 * Get current sync status — returns per-entity statuses for multi-calendar support.
 */
export function getCalendarSyncStatus() {
  const haActive = activeSyncs.size > 0;

  const entities: CalendarSyncStatusEntity[] = Array.from(activeSyncs.entries()).map(([entityId, state]) => ({
    entityId,
    source: "ha" as const,
    syncMode: state.config.syncMode ?? "bidirectional",
    writeBack: state.config.writeBack,
    syncIntervalMs: state.config.syncIntervalMs,
    lastSyncAt: state.lastSyncAt,
    lastSyncEventCount: state.lastSyncEventCount,
    lastSyncError: state.lastSyncError,
  }));

  // Include CalDAV sync status
  if (caldavSyncState) {
    entities.push({
      entityId: "caldav",
      source: "caldav" as const,
      syncMode: caldavSyncState.syncMode,
      writeBack: false,
      syncIntervalMs: caldavSyncState.intervalMs,
      lastSyncAt: caldavSyncState.lastSyncAt,
      lastSyncEventCount: caldavSyncState.lastSyncEventCount,
      lastSyncError: caldavSyncState.lastSyncError,
    });
  }

  // Legacy compat — return first entity's data at top level
  const first = entities[0];

  return {
    active: haActive || !!caldavSyncState,
    entities,
    entityCount: entities.length,
    entityId: first?.entityId ?? null,
    writeBack: entities.some((e) => e.writeBack),
    lastSyncAt: first?.lastSyncAt ?? null,
    lastSyncEventCount: entities.reduce((sum, e) => sum + (e.lastSyncEventCount ?? 0), 0),
    lastSyncError: entities.find((e) => e.lastSyncError)?.lastSyncError ?? null,
    caldavActive: !!caldavSyncState,
  };
}

/**
 * Get current sync config for all entities (for introspection by API routes).
 */
export function getCalendarSyncConfigs(): CalendarSyncConfig[] {
  return Array.from(activeSyncs.values()).map((s) => s.config);
}

/**
 * Get current sync config (legacy single-entity — returns first).
 */
export function getCalendarSyncConfig(): CalendarSyncConfig | null {
  const first = activeSyncs.values().next();
  return first.done ? null : first.value.config;
}

// ─── CalDAV Sync ────────────────────────────────────────────────────

interface CalDAVSyncState {
  url: string;
  timer: ReturnType<typeof setInterval> | null;
  intervalMs: number;
  syncMode: CalendarSyncMode;
  lastSyncAt: number | null;
  lastSyncEventCount: number | null;
  lastSyncError: string | null;
  consecutiveFailures: number;
}

let caldavSyncState: CalDAVSyncState | null = null;
let syncingCalDAV = false

/**
 * Start periodic CalDAV sync. Independent error boundary — CalDAV
 * failure never impacts HA calendar sync.
 */
export function startCalDAVSync(url: string, intervalMs: number): void {
  stopCalDAVSync();

  caldavSyncState = {
    url,
    timer: null,
    intervalMs,
    syncMode: "import",
    lastSyncAt: null,
    lastSyncEventCount: null,
    lastSyncError: null,
    consecutiveFailures: 0,
  };

  // Run initial sync
  syncCalDAVFromServer().catch(() => { /* logged inside */ });

  // Set up periodic sync if interval > 0
  if (intervalMs > 0) {
    caldavSyncState.timer = setInterval(() => {
      syncCalDAVFromServer().catch(() => { /* logged inside */ });
    }, intervalMs);
  }

  logger.log("info", {
    event: "calendar.caldav.started", domain: "calendar", component: "calendar-bridge",
    request_id: SYS_REQ,
    message: `CalDAV sync started (interval: ${intervalMs}ms)`,
  });
}

/** Stop CalDAV sync */
export function stopCalDAVSync(): void {
  if (caldavSyncState?.timer) {
    clearInterval(caldavSyncState.timer);
    caldavSyncState.timer = null;
  }
  caldavSyncState = null;
}

/**
 * Manually retry the configured CalDAV import, resetting its failure backoff.
 * Background callbacks retain backoff and use a separate error boundary from HA.
 */
export async function syncCalDAVEvents(): Promise<CalendarSyncCounts> {
  return syncCalDAVFromServer(true)
}

async function syncCalDAVFromServer(manualRetry = false): Promise<CalendarSyncCounts> {
  const state = caldavSyncState
  if (!state) return { created: 0, updated: 0, total: 0, skipped: "CalDAV sync is not configured" }
  if (syncingCalDAV) return { created: 0, updated: 0, total: 0, skipped: "CalDAV sync already running" }
  if (manualRetry) state.consecutiveFailures = 0

  // Backoff: skip sync after 5 consecutive failures
  if (state.consecutiveFailures >= 5) {
    logger.log("warn", {
      event: "calendar.caldav.backoff", domain: "calendar", component: "calendar-bridge",
      request_id: SYS_REQ,
      message: `CalDAV backoff — ${state.consecutiveFailures} consecutive failures`,
    });
    return { created: 0, updated: 0, total: 0, skipped: "CalDAV sync is in failure backoff" };
  }

  syncingCalDAV = true
  try {
    const result = await importCalDAVEvents()
    state.lastSyncAt = Date.now()
    state.lastSyncEventCount = result.total
    state.lastSyncError = result.failed ?? null
    state.consecutiveFailures = result.failed ? state.consecutiveFailures + 1 : 0
    return result
  } finally {
    syncingCalDAV = false
  }
}

async function importCalDAVEvents(): Promise<CalendarSyncCounts> {
  let totalCreated = 0
  let totalUpdated = 0
  let totalEvents = 0
  try {
    // Dynamic import to avoid loading crypto at module level
    const { decryptCalDAVPassword } = await import("../../pages/api/integrations/calendar/caldav-credentials");
    const { listCalDAVEvents, discoverCalendars } = await import("./caldav-client");
    const mod = await getStoreModule();

    await ensureSchemaOnce();
    const client = mod.getPersistenceClient();

    // Load credentials
    const credRes = await client.execute({
      sql: "SELECT key, value FROM settings WHERE key IN ('caldav_url', 'caldav_username', 'caldav_password_enc') ORDER BY key",
      args: [],
    });
    const creds: Record<string, string> = {};
    for (const row of credRes.rows) {
      creds[String(row.key)] = String(row.value);
    }
    // Credential setup historically stores raw URLs; Settings restores store JSON
    // values. Decode only this preference, leaving credential bytes untouched.
    if (creds.caldav_url) {
      try {
        const restored: unknown = JSON.parse(creds.caldav_url)
        creds.caldav_url = typeof restored === "string" ? restored : ""
      } catch { /* Existing raw URL. */ }
    }

    if (!creds.caldav_url || !creds.caldav_username || !creds.caldav_password_enc) {
      return { created: 0, updated: 0, total: 0, failed: "CalDAV credentials not configured" };
    }

    const config = {
      url: creds.caldav_url,
      username: creds.caldav_username,
      password: decryptCalDAVPassword(creds.caldav_password_enc),
    };

    // Discover calendars
    const calendars = await discoverCalendars(config);
    if (calendars.length === 0) {
      return { created: 0, updated: 0, total: 0, failed: "No CalDAV calendars found on server" };
    }

    // Fetch events from all discovered calendars — same range as HA sync
    const now = new Date();
    const start = new Date(now.getTime() - 7 * 86400000);  // -7 days
    const end = new Date(now.getTime() + 30 * 86400000);    // +30 days

    let failures = 0

    for (const cal of calendars) {
      try {
        const events = await listCalDAVEvents(config, cal.href, start, end);
        totalEvents += events.length;

        // Batch dedup: pre-fetch existing UIDs for this calendar in <= 200-param chunks
        const calUids = events.map((evt) => evt.uid);
        const existingCalUids = new Set<string>();
        for (let offset = 0; offset < calUids.length; offset += 200) {
          const chunk = calUids.slice(offset, offset + 200);
          const uidPlaceholders = chunk.map(() => "?").join(", ");
          const existingCalRes = await client.execute({
            sql: `SELECT provider_event_id FROM calendar_confirmations WHERE provider_event_id IN (${uidPlaceholders}) AND source = 'caldav'`,
            args: chunk,
          });
          for (const r of existingCalRes.rows) {
            existingCalUids.add(String(r.provider_event_id));
          }
        }

        const nowMs = Date.now();
        const calMutations: SyncTaskMutation[] = [];
        for (const evt of events) {
          if (existingCalUids.has(evt.uid)) {
            totalUpdated++;
            continue;
          }
          existingCalUids.add(evt.uid);
          calMutations.push({
            kind: "create",
            taskId: crypto.randomUUID(),
            idempotencyKey: `caldav-sync-${evt.uid}`,
            title: evt.summary,
            description: evt.description || `📡 CalDAV event from ${cal.displayName}`,
            status: "backlog",
            priority: 3,
            dueDate: evt.dtstart,
            labels: ["calendar-sync"],
            areaId: "default",
            taskType: "task",
            createdAt: nowMs,
            confirmation: {
              source: "calendar",
              entityId: cal.displayName,
              externalId: evt.uid,
              confirmationSource: "caldav",
              payload: JSON.stringify({
                summary: evt.summary,
                dtstart: evt.dtstart,
                calendar: cal.displayName,
                entity_id: cal.displayName,
              }),
            },
          });
        }

        if (calMutations.length > 0) {
          const commitRes = await mod.commitSyncMutationChunks(calMutations);
          totalCreated += commitRes.created;
          if (commitRes.errors.length > 0) {
            failures++;
            logger.log("warn", {
              event: "calendar.caldav.calendar_error", domain: "calendar", component: "calendar-bridge",
              request_id: SYS_REQ, message: "Failed to fetch or import a CalDAV calendar; check server access and database health",
            });
          }
        }
      } catch {
        failures++
        logger.log("warn", {
          event: "calendar.caldav.calendar_error", domain: "calendar", component: "calendar-bridge",
          request_id: SYS_REQ, message: "Failed to fetch or import a CalDAV calendar; check server access and database health",
        });
      }
    }

    if (failures > 0) {
      return { created: totalCreated, updated: totalUpdated, total: totalEvents, failed: `${failures} CalDAV calendar(s) failed to fetch or import` }
    }

    logger.log("info", {
      event: "calendar.caldav.synced", domain: "calendar", component: "calendar-bridge",
      request_id: SYS_REQ,
      message: `CalDAV sync complete: ${totalCreated} created, ${totalUpdated} already synced, ${totalEvents} total events`,
    });

    return { created: totalCreated, updated: totalUpdated, total: totalEvents };
  } catch {
    const message = "CalDAV sync failed; check credentials, server access and database health";

    logger.log("error", {
      event: "calendar.caldav.error", domain: "calendar", component: "calendar-bridge",
      request_id: SYS_REQ, message: `CalDAV sync error: ${message}`,
    });

    return { created: totalCreated, updated: totalUpdated, total: totalEvents, failed: message };
  }
}
