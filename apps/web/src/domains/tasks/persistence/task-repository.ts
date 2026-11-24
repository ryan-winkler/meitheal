import { sanitize } from "../../../lib/sanitize"
import { hasCommentMentionSelector } from "../../../lib/comment-mentions"
import { stripHtml } from "../../../lib/strip-html"
import { assignmentProofMatches, resolveHAAssignmentProof, type AssignmentProof } from "../assignment-proof"
import { validateIntegrationScope, type IntegrationScope } from "../board-automation"
import { bindingAllows, readWorkDestinations } from "../integration-destinations"
import { projectPublicTaskFields } from "../task-projection"
import { goalEligibility } from "./shared-goal-repository"
import { readTaskAssignmentReceipt } from "./task-assignment-receipt"
import { validateBoardFeature, validateBoardPlacement } from "../board-access-service"
import { createHash } from "node:crypto"
import { scopedTaskRead, taskReadPlacement, type TaskReadPlacement } from "./board-work-query"
import { sql, sourceSql, joinSql } from "./sql-fragment"
import { taskOwnedBy, ownedPlanning, storageBoardId, taskField, requireBoardScope } from "./board-storage"
import { acquirePrivateBoardWriter, boardOperationClient, requireBoardWriterIntent, requireBoardWriterCheck, validateTaskOperation, BoardOperationError } from "./board-operation-client"
import { validateBoardScope, scopeAssignedTo, scopeServicePurpose, scopeServiceDestination, scopeServiceSourceId, scopeIntakeSubmission, scopeBoardAccess, type BoardScope, type WorkAction, type WorkOperation } from "../board-scope"
import { guardClientContinuity } from "./continuity-client"
/**
 * TaskRepository — centralized domain service for all task-related database queries.
 * @domain Task Management
 *
 * Provides typed, parameterized query methods for both reads and writes.
 * Read methods serve Astro page files (dashboard, kanban, calendar, etc.).
 * Write methods serve API routes (tasks CRUD, recurrence, activity logging).
 *
 * @example
 *   import { TaskRepository } from '@domains/tasks/persistence/task-repository';
 *   const repo = new TaskRepository(getPersistenceClient(), scope);
 *   const tasks = await repo.getRecentTasks(10);
 *   const created = await repo.createTask({ id: '...', title: 'New', ... });
 */

import type { HomeAssistantAreaFilter } from "../../../lib/home-assistant-area-access"
import { setTaskHomeAssistantArea, readHomeAssistantAreaPolicyRevision } from "./home-assistant-task-area"
import { effectiveTaskScheduledDate, isValidTaskKind } from "@meitheal/domain-tasks"
import { taskLabelInsert } from "./label-reference-repository"
import { homeAssistantTaskAreaCondition } from "./home-assistant-task-area"
import type { Client, InStatement, InValue, ResultSet, Transaction } from "@libsql/client"
import { acquireWriteTransaction, executeWriteWithRetry, localReaderCacheToken, runWriteTransaction, tagTaskProjectionRead } from "../../../../scripts/database-client.mjs"
import { CLOSED_TASK_STATUSES, getStatusDef, isClosedStatus, isDoneStatus, normalizeStatus, STATUS } from "../../../lib/status-config"
import { logApiError, logApiWarn } from "../../../lib/api-logger"
import { EXACT_TASK_IDENTIFIER_SCORE } from "../../../lib/task-search-score"
import { readStoredCalendarDay } from "../../../lib/calendar-day"
import { calendarDayFromInput, calendarEventDay, calendarEventInterval, calendarEventSpanDays, calendarIntervalOverlaps, calendarOccurrenceStartKey, calendarToday, compareCalendarStarts, householdDayRanges, isTaskOverdue, shiftCalendarDay } from "../../../lib/date"
import { todayCompletionFilter } from "../../../lib/task-queries"
import { MAX_TASK_HIERARCHY_DEPTH, VALID_TASK_TYPES, validateParentChildType } from "@meitheal/domain-tasks"
import { formatTicketKey, parseTicketKey } from "../../../lib/ticket-key"
import { getNextOccurrence, parseRRule } from "../recurrence"
import { routinePeriod } from "../routine-period"
import type { TaskEpicLink } from "../task-epic-groups"
import { deferralTerminalStatusesSql, isDeferralTerminalStatus } from "./task-deferral-status"
import { discardUnappliedTaskActivity, sanitizeOriginName, taskAddedActivity, taskChangedActivity, type RecentTaskActor } from "./recent-activity"
import { canAdvanceTaskTimestampMs, nextTaskTimestampMs, taskTimestampMs } from "./task-timestamp"
import { inactivityRuleActor, inactivityWriteGuard } from "./task-inactivity-query"
import { openTaskDependencies } from "./task-dependencies"

const notifPrefsCache = new WeakMap<object, { token: string; rawValue: string | null }>()
const defaultAssigneeCache = new WeakMap<object, { token: string; byBoard: Map<string, string | null> }>()

const taskHistoryPredicate = "(feed_action IS NULL OR field <> 'activity')"
const openStatusPredicate = `lower(status) NOT IN (${CLOSED_TASK_STATUSES.map(() => "?").join(", ")})`
// Agent "added" rows keep Recent Activity provenance as JSON in `summary`. The task
// activity and timeline APIs (and their MCP tools) keep returning readable text.
const PUBLIC_ACTIVITY_SUMMARY = `CASE WHEN field = 'created' AND summary LIKE '{"v":1,%' THEN 'Task added' ELSE summary END`

type RecurrenceSuccessor = {
  id: string
  ticketNumber: number
  title: string
  dueDate: string
  rule: string
}
type RecurrenceOutcome = RecurrenceSuccessor | "invalid" | undefined

type TaskCatalogOptions = {
  query?: string
  status?: string
  priority?: number
  assignedTo?: string
  taskKind?: string
  includeCompleted?: boolean
  includeArchived?: boolean
  fields?: readonly string[]
  sort?: "relevance" | "updated"
  limit?: number
}

export type TaskCatalogRow = Pick<TaskRow, "id" | "ticket_number" | "title" | "status" | "priority" | "task_kind" | "deferred_at"> & {
  ticket_ref: string | null
  score: number
  id_hit?: number
  exact_id?: number
  title_at?: number
  description_hit?: number
  labels_hit?: number
  custom_fields_hit?: number
  comments_hit?: number
  excerpt?: string | null
}

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Typed task row — maps every column in the `tasks` table.
 *
 * The index signature `[key: string]: unknown` is kept intentionally so
 * existing `as TaskRow` casts from libSQL's generic `Row` type still compile,
 * while all known fields now provide autocompletion and type-safe access.
 *
 * @see store.ts ensureSchema() for the canonical column definitions.
 */
export interface TaskRow {
  /** Internal public-projection metadata; physical planning references remain authoritative. */
  readonly public_area_id?: string | null
  readonly public_project_id?: string | null
  readonly public_goal_id?: string | null
  readonly public_parent_id?: string | null

  [key: string]: unknown
  // ── Core (CREATE TABLE) ──
  id: string
  endeavor_id: string | null
  title: string
  description: string | null
  status: string
  framework_payload: string
  calendar_sync_state: string
  idempotency_key: string
  request_id: string
  created_at: number
  updated_at: number
  task_version?: number
  deferred_at: number | null
  deferral_revision: string | null
  // ── Phase 2 additions ──
  priority: number
  due_date: string | null
  labels: string
  parent_id: string | null
  time_tracked: number
  area_id: string | null
  custom_fields: string
  start_date: string | null
  end_date: string | null
  progress: number
  color: string | null
  is_promoted: number
  task_type: string
  summary: string | null
  // ── Phase 3 (recurrence, checklists, NFC) ──
  recurrence_rule: string | null
  recurrence_anchor: string
  rotation_mode: string | null
  nfc_tag_id: string | null
  checklists: string | null
  reminder_at: string | null
  source_template_id: string | null
  routine_occurrence?: number
  ticket_number: number | null
  ticket_key?: string | null
  ticket_ref?: string | null
  assigned_to: string | null
  kanban_position: number | null
  // ── Phase 4 (DDD hierarchy + human-agent) ──
  task_kind: string
  project_id: string | null
  goal_id: string | null
  owner: string
  lock_holder: string | null
  lock_expires_at: number | null
  handoff_state: string
  proposal_json: string | null
  proposal_hash: string | null
  agent_scratchpad: string | null
  // ── Phase 6 (time-blocking) ──
  time_block_start: string | null
  time_block_end: string | null
  // ── Phase 6 (Eisenhower matrix) ──
  urgency: number
  importance: number
  eisenhower_override: number
  // ── Phase 7 (extended planning) ──
  effort_minutes: number | null
  effort_type: string | null
  blocked_by: string | null
}

export interface ReassignmentReplayState {
  receipt: { status: string; response_payload: string | null; updated_at: number } | null
  ownedByOtherToken: boolean
  lastReassignment: {
    old_value: string | null
    new_value: string | null
    actor: string
    actor_type: string
    correlation_id: string | null
    created_at: number
  } | null
}

/**
 * Strip agent_scratchpad from task rows before returning to callers.
 * The scratchpad is ephemeral bot working data that must NEVER appear in API responses.
 */
function sanitizeRows(rows: TaskRow[]): TaskRow[] {
  return rows.map(row => {
    const { agent_scratchpad: _, ...rest } = row
    return rest as unknown as TaskRow
  })
}

function cloneRecurringChecklist(checklists: string | null): string {
  if (!checklists) return "[]"
  let input: unknown
  try {
    input = JSON.parse(checklists)
  } catch {
    return "[]"
  }
  if (!Array.isArray(input)) return "[]"

  const steps: Array<{ text: string; id?: string }> = []
  for (const row of input) {
    if (typeof row === "string") {
      steps.push({ text: row })
    } else if (row && typeof row.text === "string") {
      const id = typeof row.id === "string" && row.id.trim() ? row.id : undefined
      steps.push(id ? { text: row.text, id } : { text: row.text })
    }
  }
  const reserved = new Set(steps.map(step => step.id))
  const assigned = new Set<string>()
  return JSON.stringify(steps.map(({ text, id }) => {
    if (!id || assigned.has(id)) {
      do {
        id = crypto.randomUUID()
      } while (reserved.has(id))
      reserved.add(id)
    }
    assigned.add(id)
    return { id, text, done: false }
  }))
}

/** Status count for dashboard statistics */
export interface StatusCount {
  status: string;
  count: number;
}

/** Dashboard statistics aggregate */
export interface DashboardStats {
  total: number;
  open: number;
  active: number;
  completed: number;
  overdue: number;
}

/** Area metadata */
export interface AreaInfo {
  id: string;
  name: string;
  color: string;
}

export type CalendarFilterRow = Pick<TaskRow,
  "status" | "title" | "priority" | "task_type" | "task_kind" | "area_id" | "assigned_to" |
  "is_promoted" | "labels" | "due_date" | "start_date" | "end_date" | "deferred_at" | "framework_payload"> & { project_id?: string | null }

function taskMatchesDateWindow(row: TaskRow, startDate: string, endDate: string, timezone: string): boolean {
  if (row.task_kind === "calendar_event" && typeof row.start_date === "string" && row.start_date.trim()) {
    const startRaw = row.start_date.trim()
    const startDay = calendarEventDay(startRaw, timezone, "start") ?? calendarDayFromInput(startRaw, timezone)
    if (!startDay) return false
    let endDay = startDay
    if (typeof row.end_date === "string" && row.end_date.trim()) {
      const endRaw = row.end_date.trim()
      const boundary = row.calendar_sync_state === "synced" || !/^\d{4}-\d{2}-\d{2}$/.test(endRaw) ? "exclusive-end" : "start"
      const parsedEnd = calendarEventDay(endRaw, timezone, boundary) ?? calendarDayFromInput(endRaw, timezone)
      if (parsedEnd && parsedEnd >= startDay) endDay = parsedEnd
    }
    return startDay <= endDate && endDay >= startDate
  }
  const day = calendarDayFromInput(effectiveTaskScheduledDate(row), timezone)
  return day !== null && day >= startDate && day <= endDate
}

function toWallEpochMs(raw: string): number {
  const trimmed = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return Date.parse(`${trimmed}T00:00:00.000Z`)
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(trimmed)) {
    return Date.parse(`${trimmed.replace(" ", "T")}Z`)
  }
  return Date.parse(trimmed)
}

function shiftEventWindow(nextDay: string, sourceStart: string | null | undefined, sourceEnd: string | null | undefined): {
  start_date: string | null
  end_date: string | null
} {
  if (typeof sourceStart !== "string" || !sourceStart.trim()) {
    return { start_date: null, end_date: null }
  }
  const startTrimmed = sourceStart.trim()
  const match = startTrimmed.match(/^(\d{4}-\d{2}-\d{2})([T ].*)?$/)
  const nextStart = match ? `${nextDay}${match[2] ?? ""}` : nextDay
  if (typeof sourceEnd !== "string" || !sourceEnd.trim()) {
    return { start_date: nextStart, end_date: null }
  }
  const endTrimmed = sourceEnd.trim()
  const startMs = toWallEpochMs(startTrimmed)
  const endMs = toWallEpochMs(endTrimmed)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return { start_date: nextStart, end_date: null }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(startTrimmed) && /^\d{4}-\d{2}-\d{2}$/.test(endTrimmed)) {
    const daySpan = Math.round((endMs - startMs) / 86_400_000)
    return { start_date: nextStart, end_date: shiftCalendarDay(nextDay, daySpan) }
  }
  const durationMs = endMs - startMs
  const nextStartMs = toWallEpochMs(nextStart)
  const shiftedIso = new Date(nextStartMs + durationMs).toISOString()
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(endTrimmed)) {
    return { start_date: nextStart, end_date: shiftedIso }
  }
  const len = Math.min(23, Math.max(16, endTrimmed.length))
  return { start_date: nextStart, end_date: shiftedIso.slice(0, len) }
}

const CALENDAR_ITEM_DATE = "CASE WHEN task_kind = 'calendar_event' THEN COALESCE(NULLIF(start_date, ''), NULLIF(due_date, ''), NULLIF(end_date, '')) ELSE due_date END"
const CALENDAR_LOCAL_ITEM = "(task_kind IS NOT 'calendar_event' OR calendar_sync_state IS NOT 'synced')"

/** Calendar day task aggregate */
export interface CalendarDayInfo {
  dueDate: string;
  count: number;
  colors: string[];
  scheduledEvents: number;
  haEvents: number;
}

interface LinkedCalendarEvent {
  id: string
  title: string
  start: string
  entity: string | null
  uid: string | null
  providerSummary: string | null
}

/** Kanban lane definition */
export interface KanbanLane {
  id: string;
  key: string;
  label: string;
  icon: string;
  color?: string | null;
  includes: string[];
  builtIn: boolean;
  wipLimit: number;
}

/** Narrow projection used to filter and count all eligible cards before pagination. */
export type KanbanIndexRow = Pick<TaskRow, "id" | "status" | "priority" | "task_type" | "task_kind" | "area_id" | "assigned_to" | "is_promoted"> &
  Partial<Pick<TaskRow, "title" | "labels">> & { overdue?: number; description_matches?: number }

/** Setting key-value pair */
export interface SettingRow {
  key: string;
  value: string;
}

// ── Repository ─────────────────────────────────────────────────────────────

type TaskBlocker = Pick<TaskRow, "id" | "title" | "status" | "ticket_number">
type DeferralState = Pick<TaskRow, "id" | "status" | "deferred_at" | "deferral_revision" | "updated_at">
type DeferralDiagnostic = DeferralState & { assigned_to?: string | null }

type DeferralResult =
  | { ok: true; task: DeferralState }
  | { ok: false; errorCode: "unavailable" | "terminal" | "ineligible" | "assignee_mismatch" }
  | { ok: false; errorCode: "conflict"; task: DeferralState }
  | { ok: false; errorCode: "blocked"; blockers: TaskBlocker[] }

/**
 * Centralized repository for task-related database queries.
 * Replaces inline SQL in Astro page files to enforce DDD boundaries.
 *
 * Design decisions:
 * - Returns raw `TaskRow[]` to avoid coupling to specific page needs.
 * - Uses parameterized queries to prevent SQL injection.
 * - Each method maps 1:1 to a query previously inline in a page file.
 * - Stateless: client injected via constructor (follows existing store pattern).
 */
export type TaskCreationData = {
  id: string; title: string; description: string; status: string;
  priority: number; due_date: string | null; labels: string;
  framework_payload: string; parent_id: string | null;
  area_id: string | null; custom_fields: string; project_id?: string | null; goal_id?: string | null; start_date: string | null;
  end_date: string | null; progress: number; color: string | null;
  is_promoted?: number; task_type: string; task_kind?: string;
  assigned_to: string | null; checklists?: string | null;
  recurrence_rule?: string | null;
  urgency?: number; importance?: number;
  effort_minutes?: number | null; effort_type?: string | null; blocked_by?: string | null;
  source?: string; created_by?: string | null;
}

const planningProjection = (table: "areas" | "projects", column: string) => `CASE WHEN EXISTS (
  SELECT 1 FROM scoped_${table} AS linked WHERE linked.id = ${column} AND linked.retired_at IS NULL
) THEN ${column} ELSE NULL END`

export type DeleteWorkResult = { ok: true, id: string, eventId: string } | { ok: false, errorCode: "unavailable" | "conflict" }

export type WorkCreateMetadata = {
  assignmentProof?: AssignmentProof | undefined
  integrationContext?: IntegrationScope
  recurrenceSource?: { taskId: string, rule: string, version: number }
  laneId?: string
  deriveStatusFromLane?: boolean
  routineOccurrence?: { templateId: string, period: string, expectedTemplateJson: string, expectedCadence: string, complete?: boolean, timezone?: string }
  templateSnapshot?: { templateId: string, expectedTemplateJson: string }
  captureAttemptDigest?: string
  clientIdempotencyKey?: string
  requestId?: string
  activityActor?: RecentTaskActor
  newLabels?: string[]
  homeLocation?: { id: string | null, revision: string }
  signal?: AbortSignal
}
export type WorkCreateResult = { ok: true, task: TaskRow, ticketNumber: number, replayed: boolean, newlyCompleted: boolean } |
  { ok: false, errorCode: "unavailable" | "invalid" | "denied" | "capture_conflict" | "conflict" | "legacy_key_owner_unverified" | "hierarchy_invalid", message?: string }

/** Internal statement: the common command owns authorization, allocation and atomic effects. */
export function taskInsertStatement(scope: BoardScope, data: TaskCreationData, createdAt: number, {
  ticketNumber, ticketKey, laneId, owner = "human", idempotencyKey = crypto.randomUUID(), requestId = crypto.randomUUID(),
  clientIdempotencyKey = null, operationOwner = null, operationDigest = null, captureAttemptDigest = null, sourceTemplateId = null, guard,
}: {
  ticketNumber: number, ticketKey: string, laneId: string, owner?: string,
  idempotencyKey?: string, requestId?: string,
  clientIdempotencyKey?: string | null, operationOwner?: string | null, operationDigest?: string | null,
  sourceTemplateId?: string | null, captureAttemptDigest?: string | null, guard?: { sql: string, args: InValue[] },
}): InStatement {
  requireBoardScope(scope)
  const scoped = storageBoardId(scope) !== null
  const values: InValue[] = [
    data.id, data.title, data.description, normalizeStatus(data.status), data.priority, data.due_date, data.labels,
    data.framework_payload, STATUS.PENDING, data.parent_id, 0,
    scoped ? null : data.project_id ?? null, scoped ? null : data.goal_id ?? null,
    scoped ? "__meitheal_no_area__" : data.area_id ?? "__meitheal_no_area__", data.custom_fields,
    data.start_date, data.end_date, data.progress, data.color, data.is_promoted ?? 0,
    data.task_type, data.task_kind ?? "standard_action", scoped ? null : ticketNumber, data.assigned_to,
    data.checklists ?? "[]", data.recurrence_rule ?? null, data.urgency ?? 0, data.importance ?? 0,
    data.effort_minutes ?? null, data.effort_type ?? null, data.blocked_by ?? null,
    scope.principal.kind === "agent" ? "agent" : scope.principal.kind === "service" ? "automation" : "user", scope.principal.id,
    idempotencyKey, requestId, createdAt, createdAt, storageBoardId(scope), scoped ? laneId : null, scoped ? ticketKey : null,
    clientIdempotencyKey, operationOwner, operationDigest, captureAttemptDigest, sourceTemplateId, owner,
  ]
  return sql`INSERT INTO tasks (id, title, description, status, priority, due_date, labels,
    framework_payload, calendar_sync_state, parent_id, time_tracked, project_id, goal_id,
    area_id, custom_fields, start_date, end_date, progress, color, is_promoted,
    task_type, task_kind, ticket_number, assigned_to, checklists, recurrence_rule,
    urgency, importance, effort_minutes, effort_type, blocked_by, source, created_by,
    idempotency_key, request_id, created_at, updated_at, task_board_id, board_column_id, ticket_ref,
    client_idempotency_key, operation_owner, operation_digest, capture_attempt_digest, source_template_id, owner)
    SELECT ${joinSql(values.map(value => sql`${value}`))}
    WHERE ${guard ? sourceSql(guard.sql, guard.args) : sourceSql("1")}
    RETURNING id`
}

export type ExternalSyncLookup =
  | { source: "ha_todo"; entityId: string; externalIds: string[] }
  | { source: "calendar"; entityId: string; externalIds: string[] }
  | { source: "grocy"; grocyEntityType: "chore" | "task" | "shopping"; externalIds: string[] }

export interface ExternalSyncMatch {
  confirmationId: string
  taskId: string
  externalId: string
  syncUpdatedAt: number
  taskDeleted?: boolean
  suppressed?: boolean
  taskUpdatedAt: number
  /** The payload the last sync stored, for calendar confirmations. */
  payload?: string | null | undefined
}

export type SyncConfirmationTarget =
  | {
      source: "ha_todo"
      entityId: string
      externalId: string
      confirmationId?: string | undefined
      syncDirection?: "inbound" | "outbound" | undefined
      payload: string
    }
  | {
      source: "calendar"
      entityId: string
      externalId: string
      previousExternalId?: string | undefined
      confirmationId?: string | undefined
      confirmationSource?: string | undefined
      payload: string
    }
  | {
      source: "grocy"
      grocyEntityType: "chore" | "task" | "shopping"
      externalId: string
      confirmationId?: string | undefined
      syncDirection?: "inbound" | "outbound" | undefined
      payload: string
    }

interface SyncCalendarLinkRelease {
  confirmationId: string
  taskId: string
  externalId: string
  completeIfStatus?: string | undefined
}

export type SyncTaskMutation = (
  | {
      kind: "create"
      taskId?: string | undefined
      requestId?: string | undefined
      idempotencyKey: string
      title: string
      description?: string | null | undefined
      status?: string | undefined
      priority?: number | undefined
      dueDate?: string | null | undefined
      startDate?: string | null | undefined
      endDate?: string | null | undefined
      recurrenceRule?: string | null | undefined
      labels?: string[] | string | undefined
      areaId?: string | undefined
      taskType?: string | undefined
      taskKind?: string | undefined
      createdAt?: number | undefined
      confirmation: SyncConfirmationTarget
    }
  | {
      kind: "update"
      taskId: string
      title?: string | undefined
      description?: string | null | undefined
      replaceDescription?: boolean | undefined
      status?: string | undefined
      openEcho?: boolean | undefined
      dueDate?: string | null | undefined
      updateDueDate?: boolean | undefined
      startDate?: string | null | undefined
      endDate?: string | null | undefined
      recurrenceRule?: string | null | undefined
      /** Write recurrenceRule as given, so null clears it. Otherwise null keeps the stored rule. */
      replaceRecurrenceRule?: boolean | undefined
      taskKind?: string | undefined
      areaId?: string | undefined
      ensureCalendarSyncLabel?: boolean | undefined
      /**
       * Values the planner read before committing. When given, each planned field is written
       * only if the stored value still equals the one it was planned from, so an edit saved
       * after the snapshot read is not overwritten by the sync.
       */
      expected?: Partial<Record<"title" | "status" | "dueDate" | "startDate" | "endDate" | "recurrenceRule" | "taskKind", string | number | bigint | null>> | undefined
      updatedAt?: number | undefined
      confirmation?: (SyncConfirmationTarget & { requireUnmodifiedSinceSync?: boolean | undefined }) | undefined
    }
  | {
      kind: "link"
      taskId: string
      requestId?: string | undefined
      createdAt?: number | undefined
      confirmation: SyncConfirmationTarget
    }
) & { replacedCalendarLinks?: SyncCalendarLinkRelease[] | undefined }

export interface SyncChunkItemError {
  index: number
  message: string
}

export interface SyncChunkCommitResult {
  created: number
  updated: number
  linked: number
  skipped: number
  chunksCommitted: number
  ticketNumbers: number[]
  errors: SyncChunkItemError[]
}

const CALENDAR_FILTER_COLUMNS = `status, title, priority, task_type, task_kind,
  tasks.public_area_id AS area_id, tasks.public_project_id AS project_id, assigned_to, is_promoted, labels, start_date, end_date, deferred_at, framework_payload`

const ASC_DEFAULT_SORTS = new Set([
  "priority",
  "due_date",
  "title",
  "status",
  "kanban_position",
  "table_position",
])

/** Default sort direction by field when caller omits explicit `order`. */
export function defaultTaskSortOrder(sort: string): "ASC" | "DESC" {
  return ASC_DEFAULT_SORTS.has(sort) ? "ASC" : "DESC"
}

export class TaskRepository {
  private readonly client: Client

  constructor(client: Client, private readonly scope: BoardScope) {
    requireBoardScope(scope)
    this.client = guardClientContinuity(client)
  }

  private normalizeTaskRows(rows: readonly unknown[]): TaskRow[] {
    return rows.map(value => {
      const row = value as TaskRow
      const key = typeof row.ticket_ref === "string" ? row.ticket_ref : row.ticket_number == null ? null : `${scopeBoardAccess(this.scope).ticketPrefix}-${row.ticket_number}`
      return { ...row, ticket_ref: key, ticket_key: key }
    })
  }

  private async effectiveTaskPlacement(reader: Pick<Client, "execute">, task: Record<string, unknown>) {
    let areaId = typeof task.area_id === "string" ? task.area_id : null
    const projectId = typeof task.project_id === "string" ? task.project_id : null
    if (projectId) {
      const { rows: [project] } = await reader.execute(sql`SELECT area_id FROM projects WHERE id = ${projectId} AND ${ownedPlanning(this.scope, "projects")}`)
      if (typeof project?.area_id === "string") areaId = project.area_id
    }
    return { areaId, projectId }
  }

  private forOperation(action: WorkAction, taskIds: readonly string[] = []): Client {
    return boardOperationClient(this.client, this.scope, { resource: "task", action }, taskIds)
  }

  /** Command preflight retains its write capability/ceiling, but never acquires
   * a SQLite writer for a SELECT. Mutation authorization is repeated by the
   * command's actual signal-aware writer. Publication still checks live scope. */
  private async readCommandStatement(action: WorkAction, statement: InStatement, taskIds: readonly string[] = []): Promise<ResultSet> {
    const [result] = await this.forOperation(action, taskIds).batch([statement], "read")
    return result!
  }

  // ── Dashboard (index.astro) ─────────────────────────────────────────

  /** Recent tasks for dashboard hero section */
  async getRecentTasks(limit = 10, placement?: TaskReadPlacement): Promise<TaskRow[]> {
    const context = taskReadPlacement(placement)
    const result = await this.forOperation("read").execute(
      scopedTaskRead(this.scope, sourceSql(`SELECT id, title, description, status, priority, due_date, labels, calendar_sync_state, is_promoted, area_id, public_area_id, public_project_id, public_goal_id, color, ticket_number, task_type, task_kind, project_id, owner, handoff_state, created_at, updated_at, deferred_at
       FROM scoped_tasks AS tasks WHERE ${context.sql} AND status <> 'archived' ORDER BY created_at DESC LIMIT ${limit}`, context.args), "select"),
    );
    return this.normalizeTaskRows(result.rows);
  }

  /** Tasks belonging to a specific project, ordered by priority */
  async findByProjectId(projectId: string): Promise<TaskRow[]> {
    const result = await this.forOperation("read").execute(scopedTaskRead(this.scope, sourceSql("SELECT id, title, description, status, priority, due_date, labels, is_promoted, area_id, public_area_id, public_project_id, public_goal_id, color, ticket_number, task_type, task_kind, project_id, owner, handoff_state, assigned_to, progress, created_at, updated_at, deferred_at\n            FROM scoped_tasks AS tasks WHERE 1 AND project_id = ?\n            ORDER BY priority ASC, created_at DESC", [projectId]), "select"));
    return sanitizeRows(this.normalizeTaskRows(result.rows));
  }

  /** Aggregate total and completed task counts grouped by project_id (replaces N+1 findByProjectId loops). */
  async getProjectTaskCounts(): Promise<Map<string, { total: number; completed: number }>> {
    const result = await this.forOperation("read").execute(
      scopedTaskRead(this.scope, sourceSql("SELECT project_id,\n              COUNT(*) AS total,\n              COUNT(*) FILTER (WHERE status = 'complete') AS completed\n       FROM scoped_tasks AS tasks\n       WHERE 1 AND project_id IS NOT NULL\n       GROUP BY project_id"), "select"),
    )
    const counts = new Map<string, { total: number; completed: number }>()
    for (const row of result.rows) {
      const r = row as Record<string, unknown>
      if (r.project_id != null) {
        counts.set(String(r.project_id), {
          total: Number(r.total ?? 0),
          completed: Number(r.completed ?? 0),
        })
      }
    }
    return counts
  }

  /** Promoted open tasks */
  async getPromotedTasks(limit = 5, placement?: TaskReadPlacement): Promise<TaskRow[]> {
    const context = taskReadPlacement(placement)
    const result = await this.forOperation("read").execute(scopedTaskRead(this.scope, sourceSql(`SELECT id, title, status, priority, due_date, is_promoted, color, ticket_number, ticket_ref
            FROM scoped_tasks AS tasks WHERE ${context.sql} AND is_promoted = 1 AND ${openStatusPredicate} AND deferred_at IS NULL
            ORDER BY updated_at DESC LIMIT ${limit}`, [...context.args, ...CLOSED_TASK_STATUSES]), "select"));
    return this.normalizeTaskRows(result.rows);
  }

  /** Open tasks ordered by priority then due date */
  async getOpenTasks(limit = 15, placement?: TaskReadPlacement): Promise<TaskRow[]> {
    const context = taskReadPlacement(placement)
    const result = await this.forOperation("read").execute(scopedTaskRead(this.scope, sourceSql(`SELECT id, title, status, priority, due_date, assigned_to, area_id, public_area_id, public_project_id, public_goal_id, ticket_number, task_type, task_kind, project_id, owner, handoff_state, color
            FROM scoped_tasks AS tasks WHERE ${context.sql} AND ${openStatusPredicate} AND deferred_at IS NULL
            ORDER BY priority ASC, due_date ASC NULLS LAST, updated_at DESC
            LIMIT ${limit}`, [...context.args, ...CLOSED_TASK_STATUSES]), "select"));
    return this.normalizeTaskRows(result.rows);
  }

  /** Count tasks grouped by status for dashboard stats */
  async getStatusCounts(placement?: TaskReadPlacement): Promise<DashboardStats> {
    const context = taskReadPlacement(placement)
    const result = await this.forOperation("read").execute(
      scopedTaskRead(this.scope, sourceSql(`SELECT status, COUNT(*) AS cnt, COUNT(*) FILTER (WHERE deferred_at IS NULL) AS open_count FROM scoped_tasks AS tasks WHERE ${context.sql} AND status <> 'archived' GROUP BY status`, context.args), "select"),
    );
    const stats: DashboardStats = { total: 0, open: 0, active: 0, completed: 0, overdue: 0 };
    for (const row of result.rows) {
      const r = row as Record<string, unknown>;
      const s = normalizeStatus(String(r.status));
      const c = Number(r.cnt);
      const open = Number(r.open_count)
      stats.total += c;
      if (s === STATUS.ACTIVE) stats.active += open
      if (s === STATUS.COMPLETE) stats.completed += c;
      else if (!isClosedStatus(s)) stats.open += open
    }
    return stats;
  }

  /** Count open tasks past due. Pass today's YYYY-MM-DD in the user's timezone. */
  async getOverdueCount(today?: string, timezone = "Europe/Dublin", placement?: TaskReadPlacement): Promise<number> {
    const resolvedToday = today ?? calendarToday(timezone);
    const upperBound = shiftCalendarDay(resolvedToday, 2);
    const context = taskReadPlacement(placement)
    const result = await this.forOperation("read").execute(scopedTaskRead(this.scope, sourceSql(`SELECT task_kind, due_date, start_date, end_date, calendar_sync_state FROM scoped_tasks AS tasks
            WHERE ${context.sql} AND ${CALENDAR_ITEM_DATE} IS NOT NULL AND ${CALENDAR_ITEM_DATE} <> ''
              AND substr(${CALENDAR_ITEM_DATE}, 1, 10) < ?
              AND ${openStatusPredicate}
              AND deferred_at IS NULL`, [...context.args, upperBound, ...CLOSED_TASK_STATUSES]), "select"));
    let count = 0;
    for (const row of result.rows) {
      const r = row as Record<string, unknown>;
      if (isTaskOverdue({
        task_kind: r.task_kind ? String(r.task_kind) : null,
        due_date: r.due_date ? String(r.due_date) : null,
        start_date: r.start_date ? String(r.start_date) : null,
        end_date: r.end_date ? String(r.end_date) : null,
        calendar_sync_state: r.calendar_sync_state ? String(r.calendar_sync_state) : null,
      }, false, timezone, resolvedToday)) count++;
    }
    return count;
  }

  /** All boards (for card badges on dashboard) */
  async getAreas(): Promise<Record<string, AreaInfo>> {
    const result = await this.forOperation("read").execute(scopedTaskRead(this.scope, sourceSql("SELECT id, name, color FROM scoped_areas AS areas WHERE 1 AND retired_at IS NULL"), "select"));
    const areaMap: Record<string, AreaInfo> = {};
    for (const b of result.rows) {
      const br = b as Record<string, unknown>;
      areaMap[String(br.id)] = {
        id: String(br.id),
        name: String(br.name ?? "Default"),
        color: String(br.color ?? "#6366F1"),
      };
    }
    return areaMap;
  }

  // ── Kanban (kanban.astro) ───────────────────────────────────────────

  async withKanbanRead<T>(read: (reader: Pick<Client, "execute">) => Promise<T>): Promise<T> {
    const snapshot = await this.forOperation("read").transaction("read")
    try {
      const result = await read(snapshot)
      await snapshot.commit()
      return result
    } finally {
      snapshot.close()
    }
  }

  private async readFromSnapshot(reader: Pick<Client, "execute">, statement: InStatement): Promise<ResultSet> {
    const admitted = await validateBoardScope(this.scope, reader, { resource: "task", action: "read" })
    if (!admitted.ok) throw new BoardOperationError(admitted.errorCode)
    const result = await reader.execute(statement)
    const current = await validateBoardScope(this.scope, this.client, { resource: "task", action: "read" })
    if (!current.ok) throw new BoardOperationError(current.errorCode)
    return result
  }

  /** Readable Epic ancestry can extend outside the current lane and filters. */
  async getBoardEpicLinks(reader: Pick<Client, "execute">): Promise<TaskEpicLink[]> {
    const result = await this.readFromSnapshot(reader,
      scopedTaskRead(this.scope, sql`SELECT id, public_parent_id AS parent_id, task_type,
              CASE WHEN task_type = 'epic' THEN title END AS title,
              CASE WHEN task_type = 'epic' THEN ticket_number END AS ticket_number,
              CASE WHEN task_type = 'epic' THEN ticket_ref END AS ticket_key
       FROM scoped_tasks AS tasks WHERE 1`, "select"),
    )
    return result.rows as unknown as TaskEpicLink[]
  }

  /** Ordered, narrow scan for lane counts and matching before loading card details. */
  async getKanbanIndex(
    statuses: string[],
    cutoff: number,
    { matchText, matchOverdue, search, today, timezone = "Europe/Dublin", location, projectId }: {
      projectId?: string | undefined
      matchText: boolean
      search?: string | undefined
      matchOverdue: boolean
      today?: string | undefined
      timezone?: string | undefined
      location?: HomeAssistantAreaFilter | undefined
    },
    reader: Pick<Client, "execute">,
  ): Promise<KanbanIndexRow[]> {
    if (!statuses.length) return []
    const resolvedToday = today ?? calendarToday(timezone)
    const filter = location ? homeAssistantTaskAreaCondition(location) : null
    const result = await this.readFromSnapshot(reader,scopedTaskRead(this.scope, sourceSql(`SELECT id, status, priority, task_type, task_kind, public_area_id AS area_id, assigned_to, is_promoted
                  ${matchText ? ", title, labels" : ""}
                  ${search ? ", CASE WHEN instr(lower(COALESCE(description, '')), lower(?)) > 0 THEN 1 ELSE 0 END AS description_matches" : ""}
                  ${matchOverdue ? `, due_date, start_date, end_date, calendar_sync_state` : ""}
            FROM scoped_tasks AS tasks
            WHERE 1 AND status IN (SELECT value FROM json_each(?))
              AND deferred_at IS NULL
              ${filter ? "AND " + filter.sql : ""}
              ${projectId ? "AND project_id = ? AND EXISTS (SELECT 1 FROM scoped_projects AS projects WHERE projects.id = tasks.project_id AND projects.retired_at IS NULL)" : ""}
              AND (? = 0 OR lower(status) != 'complete' OR updated_at >= ?)
            ORDER BY is_promoted DESC, kanban_position ASC NULLS LAST, priority ASC, created_at DESC, id ASC`, [...(search ? [search] : []), JSON.stringify(statuses), ...(filter?.args ?? []), ...(projectId ? [projectId] : []), cutoff, cutoff]), "select"))
    const rows = result.rows as unknown as (KanbanIndexRow & { description_matches?: number })[]
    if (!matchOverdue) return rows
    return (result.rows as unknown as (KanbanIndexRow & { due_date?: string | null; start_date?: string | null; end_date?: string | null; calendar_sync_state?: string | null })[]).map(({ due_date, start_date, end_date, calendar_sync_state, ...row }) => ({
      ...row,
      overdue: !isClosedStatus(row.status) && isTaskOverdue({
        task_kind: row.task_kind ? String(row.task_kind) : null,
        due_date: due_date ? String(due_date) : null,
        start_date: start_date ? String(start_date) : null,
        end_date: end_date ? String(end_date) : null,
        calendar_sync_state: calendar_sync_state ? String(calendar_sync_state) : null,
      }, false, timezone, resolvedToday) ? 1 : 0,
    }))
  }

  /** Load full cards and their indexed counts only for the rendered pages. */
  async getKanbanCards(ids: string[], cutoff: number, reader: Pick<Client, "execute">): Promise<Array<TaskRow & { project_assigned: number }>> {
    if (!ids.length) return []
    const result = await this.readFromSnapshot(reader,scopedTaskRead(this.scope, sourceSql(`SELECT task.id, task.title, task.description, task.status, task.priority, task.due_date,
                   task.labels, task.framework_payload, task.calendar_sync_state, task.area_id, task.public_area_id, task.public_project_id, task.public_goal_id,
                   task.custom_fields, task.progress, task.color, task.is_promoted, task.task_type,
                   task.task_kind,
                   (SELECT project.id FROM scoped_projects AS project WHERE project.id = task.project_id
                     AND 1 AND project.retired_at IS NULL) AS project_id,
                   CASE WHEN task.project_id IS NOT NULL AND task.project_id <> '' THEN 1 ELSE 0 END AS project_assigned,
                   task.owner, task.handoff_state, task.ticket_number, task.ticket_ref, task.ticket_ref AS ticket_key,
                   task.assigned_to, task.recurrence_rule, task.checklists,
                   task.urgency, task.importance, task.eisenhower_override,
                   task.effort_minutes, task.effort_type, task.blocked_by, task.nfc_tag_id, task.kanban_position,
                   task.deferred_at, task.deferral_revision, ${taskTimestampMs("task.updated_at")} AS task_version,
                   (SELECT COUNT(*) FROM comments WHERE task_id = task.id) AS comment_count,
                   (SELECT COUNT(*) FROM scoped_tasks AS child WHERE child.parent_id = task.id AND 1
                      AND (? = 0 OR lower(child.status) != 'complete' OR child.updated_at >= ?)) AS child_count
            FROM json_each(?) AS wanted JOIN scoped_tasks AS task ON task.id = wanted.value
            WHERE 1 AND task.deferred_at IS NULL`, [cutoff, cutoff, JSON.stringify(ids)]), "select"))
    return result.rows.map(value => {
      const row = value as unknown as TaskRow & { project_assigned: number }
      return { ...row, area_id: row.public_area_id ?? null, project_id: row.public_project_id ?? null }
    })
  }

  /** Kanban lane definitions ordered by position */
  async getKanbanLanes(): Promise<KanbanLane[]> {
    const result = await this.forOperation("read").execute(
      scopedTaskRead(this.scope, sourceSql(`SELECT id, key, label, icon, color, position, wip_limit, includes, built_in FROM kanban_lanes
       WHERE board_id = ? ORDER BY position ASC, id ASC`, [this.scope.boardId])),
    );
    return result.rows.map((r: Record<string, unknown>) => ({
      id: String(r.id),
      key: String(r.key),
      label: String(r.label),
      icon: String(r.icon),
      color: typeof r.color === "string" && /^#[0-9a-fA-F]{6}$/.test(r.color) ? r.color : null,
      includes: JSON.parse(String(r.includes ?? "[]")),
      builtIn: Number(r.built_in ?? 0) === 1,
      wipLimit: Number(r.wip_limit ?? 0),
    }));
  }

  /** Get settings by keys (e.g. completed_auto_hide_days, backlog_mode) */
  async getSettings(keys: string[]): Promise<Record<string, string>> {
    const placeholders = keys.map(() => "?").join(", ");
    const result = await this.forOperation("read").execute(scopedTaskRead(this.scope, sourceSql(`SELECT key, value FROM settings WHERE key IN (${placeholders})`, keys), "select"));
    const settings: Record<string, string> = {};
    for (const row of result.rows) {
      const r = row as Record<string, unknown>;
      settings[String(r.key)] = String(r.value);
    }
    return settings;
  }

  // ── Calendar (calendar.astro) ───────────────────────────────────────

  /** Reminder observation uses the same Board/task audiences as every other view. */
  async findDueReminderTasks(now: number, windowEnd: number) {
    if (!Number.isFinite(now) || !Number.isFinite(windowEnd) || now < 0 || windowEnd < now) return []
    const due = sourceSql(`CASE WHEN due_date NOT GLOB '*[^0-9]*' AND length(due_date) >= 12 THEN CAST(due_date AS INTEGER)
      ELSE CAST(ROUND((julianday(due_date) - 2440587.5) * 86400000) AS INTEGER) END`)
    const result = await this.forOperation("read").execute(scopedTaskRead(this.scope, sql`SELECT id, title, due_date, priority,
      ticket_ref AS ticket_key, assigned_to, status, ${due} AS due_ms, ${sourceSql(taskTimestampMs("updated_at"))} AS task_version
      FROM scoped_tasks WHERE deferred_at IS NULL AND lower(status) NOT IN (${joinSql(CLOSED_TASK_STATUSES.map(status => sql`${status}`))})
        AND due_date IS NOT NULL AND due_date <> '' AND (
          due_date BETWEEN ${new Date(now - 86400000).toISOString()} AND ${new Date(windowEnd + 86400000).toISOString()}
          OR due_date BETWEEN ${String(now)} AND ${String(windowEnd)})
        AND ${due} BETWEEN ${now} AND ${windowEnd} ORDER BY due_ms, id LIMIT 100`))
    return result.rows.map(row => ({ id: String(row.id), title: String(row.title), due_date: String(row.due_date),
      priority: Number(row.priority), ticket_key: String(row.ticket_key), assigned_to: row.assigned_to == null ? null : String(row.assigned_to),
      status: String(row.status), due_ms: Number(row.due_ms), task_version: Number(row.task_version) }))
  }

  /** Local tasks and scheduled event starts per day for a given month. */
  async getCalendarTaskCounts(
    monthStart: string,
    monthEnd: string,
    timezone = "Europe/Dublin",
    options: { matches?: ((task: CalendarFilterRow) => boolean) | undefined; includeCompleted?: boolean } = {},
  ): Promise<Record<string, CalendarDayInfo>> {
    const lowerBound = shiftCalendarDay(monthStart, -2);
    const upperBound = shiftCalendarDay(monthEnd, 2);
    const result = await this.forOperation("read").execute(scopedTaskRead(this.scope, sourceSql(`SELECT ${CALENDAR_ITEM_DATE} AS calendar_date, due_date, color, calendar_sync_state, ${options.matches ? CALENDAR_FILTER_COLUMNS : "status, task_kind, start_date, end_date"}
            FROM scoped_tasks AS tasks
            WHERE 1 AND ${CALENDAR_LOCAL_ITEM} AND status <> 'archived'
              AND (
                substr(${CALENDAR_ITEM_DATE}, 1, 10) BETWEEN ? AND ?
                OR (
                  task_kind = 'calendar_event'
                  AND ${CALENDAR_ITEM_DATE} IS NOT NULL AND ${CALENDAR_ITEM_DATE} <> ''
                  AND end_date IS NOT NULL AND end_date <> ''
                  AND substr(${CALENDAR_ITEM_DATE}, 1, 10) <= ?
                  AND substr(end_date, 1, 10) >= ?
                )
              )`, [lowerBound, upperBound, upperBound, lowerBound]), "select"));

    const tasksByDay: Record<string, CalendarDayInfo> = {};
    for (const row of result.rows) {
      const r = row as unknown as CalendarFilterRow & { calendar_date: string; color: string | null; calendar_sync_state?: string | null };
      if (!options.includeCompleted && isDoneStatus(r.status)) continue
      if (options.matches && !options.matches(r)) continue
      const span = calendarEventSpanDays(r, timezone)
      const fallbackDay = calendarDayFromInput(r.calendar_date, timezone)
      const startDay = span?.startDay ?? fallbackDay
      const endDay = span?.endDay ?? fallbackDay
      if (!startDay || !endDay) continue
      const rangeStart = startDay < monthStart ? monthStart : startDay
      const rangeEnd = endDay > monthEnd ? monthEnd : endDay
      if (rangeStart > rangeEnd) continue
      const color = typeof r.color === "string" ? r.color.trim() : "";
      let day = rangeStart
      for (let step = 0; step < 370 && day <= rangeEnd; step += 1) {
        const existing = tasksByDay[day] ?? {
          dueDate: day,
          count: 0,
          colors: [],
          scheduledEvents: 0,
          haEvents: 0,
        };
        existing.count += 1;
        if (r.task_kind === "calendar_event") existing.scheduledEvents += 1
        if (color && existing.colors.length < 3) {
          existing.colors.push(color);
        }
        tasksByDay[day] = existing;
        const nextDay = shiftCalendarDay(day, 1)
        if (nextDay === day) break
        day = nextDay
      }
    }
    return tasksByDay;
  }

  /** HA & CalDAV synced event counts per day for calendar view (expands recurring series occurrences) */
  async getCalendarHAEventCounts(
    monthStart: string,
    monthEnd: string,
    timezone = "Europe/Dublin",
  ): Promise<Record<string, number>> {
    const byDay = await this.getLinkedCalendarEvents(monthStart, monthEnd, timezone)
    return Object.fromEntries(Object.entries(byDay).map(([day, events]) => [day, events?.length ?? 0]))
  }

  async getLinkedCalendarEvents(fromDay: string, throughDay: string, timezone: string): Promise<Partial<Record<string, LinkedCalendarEvent[]>>> {
    const byDay = new Map<string, Map<string, LinkedCalendarEvent>>()
    const dayRanges = new Map<string, [number, number][]>()
    const rangesForDay = (day: string) => {
      const existing = dayRanges.get(day)
      if (existing) return existing
      const ranges = householdDayRanges(day, timezone)
      dayRanges.set(day, ranges)
      return ranges
    }
    const addSpan = (
      task: Omit<LinkedCalendarEvent, "start">, startRaw: unknown, endRaw?: unknown, effectiveEndRaw?: unknown,
      taskEndDay?: string | null,
    ) => {
      if (typeof startRaw !== "string" || !startRaw.trim()) return;
      const startDay = calendarEventDay(startRaw, timezone);
      if (!startDay) return;

      const providerEnd = typeof endRaw === "string" ? calendarEventDay(endRaw, timezone, "exclusive-end") : null
      const storedEnd = typeof effectiveEndRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(effectiveEndRaw.trim())
        ? calendarDayFromInput(effectiveEndRaw, timezone) : null
      const endDay = providerEnd ?? storedEnd ?? taskEndDay ?? startDay

      const interval = typeof endRaw === "string" ? calendarEventInterval(startRaw, endRaw, timezone) : null
      const lastDay = endDay < startDay ? startDay : endDay
      // A rollback near midnight can cover a day outside the endpoint dates.
      const first = interval ? shiftCalendarDay(startDay, -1) : startDay
      const last = interval ? shiftCalendarDay(lastDay, 1) : lastDay
      const from = first > fromDay ? first : fromDay
      const to = last < throughDay ? last : throughDay
      if (from > to) return;

      const key = task.id + "/" + calendarOccurrenceStartKey(startRaw, timezone)
      let cur = from;
      for (let guard = 0; guard < 62 && cur <= to; guard++) {
        if (!interval || calendarIntervalOverlaps(interval, rangesForDay(cur))) {
          let day = byDay.get(cur)
          if (!day) byDay.set(cur, day = new Map())
          if (!day.has(key)) day.set(key, { ...task, start: startRaw })
        }
        const next = shiftCalendarDay(cur, 1);
        if (next === cur) break;
        cur = next;
      }
    };

    const result = await this.forOperation("read").execute(scopedTaskRead(this.scope, sourceSql("SELECT t.id, t.title, t.due_date, t.start_date, t.end_date, cc.payload, cc.source, cc.provider_event_id\n            FROM scoped_tasks t\n            LEFT JOIN calendar_confirmations cc ON cc.task_id = t.id AND cc.source IN ('ha.calendar_sync', 'caldav')\n            WHERE 1 AND t.calendar_sync_state = 'synced' AND t.status IS NOT 'archived'\n            ORDER BY cc.created_at DESC, cc.confirmation_id ASC", []), "select"));

    for (const row of result.rows) {
      let payload: {
        entity_id?: unknown
        summary?: unknown
        start?: unknown
        end?: unknown
        dtstart?: unknown
        dtend?: unknown
        effective_end?: unknown
        occurrences?: Array<{ start?: unknown; end?: unknown; effective_end?: unknown }>
      } | null = null
      try {
        if (typeof row.payload === "string") payload = JSON.parse(row.payload)
      } catch { /* Older or malformed payloads still have the task dates. */ }
      const entity = row.source === "ha.calendar_sync" && typeof payload?.entity_id === "string" ? payload.entity_id : null
      const task = {
        id: String(row.id), title: String(row.title), entity,
        uid: entity && typeof row.provider_event_id === "string" ? row.provider_event_id : null,
        providerSummary: entity && typeof payload?.summary === "string" ? payload.summary : null,
      }
      const providerStart = payload?.start ?? payload?.dtstart
      if (Array.isArray(payload?.occurrences) && payload.occurrences.length) {
        for (const occurrence of payload.occurrences) {
          addSpan(task, occurrence?.start, occurrence?.end, occurrence?.effective_end)
        }
      } else {
        const taskEndDay = typeof row.end_date === "string" ? calendarEventDay(row.end_date, timezone) : null
        if (typeof providerStart === "string" && calendarEventDay(providerStart, timezone)) {
          addSpan(task, providerStart, payload?.end ?? payload?.dtend, payload?.effective_end, taskEndDay)
        } else {
          addSpan(task, row.start_date ?? row.due_date, undefined, undefined, taskEndDay)
        }
      }
    }
    return Object.fromEntries([...byDay].map(([day, events]) =>
      [day, [...events.values()].sort((left, right) => compareCalendarStarts(left.start, right.start, timezone) || left.id.localeCompare(right.id))]))
  }

  // ── Timeline (timeline.astro) ─────────────────────────────────────────

  /** All tasks with date fields for Timeline/GANTT chart rendering */
  async getTimelineTasks(): Promise<TaskRow[]> {
    const result = await this.forOperation("read").execute(
      scopedTaskRead(this.scope, sourceSql(`SELECT id, title, status, priority, due_date, start_date, end_date, color, task_type, task_kind, project_id, assigned_to, progress, ticket_number, ticket_ref, ticket_ref AS ticket_key, parent_id, public_parent_id, blocked_by, effort_minutes, labels, area_id, public_area_id, public_project_id, public_goal_id, deferred_at, updated_at, ${taskTimestampMs("tasks.updated_at")} AS task_version,
       COALESCE(NULLIF(tasks.area_id, ''), (SELECT NULLIF(project.area_id, '') FROM scoped_projects AS project
         WHERE project.id = tasks.project_id)) IS NOT NULL AS area_assigned
       FROM scoped_tasks AS tasks WHERE 1 ORDER BY start_date ASC NULLS LAST, created_at DESC`), "select"),
    );
    return this.normalizeTaskRows(result.rows);
  }

  // ── Today (today.astro) ─────────────────────────────────────────────

  /** Overdue tasks (past due date, non-complete) */
  async getOverdueTasks(todayStr: string, timezone = "Europe/Dublin"): Promise<TaskRow[]> {
    const upperBound = shiftCalendarDay(todayStr, 2);
    const result = await this.forOperation("read").execute(scopedTaskRead(this.scope, sourceSql(`SELECT * FROM scoped_tasks AS tasks
            WHERE 1 AND ${CALENDAR_ITEM_DATE} IS NOT NULL AND ${CALENDAR_ITEM_DATE} <> '' AND substr(${CALENDAR_ITEM_DATE}, 1, 10) < ?
              AND status NOT IN (?, 'archived')
              AND deferred_at IS NULL
            ORDER BY ${CALENDAR_ITEM_DATE} ASC`, [upperBound, STATUS.COMPLETE]), "select"));
    const rows = sanitizeRows(this.normalizeTaskRows(result.rows));
    return rows.filter((row) => isTaskOverdue(row, false, timezone, todayStr));
  }

  /** Tasks due on a specific date (non-complete) */
  async getTasksDueOn(dateStr: string, timezone = "Europe/Dublin"): Promise<TaskRow[]> {
    const lowerBound = shiftCalendarDay(dateStr, -2);
    const upperBound = shiftCalendarDay(dateStr, 2);
    const result = await this.forOperation("read").execute(scopedTaskRead(this.scope, sourceSql(`SELECT * FROM scoped_tasks AS tasks
            WHERE 1 AND ${CALENDAR_ITEM_DATE} IS NOT NULL AND ${CALENDAR_ITEM_DATE} <> ''
              AND (
                (substr(${CALENDAR_ITEM_DATE}, 1, 10) >= ? AND substr(${CALENDAR_ITEM_DATE}, 1, 10) <= ?)
                OR (
                  task_kind = 'calendar_event' AND start_date IS NOT NULL AND start_date <> ''
                  AND substr(start_date, 1, 10) <= ?
                  AND substr(COALESCE(NULLIF(end_date, ''), start_date), 1, 10) >= ?
                )
              )
              AND status NOT IN (?, 'archived') AND deferred_at IS NULL
            ORDER BY priority DESC, created_at ASC`, [lowerBound, upperBound, upperBound, lowerBound, STATUS.COMPLETE]), "select"));
    const rows = sanitizeRows(this.normalizeTaskRows(result.rows));
    return rows.filter((row) => taskMatchesDateWindow(row, dateStr, dateStr, timezone));
  }

  /** Unscheduled tasks (no due date, non-complete) */
  async getUnscheduledTasks(limit = 10): Promise<TaskRow[]> {
    const result = await this.forOperation("read").execute(scopedTaskRead(this.scope, sourceSql(`SELECT * FROM scoped_tasks AS tasks
            WHERE 1 AND (${CALENDAR_ITEM_DATE} IS NULL OR ${CALENDAR_ITEM_DATE} = '') AND status NOT IN (?) AND deferred_at IS NULL
            ORDER BY priority DESC, created_at DESC
            LIMIT ${limit}`, [STATUS.COMPLETE]), "select"));
    return sanitizeRows(this.normalizeTaskRows(result.rows));
  }

  /**
   * Suggested tasks — high-priority (p1-p2) tasks due within 3 days,
   * or unscheduled high-priority tasks. Excludes tasks already due today
   * and already shown in overdue section.
   * Used by Smart Today (SMT-01).
   */
  async getSuggestedTasks(todayStr: string, limit = 10, timezone = "Europe/Dublin"): Promise<TaskRow[]> {
    // Calculate end date (3 days from today)
    const lowerBound = shiftCalendarDay(todayStr, -2);
    const endStr = shiftCalendarDay(todayStr, 3);
    const upperBound = shiftCalendarDay(endStr, 2);

    const result = await this.forOperation("read").execute(scopedTaskRead(this.scope, sourceSql(`SELECT * FROM scoped_tasks AS tasks
            WHERE 1 AND status NOT IN (?, 'archived')
              AND deferred_at IS NULL
              AND (
                (${CALENDAR_ITEM_DATE} IS NOT NULL AND ${CALENDAR_ITEM_DATE} <> '' AND substr(${CALENDAR_ITEM_DATE}, 1, 10) >= ? AND substr(${CALENDAR_ITEM_DATE}, 1, 10) <= ? AND priority <= 2)
                OR ((${CALENDAR_ITEM_DATE} IS NULL OR ${CALENDAR_ITEM_DATE} = '') AND priority <= 2)
              )
            ORDER BY priority ASC, ${CALENDAR_ITEM_DATE} ASC NULLS LAST`, [STATUS.COMPLETE, lowerBound, upperBound]), "select"));
    const rows = sanitizeRows(this.normalizeTaskRows(result.rows));
    return rows
      .filter((row) => {
        const scheduled = effectiveTaskScheduledDate(row);
        if (!scheduled) return true;
        const day = calendarDayFromInput(scheduled, timezone);
        return day !== null && day > todayStr && day <= endStr;
      })
      .slice(0, limit);
  }

  /** Count tasks completed today (status=complete AND updated_at today) — SMT-03 */
  async getCompletedTodayCount(todayStr: string): Promise<number> {
    // today timestamps: midnight to midnight (epoch ms)
    const startMs = new Date(todayStr).getTime()
    const endMs = startMs + 86400000
    const result = await this.forOperation("read").execute(scopedTaskRead(this.scope, sourceSql("SELECT COUNT(*) as cnt FROM scoped_tasks AS tasks\n            WHERE 1 AND status = ? AND updated_at >= ? AND updated_at < ?", [STATUS.COMPLETE, startMs, endMs]), "select"));
    return Number((result.rows[0] as Record<string, unknown>)?.cnt ?? 0);
  }

  // ── Upcoming (upcoming.astro) ───────────────────────────────────────

  /** Tasks within a date range (non-complete) for upcoming view */
  async getTasksInRange(startDate: string, endDate: string, timezone = "Europe/Dublin", placement?: TaskReadPlacement): Promise<TaskRow[]> {
    const lowerBound = shiftCalendarDay(startDate, -2);
    const upperBound = shiftCalendarDay(endDate, 2);
    const context = taskReadPlacement(placement)
    const result = await this.forOperation("read").execute(scopedTaskRead(this.scope, sourceSql(`SELECT * FROM scoped_tasks AS tasks
            WHERE ${context.sql} AND ${CALENDAR_ITEM_DATE} IS NOT NULL AND ${CALENDAR_ITEM_DATE} <> ''
              AND (
                (substr(${CALENDAR_ITEM_DATE}, 1, 10) >= ? AND substr(${CALENDAR_ITEM_DATE}, 1, 10) <= ?)
                OR (
                  task_kind = 'calendar_event' AND start_date IS NOT NULL AND start_date <> ''
                  AND substr(start_date, 1, 10) <= ?
                  AND substr(COALESCE(NULLIF(end_date, ''), start_date), 1, 10) >= ?
                )
              )
              AND status NOT IN (?, 'archived')
              AND deferred_at IS NULL
            ORDER BY ${CALENDAR_ITEM_DATE} ASC, priority DESC, created_at ASC`, [...context.args, lowerBound, upperBound, upperBound, lowerBound, STATUS.COMPLETE]), "select"));
    const rows = sanitizeRows(this.normalizeTaskRows(result.rows));
    return rows.filter((row) => taskMatchesDateWindow(row, startDate, endDate, timezone));
  }

  // ── Write Methods (API routes) ────────────────────────────────────────

  /**
   * Resolve a task identifier to its UUID.
   * Accepts UUID or MTH-N ticket key format.
   */
  private ticketNumberForScope(value: string): number | null {
    const prefix = scopeBoardAccess(this.scope).ticketPrefix
    if (!/^[A-Z0-9]+$/i.test(prefix)) return null
    const match = /^([A-Z0-9]+)-(\d+)$/i.exec(value)
    if (!match || match[1]?.toUpperCase() !== prefix.toUpperCase()) return null
    const number = Number(match[2])
    return Number.isSafeInteger(number) && number > 0 ? number : null
  }

  async resolveTaskId(
    idOrKey: string,
    action: WorkAction = "read",
  ): Promise<{ id: string; updated_at: unknown; routine_occurrence: number; due_date: unknown } | null> {
    const number = this.ticketNumberForScope(idOrKey)
    const identity = number === null ? sql`id = ${idOrKey}` : sql`(id = ${idOrKey} OR ticket_number = ${number})`
    const assigned = action === "read" ? undefined : scopeAssignedTo(this.scope)
    const locate = scopedTaskRead(this.scope, sql`SELECT id, ${sourceSql(taskTimestampMs("updated_at"))} AS updated_at, routine_occurrence, due_date
      FROM scoped_task_records AS tasks
      WHERE ${identity} ${assigned === undefined ? sourceSql("") : sql`AND assigned_to = ${assigned}`} LIMIT 1`, "select", "records")
    const { rows: [row] } = await this.readCommandStatement(action, tagTaskProjectionRead(locate, "task-locator"))
    return row
      ? {
          id: String(row.id),
          updated_at: row.updated_at,
          routine_occurrence: Number(row.routine_occurrence ?? 0),
          due_date: row.due_date ?? null,
        }
      : null
  }

  /** Internal command preflight; its result never grants a readable transport projection. */
  async findTaskForCommand(id: string, action: "edit" | "delete" | "propose" | "assign" | "complete" | "move"): Promise<TaskRow | null> {
    const lookup = scopedTaskRead(this.scope, sql`SELECT tasks.*, tasks.ticket_ref AS ticket_key,
      ${sourceSql(taskTimestampMs("tasks.updated_at"))} AS task_version FROM scoped_tasks AS tasks WHERE id = ${id}`)
    const { rows: [row] } = await this.readCommandStatement(action, tagTaskProjectionRead(lookup, "task-command"), [id])
    return row as unknown as TaskRow ?? null
  }

  private buildDetailQuery(idOrKey: string) {
    const number = this.ticketNumberForScope(idOrKey)
    const identity = number === null ? sql`t.id = ${idOrKey}` : sql`(t.id = ${idOrKey} OR t.ticket_number = ${number})`
    return scopedTaskRead(this.scope, sql`SELECT t.*, t.ticket_ref AS ticket_key,
      ${sourceSql(taskTimestampMs("t.updated_at"))} AS task_version,
      CASE WHEN t.public_parent_id IS NOT NULL THEN (SELECT parent.title FROM scoped_task_records AS parent WHERE parent.id = t.public_parent_id) END AS parent_title,
      CASE WHEN t.public_parent_id IS NOT NULL THEN (SELECT parent.task_type FROM scoped_task_records AS parent WHERE parent.id = t.public_parent_id) END AS parent_task_type,
      CASE WHEN t.public_parent_id IS NOT NULL THEN (SELECT parent.ticket_number FROM scoped_task_records AS parent WHERE parent.id = t.public_parent_id) END AS parent_ticket_number,
      CASE WHEN t.public_parent_id IS NOT NULL THEN (SELECT parent.ticket_ref FROM scoped_task_records AS parent WHERE parent.id = t.public_parent_id) END AS parent_ticket_ref,
      EXISTS (SELECT 1 FROM tasks AS child_probe WHERE child_probe.task_board_id IS t.task_board_id AND child_probe.parent_id = t.id) AS _has_children,
      EXISTS (SELECT 1 FROM tasks AS pillar_probe WHERE pillar_probe.id = t.id AND pillar_probe.pillar_id IS NOT NULL) AS _has_pillar
      FROM scoped_tasks AS t
      WHERE ${identity} LIMIT 1`)
  }

  private stripDetailProbes(raw: Record<string, unknown> | undefined) {
    if (!raw) return null
    const hasChildren = Number(raw._has_children ?? 0) !== 0
    const hasPillar = Number(raw._has_pillar ?? 0) !== 0
    const task = { ...raw }
    delete task._has_children
    delete task._has_pillar
    return { task: task as unknown as TaskRow, hasChildren, hasPillar }
  }

  private async querySubtasks(
    runner: Pick<Client, "execute">,
    parentId: string,
  ): Promise<Array<{
    id: string
    ticket_number: number | null
    ticket_key: string | null
    title: string
    status: string
    priority: number
    task_type: string
    assigned_to: string | null
    due_date: string | null
  }>> {
    const result = await runner.execute(tagTaskProjectionRead(scopedTaskRead(this.scope, sourceSql(`
      SELECT id, ticket_number, ticket_ref, title, status, priority, task_type, assigned_to, due_date
      FROM scoped_task_records AS tasks
      WHERE tasks.parent_id = ?
      ORDER BY COALESCE(kanban_position, 2147483647) ASC, created_at ASC, id ASC
    `, [parentId]), "select", "records"), "task-subtasks"))
    return result.rows.map(row => {
      const ticketNumber = row.ticket_number != null ? Number(row.ticket_number) : null
      return {
        id: String(row.id),
        ticket_number: ticketNumber,
        ticket_key: typeof row.ticket_ref === "string" && row.ticket_ref ? row.ticket_ref : formatTicketKey(ticketNumber),
        title: String(row.title ?? ""),
        status: normalizeStatus(String(row.status ?? "pending")),
        priority: Number(row.priority ?? 3),
        task_type: String(row.task_type ?? "task"),
        assigned_to: typeof row.assigned_to === "string" ? row.assigned_to : null,
        due_date: typeof row.due_date === "string" ? row.due_date : null,
      }
    })
  }

  /** Retrieve a single task by ID/ticket key, with parent info JOINed */
  async findById(idOrKey: string): Promise<TaskRow | null> {
    const detail = this.buildDetailQuery(idOrKey)
    const result = await this.forOperation("read").execute(tagTaskProjectionRead(detail, "task-detail"))
    return this.stripDetailProbes(result.rows[0] as Record<string, unknown> | undefined)?.task ?? null
  }

  /** Retrieve direct readable child tasks for a parent task on the current Board. */
  async findSubtasks(parentId: string) {
    return this.querySubtasks(this.forOperation("read", [parentId]), parentId)
  }

  /** Retrieve task detail and its direct subtasks inside a single snapshot read transaction when child rows exist. */
  async findDetailWithSubtasks(idOrKey: string): Promise<{
    task: TaskRow
    subtasks: Awaited<ReturnType<TaskRepository["findSubtasks"]>>
    hasPillar: boolean
  } | null> {
    const detail = this.buildDetailQuery(idOrKey)
    const fast = await this.forOperation("read").execute(tagTaskProjectionRead(detail, "task-detail"))
    const initial = this.stripDetailProbes(fast.rows[0] as Record<string, unknown> | undefined)
    if (!initial) return null
    if (!initial.hasChildren) return { task: initial.task, subtasks: [], hasPillar: initial.hasPillar }
    const tx = await this.forOperation("read").transaction("read")
    try {
      const result = await tx.execute(tagTaskProjectionRead(detail, "task-detail"))
      const current = this.stripDetailProbes(result.rows[0] as Record<string, unknown> | undefined)
      if (!current) return null
      const subtasks = await this.querySubtasks(tx, String(current.task.id))
      return { task: current.task, subtasks, hasPillar: current.hasPillar }
    } finally {
      tx.close()
    }
  }

  /**
   * Export all tasks with explicit column list.
   * Used by export/tasks.json.ts and export/tasks.csv.ts.
   * Column list is explicit to avoid leaking internal schema changes.
   */
  async exportAll(): Promise<TaskRow[]> {
    const result = await this.forOperation("read").execute(
      scopedTaskRead(this.scope, sourceSql(`SELECT id, title, description, status, priority, due_date, labels,
              framework_payload, calendar_sync_state, tasks.public_area_id AS area_id, custom_fields,
              public_parent_id AS parent_id, time_tracked, start_date, end_date, progress, color,
              is_promoted, task_type, task_kind, tasks.public_project_id AS project_id, owner, handoff_state,
              ticket_number, recurrence_rule,
              checklists, reminder_at, created_at, updated_at
       FROM scoped_tasks AS tasks WHERE 1 ORDER BY updated_at DESC`), "select")
    );
    return this.normalizeTaskRows(result.rows);
  }

  async findBacklogPage(requestedPage: number, placement?: TaskReadPlacement): Promise<{
    page: number;
    total: number;
    tasks: Array<Pick<TaskRow, "id" | "title" | "description" | "ticket_number" | "due_date"> & { updated_at: number, ticket_key: string | null }>;
  }> {
    const pageSize = 25
    const page = Number.isSafeInteger(requestedPage) ? requestedPage : 1
    const context = taskReadPlacement(placement)
    const result = await this.forOperation("read").execute(scopedTaskRead(this.scope, sourceSql(`totals AS (
              SELECT COUNT(*) AS total FROM scoped_tasks AS tasks WHERE ${context.sql} AND status = ? AND deferred_at IS NULL
            ), bounds AS (
              SELECT total, MAX(1, MIN(?, CAST((total + ? - 1) / ? AS INTEGER))) AS page FROM totals
            ), items AS (
              SELECT id, title, description, ticket_number, ticket_ref AS ticket_key, due_date,
                     ${taskTimestampMs("created_at")} AS created_ms,
                     ${taskTimestampMs("updated_at")} AS updated_at
              FROM scoped_tasks AS tasks WHERE ${context.sql} AND status = ? AND deferred_at IS NULL
              ORDER BY created_ms ASC, id ASC
              LIMIT ? OFFSET (SELECT (page - 1) * ? FROM bounds)
            )
            SELECT bounds.total, bounds.page, items.*
            FROM bounds LEFT JOIN items ON TRUE
            ORDER BY items.created_ms ASC, items.id ASC`, [...context.args, STATUS.BACKLOG, page, pageSize, pageSize, ...context.args, STATUS.BACKLOG, pageSize, pageSize]), "with"))
    return {
      page: Number(result.rows[0]?.page ?? 1),
      total: Number(result.rows[0]?.total ?? 0),
      tasks: result.rows.flatMap(row => row.id == null ? [] : [{
        id: String(row.id),
        title: String(row.title),
        description: row.description == null ? null : String(row.description),
        ticket_number: row.ticket_number == null ? null : Number(row.ticket_number),
        ticket_key: row.ticket_key == null ? null : String(row.ticket_key),
        due_date: row.due_date == null ? null : String(row.due_date),
        updated_at: Number(row.updated_at),
      }]),
    }
  }

  /** List deferred tasks within the selected Area or across all Areas. */
  async findDeferredPage(requestedPage: number, areaId = ""): Promise<{
    page: number
    total: number
    tasks: Array<DeferralState & Pick<TaskRow, "title" | "project_id" | "ticket_number"> & { automatic: boolean }>
  }> {
    const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
    const scope = areaId ? ` AND (${planningProjection("areas", "tasks.area_id")}) = ?` : ""
    const areaArgs = areaId ? [areaId] : []
    const { rows } = await this.forOperation("read").execute(scopedTaskRead(this.scope, sourceSql(`totals AS (
              SELECT COUNT(*) AS total FROM scoped_tasks AS tasks WHERE 1 AND deferred_at IS NOT NULL${scope}
            ), bounds AS (
              SELECT total, MAX(1, MIN(?, (total + 24) / 25)) AS page FROM totals
            ), items AS (
              SELECT id, title, ${planningProjection("projects", "tasks.project_id")} AS project_id,
                     status, ticket_number, deferred_at, deferral_revision,
                     ${taskTimestampMs("updated_at")} AS updated_at,
                     COALESCE((SELECT actor = '${inactivityRuleActor}' AND actor_type = 'system'
                      FROM task_activity_log WHERE task_id = tasks.id AND field = 'deferred_at'
                        AND new_value = CAST(tasks.deferred_at AS TEXT) ORDER BY id DESC LIMIT 1), 0) AS automatic
              FROM scoped_tasks AS tasks WHERE 1 AND deferred_at IS NOT NULL${scope}
              ORDER BY deferred_at DESC, id ASC
              LIMIT 25 OFFSET (SELECT (page - 1) * 25 FROM bounds)
            )
            SELECT bounds.total, bounds.page, items.*
            FROM bounds LEFT JOIN items ON TRUE
            ORDER BY items.deferred_at DESC, items.id ASC`, [...areaArgs, page, ...areaArgs]), "with"))
    return {
      page: Number(rows[0]?.page ?? 1),
      total: Number(rows[0]?.total ?? 0),
      tasks: rows.filter(row => row.id !== null).map(row => ({
        ...row, automatic: Number(row.automatic) === 1,
      })) as unknown as Array<DeferralState & Pick<TaskRow, "title" | "project_id" | "ticket_number"> & { automatic: boolean }>,
    }
  }

  /** List tasks with optional filters, pagination, and sorting. */
  async findAll(opts: {
    status?: string;
    dueDate?: string | undefined;
    calendarDay?: string | undefined;
    timezone?: string | undefined;
    matchCalendarTask?: ((task: CalendarFilterRow) => boolean) | undefined;
    priority?: number;
    areaId?: string;
    workspaceAreaId?: string;
    homeAssistantArea?: HomeAssistantAreaFilter;
    projectId?: string;
    taskType?: string;
    taskKind?: string;
    parentId?: string;
    search?: string;
    assignedTo?: string;
    label?: string;
    deferred?: boolean
    sort?: string;
    order?: "ASC" | "DESC";
    limit?: number;
    offset?: number;
  }): Promise<{ tasks: TaskRow[]; total: number }> {
    const validSorts = ["created_at", "updated_at", "title", "status", "priority", "due_date", "kanban_position", "table_position"];
    const sortCol = validSorts.includes(opts.sort ?? "") ? opts.sort! : "created_at";
    const order = opts.order ?? defaultTaskSortOrder(sortCol);
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
    const offset = Math.max(0, opts.offset ?? 0);
    const day = opts.calendarDay ?? opts.dueDate

    const conditions = ["1"];
    const args: InValue[] = [];

    if (opts.status) {
      const definition = getStatusDef(opts.status)
      const statuses = definition ? [definition.canonical, ...definition.aliases] : [opts.status]
      conditions.push(`status IN (${statuses.map(() => "?").join(", ")})`)
      args.push(...statuses)
    }
    if (day) {
      // Widen by ±2 days in SQL (offset-bearing timestamps can sit two calendar days away), then match in the configured household timezone.
      const lowerBound = shiftCalendarDay(day, -2)
      const upperBound = shiftCalendarDay(day, 2)
      if (opts.calendarDay) conditions.push(CALENDAR_LOCAL_ITEM)
      conditions.push(`(
        substr(${CALENDAR_ITEM_DATE}, 1, 10) BETWEEN ? AND ?
        OR (
          task_kind = 'calendar_event' AND start_date IS NOT NULL AND start_date <> ''
          AND substr(start_date, 1, 10) <= ?
          AND substr(COALESCE(NULLIF(end_date, ''), start_date), 1, 10) >= ?
        )
      )`)
      args.push(lowerBound, upperBound, upperBound, lowerBound)
    }
    if (opts.homeAssistantArea) {
      const filter = homeAssistantTaskAreaCondition(opts.homeAssistantArea)
      conditions.push(filter.sql)
      args.push(...filter.args)
    }
    if (opts.priority != null) { conditions.push("priority = ?"); args.push(opts.priority); }
    // Public Area filters use the same logical visible placement as responses,
    // including a Project's inherited Area; physical refs remain writer-owned.
    if (opts.areaId) { conditions.push("tasks.public_area_id = ?"); args.push(opts.areaId) }
    if (opts.workspaceAreaId) { conditions.push("tasks.public_area_id = ?"); args.push(opts.workspaceAreaId) }
    if (opts.projectId) { conditions.push(`(${planningProjection("projects", "tasks.project_id")}) = ?`); args.push(opts.projectId); }
    if (opts.taskType) { conditions.push("task_type = ?"); args.push(opts.taskType); }
    if (opts.taskKind && isValidTaskKind(opts.taskKind)) { conditions.push("task_kind = ?"); args.push(opts.taskKind); }
    if (opts.parentId) { conditions.push("parent_id = ?"); args.push(opts.parentId); }
    if (opts.search) { conditions.push("(title LIKE ? OR description LIKE ?)"); args.push(`%${opts.search}%`, `%${opts.search}%`); }
    if (opts.assignedTo) { conditions.push("assigned_to = ?"); args.push(opts.assignedTo); }
    if (opts.label) { conditions.push("EXISTS (SELECT 1 FROM json_each(tasks.labels) WHERE json_each.value = ?)"); args.push(opts.label); }
    if (opts.deferred !== undefined) conditions.push(opts.deferred ? "deferred_at IS NOT NULL" : "deferred_at IS NULL")

    const where = ` WHERE ${conditions.join(" AND ")}`;

    const projection = `tasks.*, tasks.ticket_ref AS ticket_key, ${taskTimestampMs("tasks.updated_at")} AS task_version`
    const ordering = sortCol === "due_date"
      ? `ORDER BY CASE WHEN due_date IS NULL OR TRIM(due_date) = '' THEN 1 ELSE 0 END ASC, due_date ${order}, id ASC`
      : `ORDER BY ${sortCol} ${order} NULLS LAST, id ASC`

    if (day) {
      const snapshot = await this.forOperation("read").transaction("read")
      try {
        const tz = opts.timezone || "Europe/Dublin"
        const filterProjection = opts.matchCalendarTask ? CALENDAR_FILTER_COLUMNS : "task_kind, start_date, end_date"
        const candidates = await snapshot.execute(scopedTaskRead(this.scope, sourceSql(`SELECT id, ${CALENDAR_ITEM_DATE} AS calendar_date, due_date, calendar_sync_state, ${filterProjection} FROM scoped_tasks AS tasks${where} ${ordering}`, args), "select"))
        const matches = opts.matchCalendarTask
        const ids = candidates.rows.filter(row => taskMatchesDateWindow(row as unknown as TaskRow, day, day, tz) &&
          (!matches || matches(row as unknown as CalendarFilterRow)))
        const page = ids.slice(offset, offset + limit)
        if (page.length === 0) return { tasks: [], total: ids.length }
        const result = await snapshot.execute(scopedTaskRead(this.scope, sourceSql(`SELECT ${projection} FROM scoped_tasks AS tasks WHERE 1 AND id IN (SELECT value FROM json_each(?)) ${ordering}`, [JSON.stringify(page.map(row => String(row.id)))]), "select"))
        return { tasks: this.normalizeTaskRows(result.rows), total: ids.length }
      } finally {
        snapshot.close()
      }
    }

    const useRecordFilter = !opts.areaId && !opts.workspaceAreaId && !opts.projectId
    const selectSql = useRecordFilter
      ? `SELECT ${projection}
         FROM (SELECT id FROM scoped_task_records AS tasks${where} ${ordering} LIMIT ${limit} OFFSET ${offset}) AS page_ids
         CROSS JOIN scoped_tasks AS tasks
         WHERE tasks.id = page_ids.id
         ${ordering}`
      : `SELECT ${projection} FROM scoped_tasks AS tasks${where} ${ordering} LIMIT ${limit} OFFSET ${offset}`
    const countRead = useRecordFilter
      ? scopedTaskRead(this.scope, sourceSql(`SELECT COUNT(*) as cnt FROM scoped_task_records AS tasks${where}`, args), "select", "records")
      : scopedTaskRead(this.scope, sourceSql(`SELECT COUNT(*) as cnt FROM scoped_tasks AS tasks${where}`, args))

    const [result, countResult] = await this.forOperation("read").batch([
      tagTaskProjectionRead(scopedTaskRead(this.scope, sourceSql(selectSql, args)), "task-list"),
      tagTaskProjectionRead(countRead, "task-count"),
    ], "read")

    const total = Number(countResult?.rows[0]?.cnt ?? 0)
    return { tasks: this.normalizeTaskRows(result?.rows ?? []), total }
  }

  /** Advanced catalog search used by the universal search hub and HA search bridges. */
  async searchCatalog(opts: TaskCatalogOptions): Promise<TaskCatalogRow[]> {
    return this.searchCatalogWithOperation(opts, "read")
  }

  async searchTaskTitles(opts: { query: string, limit?: number }): Promise<Array<{ id: string, title: string, ticket_key: string | null }>> {
    const rows = await this.searchCatalogWithOperation({ query: opts.query, fields: ["id", "title"], ...(opts.limit === undefined ? {} : { limit: opts.limit }) }, "search")
    return rows.map(row => ({ id: row.id, title: row.title, ticket_key: typeof row.ticket_ref === "string" ? row.ticket_ref : null }))
  }

  private async searchCatalogWithOperation(opts: TaskCatalogOptions, operation: "read" | "search"): Promise<TaskCatalogRow[]> {
    const query = (opts.query ?? "").trim().toLowerCase()
    const fields = new Set((opts.fields ?? ["id", "title", "description", "labels", "custom_fields", "comments"])
      .map(field => field.toLowerCase()))
    const limit = Math.min(50, Math.max(1, opts.limit ?? 12))
    const conditions: string[] = []
    const args: InValue[] = []

    const excludedStatuses: string[] = []
    if (opts.includeCompleted !== true) excludedStatuses.push(STATUS.COMPLETE)
    if (opts.includeArchived !== true) excludedStatuses.push("archived")
    if (excludedStatuses.length > 0) {
      conditions.push(`tasks.status NOT IN (${excludedStatuses.map(() => "?").join(", ")})`)
      args.push(...excludedStatuses)
    }
    if (opts.status) {
      conditions.push("tasks.status = ?")
      args.push(normalizeStatus(opts.status))
    }
    if (opts.priority != null) {
      conditions.push("tasks.priority = ?")
      args.push(opts.priority)
    }
    if (opts.assignedTo) {
      conditions.push("tasks.assigned_to = ?")
      args.push(opts.assignedTo)
    }
    if (opts.taskKind) {
      conditions.push("tasks.task_kind = ?")
      args.push(opts.taskKind)
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
    const projection = "tasks.id, tasks.ticket_number, tasks.ticket_ref, tasks.title, tasks.status, tasks.priority, tasks.task_kind, tasks.deferred_at"
    const updatedAt = taskTimestampMs("tasks.updated_at")
    if (!query) {
      const result = await this.forOperation(operation).execute(tagTaskProjectionRead(scopedTaskRead(this.scope, sourceSql(`SELECT ${projection}, 0 AS score
              FROM scoped_task_records AS tasks ${where}
              ORDER BY ${updatedAt} DESC, tasks.priority ASC, tasks.id ASC
              LIMIT ?`, [...args, limit]), "select", "search"), "task-search"))
      return result.rows as unknown as TaskCatalogRow[]
    }

    const parsedTicket = this.ticketNumberForScope(query) ?? (/^[0-9]+$/.test(query) ? Number(query) : 0)
    const ticket = Number.isSafeInteger(parsedTicket) && parsedTicket > 0 ? parsedTicket : null
    const selected = (field: string, sql: string) => fields.has(field) ? sql : "0"
    // INSTR treats percent, underscore and backslash literally. The needle and
    // the stored field keep their existing JavaScript/SQLite case behavior.
    const position = (column: string) => `instr(lower(coalesce(${column}, '')), needle.value)`
    const commentMatch = `c.task_id = tasks.id AND ${position("c.content")} > 0`
    const snippet = (column: string) => {
      const start = `max(${position(column)} - 32, 1)`
      return `(CASE WHEN ${start} > 1 THEN '...' ELSE '' END) ||
              substr(${column}, ${start}, 174) ||
              (CASE WHEN length(${column}) >= ${start} + 174 THEN '...' ELSE '' END)`
    }
    const snippets = [
      fields.has("description") ? `WHEN page.description_hit THEN ${snippet("tasks.description")}` : "",
      fields.has("comments") ? `WHEN page.comments_hit THEN (
        SELECT ${snippet("c.content")} FROM comments c
        WHERE ${commentMatch} ORDER BY c.created_at DESC, c.id DESC LIMIT 1
      )` : "",
      fields.has("custom_fields") ? `WHEN page.custom_fields_hit THEN ${snippet("tasks.custom_fields")}` : "",
      fields.has("labels") ? `WHEN page.labels_hit THEN ${snippet("tasks.labels")}` : "",
    ].filter(Boolean)
    const excerpt = snippets.length ? `CASE ${snippets.join("\n")} END` : "NULL"
    const orderBy = opts.sort === "updated" ? "" : "score DESC, "

    const hasCommentsField = fields.has("comments")
    const useLikeFastPath = !query.includes("\0") && query.length <= 500
    const searchQuery = useLikeFastPath
      ? (() => {
          const escaped = query.replace(/[\\%_]/g, "\\$&")
          const likeAny = `%${escaped}%`
          const likePrefix = `${escaped}%`
          const hasDigit = /\d/.test(query) ? 1 : 0
          const codepointLen = [...query].length
          const isScopedStorage = storageBoardId(this.scope) !== null
          const canMatchTicketRef = isScopedStorage || /^[a-z0-9-]+$/i.test(query) ? 1 : 0
          const fastUpdatedAt = `CASE WHEN typeof(updated_at) = 'integer' AND updated_at >= 0 AND updated_at <= 9007199254740991 THEN updated_at ELSE ${taskTimestampMs("updated_at")} END`
          const refHitSql = selected("id", "needle.can_match_ref AND tasks.ticket_ref IS NOT NULL AND tasks.ticket_ref <> '' AND tasks.ticket_ref LIKE needle.like_any ESCAPE '\\'")
          const numHitSql = selected("id", "needle.has_digit AND tasks.ticket_number IS NOT NULL AND instr(cast(tasks.ticket_number AS TEXT), needle.value) > 0")
          const titleAtSql = selected("title", "CASE WHEN tasks.title LIKE needle.like_prefix ESCAPE '\\' THEN 1 WHEN tasks.title LIKE needle.like_any ESCAPE '\\' THEN 2 ELSE 0 END")
          const descriptionPred = "tasks.description IS NOT NULL AND tasks.description <> '' AND tasks.description LIKE needle.like_any ESCAPE '\\'"
          const labelsPred = "tasks.labels IS NOT NULL AND tasks.labels <> '' AND (tasks.labels <> '[]' OR instr('[]', needle.value) > 0) AND tasks.labels LIKE needle.like_any ESCAPE '\\'"
          const customFieldsPred = "tasks.custom_fields IS NOT NULL AND tasks.custom_fields <> '' AND (tasks.custom_fields <> '{}' OR instr('{}', needle.value) > 0) AND tasks.custom_fields LIKE needle.like_any ESCAPE '\\'"
          const commentProbe = hasCommentsField ? "((SELECT v FROM has_comments) AND tasks.id IN comment_hits)" : "0"
          const matchClauses: string[] = []
          if (fields.has("title")) matchClauses.push("tasks.title LIKE needle.like_any ESCAPE '\\'")
          if (fields.has("description")) matchClauses.push(`(${descriptionPred})`)
          if (fields.has("labels")) matchClauses.push(`(${labelsPred})`)
          if (fields.has("custom_fields")) matchClauses.push(`(${customFieldsPred})`)
          if (fields.has("id")) {
            matchClauses.push(`tasks.id LIKE needle.like_any ESCAPE '\\' OR coalesce(tasks.ticket_number = needle.ticket, 0) OR (${refHitSql}) OR (${numHitSql})`)
          }
          if (hasCommentsField) matchClauses.push(commentProbe)
          const hitsWhere = [...conditions, matchClauses.length ? `(${matchClauses.join(" OR ")})` : "0"].join(" AND ")
          const exactIdSql = selected("id", "(coalesce(tasks.ticket_number = needle.ticket, 0) OR (length(tasks.id) = needle.value_len AND tasks.id LIKE needle.like_any ESCAPE '\\'))")
          const exactIdWithTitleSql = fields.has("title")
            ? `(${EXACT_TASK_IDENTIFIER_SCORE} + (CASE WHEN tasks.title LIKE needle.like_any ESCAPE '\\' THEN 60 ELSE 0 END))`
            : `${EXACT_TASK_IDENTIFIER_SCORE}`
          const titleScoreSql = fields.has("title")
            ? "CASE WHEN tasks.title LIKE needle.like_prefix ESCAPE '\\' THEN CASE WHEN length(tasks.title) = needle.value_len THEN 3060 ELSE 2060 END WHEN tasks.title LIKE needle.like_any ESCAPE '\\' THEN 1060 ELSE 1000 END"
            : "1000"
          const commentCtes = hasCommentsField
            ? `comment_hits(task_id) AS MATERIALIZED (
              SELECT DISTINCT c.task_id FROM comments c CROSS JOIN needle
              WHERE c.content LIKE needle.like_any ESCAPE '\\'
            ),
            has_comments(v) AS MATERIALIZED (
              SELECT EXISTS(SELECT 1 FROM comment_hits)
            ),`
            : ""
          return sourceSql(`needle(value, value_len, ticket, like_any, like_prefix, has_digit, can_match_ref) AS (VALUES (?, ?, ?, ?, ?, ?, ?)),
            ${commentCtes}
            top_hits AS MATERIALIZED (
              SELECT tasks.id, tasks.priority, ${fastUpdatedAt} AS updated_at_ms,
                (CASE WHEN ${exactIdSql} THEN ${exactIdWithTitleSql} ELSE ${titleScoreSql} END
                 + (${selected("description", descriptionPred)}) * 25
                 + (${selected("labels", labelsPred)}) * 18
                 + (${selected("custom_fields", customFieldsPred)}) * 15
                 + (${selected("comments", commentProbe)}) * 12
                 + (tasks.status NOT IN ('complete', 'archived')) * 6) AS score
              FROM scoped_task_records AS tasks CROSS JOIN needle WHERE ${hitsWhere}
              ORDER BY ${orderBy}updated_at_ms DESC, tasks.priority ASC, tasks.id ASC
              LIMIT ?
            ),
            page AS MATERIALIZED (
              SELECT top_hits.id, tasks.ticket_number, tasks.ticket_ref, tasks.title, tasks.status,
                top_hits.priority, tasks.task_kind, tasks.deferred_at,
                top_hits.updated_at_ms, top_hits.score,
                (${exactIdSql}) AS exact_id,
                (${selected("id", "tasks.id LIKE needle.like_any ESCAPE '\\'")} OR (${refHitSql}) OR (${numHitSql})) AS id_hit,
                ${titleAtSql} AS title_at,
                (${selected("description", descriptionPred)}) AS description_hit,
                (${selected("labels", labelsPred)}) AS labels_hit,
                (${selected("custom_fields", customFieldsPred)}) AS custom_fields_hit,
                (${selected("comments", commentProbe)}) AS comments_hit
              FROM top_hits JOIN scoped_task_records AS tasks ON tasks.id = top_hits.id CROSS JOIN needle
            )
            SELECT page.id, page.ticket_number, page.ticket_ref, page.title, page.status, page.priority, page.task_kind, page.deferred_at,
              page.score, page.id_hit, page.exact_id, page.title_at,
              page.description_hit, page.labels_hit, page.custom_fields_hit, page.comments_hit, ${excerpt} AS excerpt
            FROM page JOIN tasks ON tasks.id = page.id CROSS JOIN needle
            ORDER BY ${orderBy}page.updated_at_ms DESC, page.priority ASC, page.id ASC`, [query, codepointLen, ticket, likeAny, likePrefix, hasDigit, canMatchTicketRef, ...args, limit])
        })()
      : sourceSql(`needle(value, ticket) AS (VALUES (?, ?)),
            ${hasCommentsField ? `comment_hits(task_id) AS MATERIALIZED (
              SELECT DISTINCT c.task_id FROM comments c CROSS JOIN needle
              WHERE ${position("c.content")} > 0
            ),` : ""}
            hits AS MATERIALIZED (
              SELECT tasks.id, tasks.ticket_number, tasks.ticket_ref, tasks.title, tasks.status, tasks.priority, tasks.task_kind, tasks.deferred_at,
                ${updatedAt} AS updated_at_ms,
                ${selected("id", `(coalesce(length(tasks.id) = length(needle.value), 0) AND lower(tasks.id) = needle.value) OR coalesce(tasks.ticket_number = needle.ticket, 0)`)} AS exact_id,
                ${selected("id", `${position("tasks.id")} > 0 OR
                  (tasks.ticket_ref IS NOT NULL AND tasks.ticket_ref <> '' AND ${position("tasks.ticket_ref")} > 0) OR
                  (tasks.ticket_number IS NOT NULL AND instr(cast(tasks.ticket_number AS TEXT), needle.value) > 0)`)} AS id_hit,
                ${selected("title", "coalesce(length(tasks.title) = length(needle.value), 0) AND lower(tasks.title) = needle.value")} AS exact_title,
                ${selected("title", position("tasks.title"))} AS title_at,
                ${selected("description", `tasks.description IS NOT NULL AND tasks.description <> '' AND ${position("tasks.description")} > 0`)} AS description_hit,
                ${selected("labels", `tasks.labels IS NOT NULL AND tasks.labels <> '' AND (tasks.labels <> '[]' OR instr('[]', needle.value) > 0) AND ${position("tasks.labels")} > 0`)} AS labels_hit,
                ${selected("custom_fields", `tasks.custom_fields IS NOT NULL AND tasks.custom_fields <> '' AND (tasks.custom_fields <> '{}' OR instr('{}', needle.value) > 0) AND ${position("tasks.custom_fields")} > 0`)} AS custom_fields_hit,
                ${selected("comments", "tasks.id IN comment_hits")} AS comments_hit,
                (tasks.status NOT IN ('complete', 'archived')) * 6 AS open_boost
              FROM scoped_task_records AS tasks CROSS JOIN needle ${where}
            ),
            page AS (
              SELECT hits.*,
                CASE WHEN exact_id THEN ${EXACT_TASK_IDENTIFIER_SCORE}
                     WHEN exact_title THEN 3000
                     WHEN title_at = 1 THEN 2000
                     ELSE 1000 END
                + (title_at > 0) * 60 + description_hit * 25 + labels_hit * 18
                + custom_fields_hit * 15 + comments_hit * 12 + open_boost AS score
              FROM hits
              WHERE exact_id OR id_hit OR title_at > 0 OR description_hit OR labels_hit OR custom_fields_hit OR comments_hit
              ORDER BY ${orderBy}updated_at_ms DESC, priority ASC, id ASC
              LIMIT ?
            )
            SELECT page.id, page.ticket_number, page.ticket_ref, page.title, page.status, page.priority, page.task_kind, page.deferred_at,
              page.score, page.id_hit, page.exact_id, page.title_at,
              page.description_hit, page.labels_hit, page.custom_fields_hit, page.comments_hit, ${excerpt} AS excerpt
            FROM page JOIN tasks ON tasks.id = page.id CROSS JOIN needle
            ORDER BY ${orderBy}page.updated_at_ms DESC, page.priority ASC, page.id ASC`, [query, ticket, ...args, limit])
    const search = scopedTaskRead(this.scope, searchQuery, "with", "search")
    const result = await this.forOperation(operation).execute(tagTaskProjectionRead(search, "task-search"))

    return result.rows as unknown as TaskCatalogRow[]
  }

  /** Look up the default assignee from app_settings (nullable) */
  async getDefaultAssignee(): Promise<string | null> {
    try {
      const intent = { resource: "task", action: "create" } as const
      if (!(await validateBoardScope(this.scope, this.client, intent)).ok) return null
      const state = localReaderCacheToken(this.client)
      let value: string | null | undefined =
        state && defaultAssigneeCache.get(state.owner)?.token === state.token
          ? defaultAssigneeCache.get(state.owner)!.byBoard.get(this.scope.boardId)
          : undefined
      if (value !== undefined) return value
      const result = await this.client.execute(sql`SELECT value FROM app_settings
        WHERE key = ${`default_assignee:${this.scope.boardId}`} LIMIT 1`)
      if (!(await validateBoardScope(this.scope, this.client, intent)).ok) return null
      value = result.rows.length > 0 ? String((result.rows[0] as Record<string, unknown>).value) : null
      if (state && localReaderCacheToken(this.client)?.token === state.token) {
        let boardCache = defaultAssigneeCache.get(state.owner)
        if (!boardCache || boardCache.token !== state.token) {
          boardCache = { token: state.token, byBoard: new Map() }
          defaultAssigneeCache.set(state.owner, boardCache)
        }
        boardCache.byBoard.set(this.scope.boardId, value)
      }
      return value
    } catch { /* ignore — default is optional */ }
    return null;
  }

  /** Look up a parent task's type for nesting validation */
  async getParentTaskType(parentId: string): Promise<string | null> {
    const result = await this.forOperation("create", [parentId]).execute(scopedTaskRead(this.scope, sourceSql("SELECT task_type FROM scoped_tasks AS tasks WHERE id = ? AND 1 LIMIT 1", [parentId]), "select", "minimal"));
    if (result.rows.length === 0) return null;
    return String((result.rows[0] as Record<string, unknown>).task_type ?? "task");
  }

  /**
   * Insert a new task. Caller is responsible for validation and ID generation.
   * @returns The ticket number allocated by the insert.
   */
  async createTask(data: TaskCreationData, createdAt = Date.now()): Promise<number> {
    const result = await this.createWorkCommand(data, {}, createdAt)
    if (!result.ok) throw new Error(`Task creation ${result.errorCode}`)
    return result.ticketNumber
  }

  private async validateAssignmentTarget(tx: Transaction, assignee: string | null, proof?: AssignmentProof): Promise<boolean> {
    if (!assignee) return true
    if (assignee.startsWith("ha_")) return assignmentProofMatches(proof, this.scope, assignee.slice(3))
    return (await tx.execute(sql`SELECT 1 FROM custom_users WHERE id = ${assignee} LIMIT 1`)).rows.length === 1
  }

  async createWorkCommand(data: TaskCreationData, metadata: WorkCreateMetadata = {}, createdAt = Date.now()): Promise<WorkCreateResult> {
    if (data.assigned_to?.startsWith("ha_") && !metadata.assignmentProof) metadata = { ...metadata, assignmentProof: await resolveHAAssignmentProof(this.scope, data.assigned_to.slice(3), metadata.signal) }
    let client = this.forOperation("create")
    if (isDoneStatus(data.status) || metadata.routineOccurrence?.complete) client = boardOperationClient(client, this.scope, { resource: "task", action: "complete" })
    if (metadata.newLabels?.length) client = boardOperationClient(client, this.scope, { resource: "label", action: "create" })
    metadata.signal?.throwIfAborted()
    const tx = await acquirePrivateBoardWriter(client, this.scope, metadata.signal)
    try {
      const result = await this.createWorkInWriter(tx, data, metadata, createdAt)
      if (!result.ok) return result
      metadata.signal?.throwIfAborted()
      await tx.commit()
      const current = await validateBoardScope(this.scope, this.client, { resource: "task", action: "create" })
      if (!current.ok) throw new BoardOperationError(current.errorCode)
      return result
    } finally { tx.close() }
  }

  /** Internal Tasks-context unit of work for durable draft/Routine compound commands. Never commits the caller's writer. */
  async createWorkInWriter(tx: Transaction, data: TaskCreationData, metadata: WorkCreateMetadata = {}, createdAt = Date.now()): Promise<WorkCreateResult> {
    const admission = await validateBoardScope(this.scope, tx, { resource: "task", action: "create" })
    if (!admission.ok) throw new BoardOperationError(admission.errorCode)
    if (metadata.deriveStatusFromLane) {
      if (!metadata.laneId) return { ok: false, errorCode: "invalid" }
      const { rows: [selected] } = await tx.execute(sql`SELECT key, includes FROM kanban_lanes WHERE board_id = ${this.scope.boardId} AND id = ${metadata.laneId}`)
      if (!selected) return { ok: false, errorCode: "unavailable" }
      let statuses: unknown
      try { statuses = JSON.parse(String(selected.includes)) } catch { return { ok: false, errorCode: "invalid" } }
      const status = Array.isArray(statuses) && typeof statuses[0] === "string" ? statuses[0] : selected.key
      if (typeof status !== "string") return { ok: false, errorCode: "invalid" }
      data = { ...data, status: normalizeStatus(status) }
    }
    const operations = [{ resource: "task", action: "create" },
      ...(isDoneStatus(data.status) || metadata.routineOccurrence?.complete ? [{ resource: "task", action: "complete" }] : []),
      ...(metadata.newLabels?.length ? [{ resource: "label", action: "create" }] : [])] as const
    for (const operation of operations) {
      await requireBoardWriterIntent(tx, this.scope, operation as { resource: "task" | "label", action: "create" | "complete" })
    }
      const intake = scopeIntakeSubmission(this.scope)
      if (intake && (data.task_kind !== "standard_action" || data.status !== intake.status || data.assigned_to !== null && data.assigned_to !== (intake.recipientUserId ? "ha_" + intake.recipientUserId : null) ||
        data.area_id !== null || data.project_id != null || data.goal_id != null || data.parent_id != null || data.labels !== "[]" ||
        metadata.newLabels?.length || metadata.routineOccurrence || metadata.templateSnapshot || metadata.homeLocation || metadata.captureAttemptDigest ||
        metadata.laneId !== undefined && metadata.laneId !== intake.laneId || data.recurrence_rule)) return { ok: false, errorCode: "denied" }
      const assigned = scopeAssignedTo(this.scope)
      if (assigned !== undefined && data.assigned_to !== assigned) return { ok: false, errorCode: "denied" }
      const servicePurpose = scopeServicePurpose(this.scope)
      if (servicePurpose && !["calendar.sync", "todo.sync", "grocy.sync", "builtin.routine.generate", "builtin.recurrence.generate"].includes(servicePurpose)) return { ok: false, errorCode: "denied" }
      if (servicePurpose === "builtin.routine.generate" && (!metadata.routineOccurrence || scopeServiceSourceId(this.scope) !== `routine:${metadata.routineOccurrence.templateId}`)) return { ok: false, errorCode: "denied" }
      if (servicePurpose === "builtin.recurrence.generate" && (!metadata.recurrenceSource || scopeServiceSourceId(this.scope) !== `recurrence:${metadata.recurrenceSource.taskId}`)) return { ok: false, errorCode: "denied" }
      if (servicePurpose && ["calendar.sync", "todo.sync", "grocy.sync"].includes(servicePurpose)) {
        if (!metadata.integrationContext) return { ok: false, errorCode: "denied" }
        await this.requireIntegrationWriter(tx, metadata.integrationContext, "create")
        if (isDoneStatus(data.status)) await this.requireIntegrationWriter(tx, metadata.integrationContext, "complete")
      }
      if (metadata.recurrenceSource) {
        const source = metadata.recurrenceSource
        const { rows: [original] } = await tx.execute(scopedTaskRead(this.scope, sql`SELECT *, ${sourceSql(taskTimestampMs("updated_at"))} AS version FROM scoped_tasks WHERE id = ${source.taskId}`))
        if (!original || original.recurrence_rule !== source.rule || Number(original.version) !== source.version || data.recurrence_rule !== source.rule || data.status !== STATUS.PENDING ||
          data.title !== original.title || data.description !== (original.description ?? "") || data.assigned_to !== original.assigned_to || data.area_id !== original.area_id || data.project_id !== original.project_id || data.goal_id !== original.goal_id) return { ok: false, errorCode: "conflict" }
      }

      if (metadata.templateSnapshot) {
        if (metadata.routineOccurrence || data.task_kind === "routine_instance" || !await validateBoardFeature(this.scope, tx, "routines")) return { ok: false, errorCode: "denied" }
        const snapshot = metadata.templateSnapshot
        await requireBoardWriterCheck(tx, this.scope, async () => {
          const { rows: [template] } = await tx.execute(sql`SELECT is_routine FROM task_templates WHERE id = ${snapshot.templateId}
            AND ${ownedPlanning(this.scope, "task_templates")} AND retired_at IS NULL
            AND template_json = ${snapshot.expectedTemplateJson}`)
          if (!template) throw new BoardOperationError("stale")
          if (Number(template.is_routine) === 1) await requireBoardWriterIntent(tx, this.scope, { resource: "routine", action: "read" })
        })
      }

      const destination = scopeServiceDestination(this.scope)
      if (destination?.projectId && data.project_id !== destination.projectId || destination?.areaId && data.area_id !== destination.areaId) return { ok: false, errorCode: "denied" }
      if (!await validateBoardPlacement(this.scope, tx, { areaId: data.area_id, projectId: data.project_id ?? null })) return { ok: false, errorCode: "denied" }
      if (data.task_kind === "routine_instance" && !metadata.routineOccurrence) return { ok: false, errorCode: "invalid" }
      if (data.task_kind === "routine_instance" && !await validateBoardFeature(this.scope, tx, "routines")) return { ok: false, errorCode: "denied" }
      if (metadata.routineOccurrence) {
        const occurrence = metadata.routineOccurrence
        const periodTimezone = occurrence.timezone ?? "UTC"
        if (data.task_kind !== "routine_instance" || data.due_date !== occurrence.period || !await validateBoardFeature(this.scope, tx, "routines")) return { ok: false, errorCode: "invalid" }
        const { rows: [template] } = await tx.execute(sql`SELECT template_json,cadence FROM task_templates WHERE id = ${occurrence.templateId} AND ${ownedPlanning(this.scope, "task_templates")} AND is_routine = 1 AND retired_at IS NULL`)
        if (!template) return { ok: false, errorCode: "unavailable" }
        const scheduleCurrent = () => template.template_json === occurrence.expectedTemplateJson &&
          String(template.cadence ?? "daily") === occurrence.expectedCadence &&
          routinePeriod(String(template.cadence ?? "daily"), new Date(createdAt), periodTimezone) === occurrence.period
        if (!scheduleCurrent()) return { ok: false, errorCode: "conflict" }
        await requireBoardWriterCheck(tx, this.scope, async () => {
          const { rows: [current] } = await tx.execute(sql`SELECT template_json,cadence FROM task_templates WHERE id=${occurrence.templateId} AND ${ownedPlanning(this.scope, "task_templates")} AND is_routine=1 AND retired_at IS NULL`)
          if (!current || current.template_json !== occurrence.expectedTemplateJson ||
            String(current.cadence ?? "daily") !== occurrence.expectedCadence ||
            routinePeriod(String(current.cadence ?? "daily"), new Date(), periodTimezone) !== occurrence.period) throw new BoardOperationError("stale")
        })
        const { rows: [identity] } = await tx.execute(sql`SELECT id FROM tasks WHERE task_board_id IS ${storageBoardId(this.scope)}
          AND source_template_id = ${occurrence.templateId} AND due_date = ${occurrence.period} ORDER BY created_at, id LIMIT 1`)
        const { rows: [existing] } = identity ? await tx.execute(scopedTaskRead(this.scope, sql`SELECT * FROM scoped_tasks AS tasks WHERE id = ${String(identity.id)}`)) : { rows: [] }
        if (identity && !existing) return { ok: false, errorCode: "unavailable" }
        if (existing) {
          if (isDoneStatus(String(existing.status))) {
            return { ok: true, task: existing as unknown as TaskRow, ticketNumber: Number(existing.ticket_number), replayed: true, newlyCompleted: false }
          }
          if (occurrence.complete && data.project_id) {
            const activeProject = await tx.execute(sql`SELECT id FROM projects WHERE id = ${data.project_id} AND ${ownedPlanning(this.scope, "projects")} AND retired_at IS NULL AND status = 'active'`)
            if (!activeProject.rows.length) return { ok: false, errorCode: "unavailable" }
          }
          let task = existing as unknown as TaskRow
          let transitioned = false
          if (occurrence.complete) {
            const updatePatch: Record<string, InValue> = { status: STATUS.COMPLETE }
            if (typeof existing.checklists === "string") {
              try {
                const parsedChecklist: unknown = JSON.parse(existing.checklists)
                if (Array.isArray(parsedChecklist) && parsedChecklist.length > 0) {
                  updatePatch.checklists = JSON.stringify(parsedChecklist.map((entry) =>
                    entry && typeof entry === "object" && !Array.isArray(entry) ? { ...entry, done: true } : entry
                  ))
                }
              } catch { /* ignore malformed historical checklist JSON */ }
            }
            const completed = await this.updateTaskCommand(String(existing.id), updatePatch, {}, tx)
            if (!completed.ok) return { ok: false, errorCode: completed.errorCode === "conflict" ? "conflict" : "unavailable" }
            task = completed.task
            transitioned = true
          }
          return { ok: true, task, ticketNumber: Number(existing.ticket_number), replayed: true, newlyCompleted: transitioned }
        }
        if (data.project_id) {
          const activeProject = await tx.execute(sql`SELECT id FROM projects WHERE id = ${data.project_id} AND ${ownedPlanning(this.scope, "projects")} AND retired_at IS NULL AND status = 'active'`)
          if (!activeProject.rows.length) return { ok: false, errorCode: "unavailable" }
        }
      }
      const areaId = data.area_id ?? null
      for (const [table, id] of [["areas", areaId], ["projects", data.project_id]] as const) {
        if (!id) continue
        const found = await tx.execute(sql`SELECT id FROM ${sourceSql(table)} WHERE id = ${id} AND ${ownedPlanning(this.scope, table)} AND retired_at IS NULL`)
        if (!found.rows.length) return { ok: false, errorCode: "unavailable" }
      }
      if (data.goal_id && !metadata.routineOccurrence && !metadata.recurrenceSource) await requireBoardWriterCheck(tx, this.scope, async () => {
        if (!await validateBoardFeature(this.scope, tx, "goals")) throw new BoardOperationError("unavailable")
      })
      if (data.goal_id && !(await tx.execute(sql`SELECT 1 WHERE ${goalEligibility(this.scope, sql`${data.goal_id}`, { areaId: sql`${areaId}`, projectId: sql`${data.project_id ?? null}` })}`)).rows.length) return { ok: false, errorCode: "unavailable" }
      if (data.parent_id) {
        const { rows: [parentRow] } = await tx.execute(sql`SELECT id, task_type FROM tasks WHERE id = ${data.parent_id} AND ${taskOwnedBy(this.scope)} LIMIT 1`)
        if (!parentRow || !await validateTaskOperation(tx, this.scope, data.parent_id, { resource: "task", action: "read" })) {
          return { ok: false, errorCode: "unavailable" }
        }
        const typeViolation = validateParentChildType(String(parentRow.task_type ?? "task"), data.task_type)
        if (typeViolation) return { ok: false, errorCode: "hierarchy_invalid", message: typeViolation }
        const { rows: [depthRow] } = await tx.execute(sql`WITH RECURSIVE chain(id, parent_id, depth) AS (
          SELECT id, parent_id, 1 FROM tasks WHERE id = ${data.parent_id} AND task_board_id IS ${storageBoardId(this.scope)}
          UNION ALL
          SELECT ancestor.id, ancestor.parent_id, chain.depth + 1 FROM tasks AS ancestor JOIN chain ON chain.parent_id = ancestor.id
            WHERE ancestor.task_board_id IS ${storageBoardId(this.scope)} AND chain.depth < 32
        ) SELECT MAX(depth) AS depth FROM chain`)
        if (Number(depthRow?.depth ?? 1) >= MAX_TASK_HIERARCHY_DEPTH) {
          return { ok: false, errorCode: "hierarchy_invalid", message: `Maximum task hierarchy depth is ${MAX_TASK_HIERARCHY_DEPTH} levels.` }
        }
      }
      if (data.project_id && areaId) {
        const project = await tx.execute(sql`SELECT id FROM projects WHERE id = ${data.project_id} AND area_id = ${areaId} AND ${ownedPlanning(this.scope, "projects")} AND retired_at IS NULL`)
        if (!project.rows.length) return { ok: false, errorCode: "invalid" }
      }
      if (metadata.homeLocation && (!await validateBoardFeature(this.scope, tx, "home_assistant_area") || !(await tx.execute(readHomeAssistantAreaPolicyRevision(metadata.homeLocation.revision))).rows.length)) return { ok: false, errorCode: "denied" }
      if (metadata.captureAttemptDigest) {
        const existing = await tx.execute(sql`SELECT id FROM tasks WHERE capture_attempt_digest = ${metadata.captureAttemptDigest}`)
        if (existing.rows.length) return { ok: false, errorCode: "capture_conflict" }
      }
      const operationOwner = createHash("sha256").update(JSON.stringify([1, this.scope.principal.kind, this.scope.principal.id, "task.create"])).digest("hex")
      const digest = createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(data).filter(([key]) => !["id", "source", "created_by"].includes(key))))).digest("hex")
      if (metadata.clientIdempotencyKey) {
        const { rows: [previous] } = await tx.execute(sql`SELECT id, operation_digest FROM tasks WHERE ${taskOwnedBy(this.scope)} AND operation_owner = ${operationOwner} AND client_idempotency_key = ${metadata.clientIdempotencyKey}`)
        if (previous) {
          if (previous.operation_digest !== digest) return { ok: false, errorCode: "conflict" }
          const found = await tx.execute(scopedTaskRead(this.scope, sql`SELECT * FROM scoped_tasks AS tasks WHERE id = ${String(previous.id)}`))
          if (!found.rows[0]) return { ok: false, errorCode: "unavailable" }
          return { ok: true, task: found.rows[0] as unknown as TaskRow, ticketNumber: Number(found.rows[0]?.ticket_number), replayed: true, newlyCompleted: false }
        }
        // A predecessor raw key without proven principal ownership cannot be seized.
        const legacy = await tx.execute(sql`SELECT id FROM tasks WHERE ${taskOwnedBy(this.scope)} AND idempotency_key = ${metadata.clientIdempotencyKey} AND operation_owner IS NULL`)
        if (legacy.rows.length) return { ok: false, errorCode: "legacy_key_owner_unverified" }
      }
      const { rows: [lane] } = await tx.execute(sql`SELECT id FROM kanban_lanes WHERE board_id = ${this.scope.boardId}
        AND EXISTS (SELECT 1 FROM json_each(includes) WHERE lower(value) = ${normalizeStatus(data.status)}) AND (${intake?.laneId ?? metadata.laneId ?? null} IS NULL OR id = ${intake?.laneId ?? metadata.laneId ?? null}) ORDER BY position, id LIMIT 1`)
      if (!lane) return { ok: false, errorCode: "invalid" }
      await requireBoardWriterCheck(tx, this.scope, async () => {
        if (!await this.validateAssignmentTarget(tx, data.assigned_to, metadata.assignmentProof)) throw new BoardOperationError("denied")
      })
      let internalKey = ""
      for (let attempt = 0; attempt < 4; attempt++) {
        const candidate = crypto.randomUUID()
        if (!(await tx.execute(sql`SELECT 1 FROM tasks WHERE idempotency_key = ${candidate} LIMIT 1`)).rows.length) { internalKey = candidate; break }
      }
      if (!internalKey) return { ok: false, errorCode: "conflict" }
      const { rows: [counter] } = await tx.execute(sql`SELECT ticket_high_water + 1 AS number, ticket_prefix FROM task_boards WHERE id = ${this.scope.boardId} AND ticket_high_water < 9007199254740991`)
      if (!counter) return { ok: false, errorCode: "invalid" }
      const ticketNumber = Number(counter.number)
      const ticketKey = `${counter.ticket_prefix}-${ticketNumber}`
      if (storageBoardId(this.scope) !== null) await tx.execute(sql`UPDATE task_boards SET ticket_high_water = ${ticketNumber} WHERE id = ${this.scope.boardId}`)
      let taskOwner = "human"
      if (data.assigned_to && !data.assigned_to.startsWith("ha_")) {
        const { rows: [assignee] } = await tx.execute(sql`SELECT kind, name FROM custom_users WHERE id = ${data.assigned_to}`)
        if (assignee?.kind === "agent") taskOwner = `bot:${String(assignee.name)}`
      }
      const requestId = metadata.requestId ?? crypto.randomUUID()
      await tx.execute(taskInsertStatement(this.scope, data, createdAt, {
        ticketNumber, ticketKey, laneId: String(lane.id), owner: taskOwner, requestId, idempotencyKey: internalKey,
        clientIdempotencyKey: metadata.clientIdempotencyKey ?? null, operationOwner, operationDigest: digest, captureAttemptDigest: metadata.captureAttemptDigest ?? null, sourceTemplateId: metadata.routineOccurrence?.templateId ?? null,
      }))
      if (storageBoardId(this.scope) !== null && (areaId || data.project_id || data.goal_id)) await tx.execute(sql`INSERT INTO board_task_planning(task_id, area_id, project_id, goal_id) VALUES (${data.id}, ${areaId}, ${data.project_id ?? null}, ${data.goal_id ?? null})`)
      if (metadata.activityActor) await tx.execute(taskAddedActivity(this.scope, data.id, metadata.activityActor, createdAt))
      for (const label of metadata.newLabels ?? []) await tx.execute(taskLabelInsert(this.scope, label, data.id, requestId))
      if (metadata.homeLocation) await tx.execute(setTaskHomeAssistantArea(this.scope, data.id, metadata.homeLocation.id))
      const result = await tx.execute(scopedTaskRead(this.scope, sql`SELECT * FROM scoped_tasks AS tasks WHERE id = ${data.id}`))
      if (!result.rows[0]) throw new BoardOperationError("unavailable")
      return { ok: true, task: result.rows[0] as unknown as TaskRow, ticketNumber, replayed: false, newlyCompleted: isDoneStatus(String(result.rows[0].status)) }
  }

  async findCaptureReceipt(digest: string): Promise<{ id: string, ticket_key: string, task_kind: string } | null> {
    const { rows: [row] } = await this.forOperation("read").execute(scopedTaskRead(this.scope, sql`SELECT tasks.id, tasks.task_kind, tasks.ticket_ref AS ticket_key
      FROM scoped_tasks AS tasks JOIN tasks AS receipt_task ON receipt_task.id = tasks.id
      WHERE ${taskOwnedBy(this.scope, "receipt_task")} AND receipt_task.capture_attempt_digest = ${digest}`))
    return row ? { id: String(row.id), ticket_key: String(row.ticket_key), task_kind: String(row.task_kind) } : null
  }

  /** Resolve a physical tag without silently choosing duplicate assignments. */
  async findByNfcTag(tagId: string): Promise<Array<{ id: string; title: string; status: string }>> {
    const result = await this.forOperation("read").execute(scopedTaskRead(this.scope, sourceSql("SELECT id, title, status FROM scoped_tasks AS tasks WHERE 1 AND nfc_tag_id = ? AND status != 'archived' ORDER BY id LIMIT 2", [tagId]), "select"))
    return result.rows as unknown as Array<{ id: string; title: string; status: string }>
  }

  /** Command-only NFC locator. No Task read grant or transport projection. */
  async findNfcCompletionTargets(tagId: string): Promise<Array<{ id: string; status: string }>> {
    const assigned = scopeAssignedTo(this.scope)
    const result = await this.readCommandStatement("complete", scopedTaskRead(this.scope, sql`SELECT id,status FROM scoped_tasks AS tasks
      WHERE nfc_tag_id=${tagId} AND status != 'archived'
      ${assigned === undefined ? sourceSql("") : sql`AND assigned_to=${assigned}`} ORDER BY id LIMIT 2`))
    return result.rows.map(row => ({ id: String(row.id), status: String(row.status) }))
  }

  /** A successful assigned-only hand-off can be acknowledged after its old assignment ends. */
  async findReassignmentReceipt(idOrKey: string, requestId: string, requestedAssignee: string | null): Promise<{ id: string, ticket_key: string, assigned_to: string | null } | null> {
    const assigned = scopeAssignedTo(this.scope)
    if (this.scope.principal.kind !== "agent" || typeof assigned !== "string" || !requestId || requestId.length > 128) return null
    const tx = await this.forOperation("assign").transaction("read")
    let candidate: { taskId: string, eventId: string } | undefined
    try {
      const number = this.ticketNumberForScope(idOrKey)
      const { rows: [task] } = await tx.execute(scopedTaskRead(this.scope, sql`SELECT id FROM scoped_tasks
        WHERE (id = ${idOrKey} OR ticket_number = ${number}) AND assigned_to IS ${requestedAssignee} LIMIT 1`))
      if (!task) return null
      const receiptKey = `${this.scope.principal.tokenId}:${assigned}:${task.id}:${requestId}`
      const { rows: [receipt] } = await tx.execute(sql`SELECT attempt_id FROM integration_attempts
        WHERE integration = 'task.reassignment' AND task_id = ${String(task.id)} AND request_id = ${requestId}
          AND idempotency_key = ${receiptKey} AND status = 'completed' LIMIT 1`)
      if (!receipt) return null
      candidate = { taskId: String(task.id), eventId: String(receipt.attempt_id) }
      await tx.commit()
    } finally { tx.close() }
    // The locator grants no replay authority. Reuse the same current, exact commit
    // proof as outward assignment dispatch, including immutable actor and placement.
    const receipt = await readTaskAssignmentReceipt(this.client, this.scope, candidate.eventId, candidate.taskId)
    if (!receipt || receipt.task.assigned_to !== requestedAssignee || typeof receipt.task.ticket_key !== "string") return null
    return { id: receipt.id, ticket_key: receipt.task.ticket_key, assigned_to: requestedAssignee }
  }

  /** Read receipt ownership and assignment log history for idempotent agent hand-off retries. */
  async findReassignmentReplayState(
    taskId: string,
    receiptKey: string,
    requestId: string,
  ): Promise<ReassignmentReplayState> {
    const [receiptRes, otherRes, latestActivityRes] = await this.forOperation("assign", [taskId]).batch([
      scopedTaskRead(this.scope, sourceSql("SELECT status, response_payload, updated_at FROM integration_attempts WHERE integration = 'task.reassignment' AND task_id = ? AND idempotency_key = ? LIMIT 1", [taskId, receiptKey]), "select"),
      scopedTaskRead(this.scope, sourceSql("SELECT 1 FROM integration_attempts WHERE integration = 'task.reassignment' AND task_id = ? AND request_id = ? AND idempotency_key != ? LIMIT 1", [taskId, requestId, receiptKey]), "select"),
      scopedTaskRead(this.scope, sourceSql("SELECT old_value, new_value, actor, actor_type, correlation_id, created_at FROM task_activity_log WHERE task_id = ? AND field = 'assigned_to' ORDER BY created_at DESC, id DESC LIMIT 1", [taskId]), "select"),
    ], "read")
    const receiptRow = receiptRes?.rows[0] as Record<string, unknown> | undefined
    const activityRow = latestActivityRes?.rows[0] as Record<string, unknown> | undefined
    return {
      receipt: receiptRow
        ? {
          status: String(receiptRow.status),
          response_payload: typeof receiptRow.response_payload === "string" ? receiptRow.response_payload : null,
          updated_at: Number(receiptRow.updated_at),
        }
        : null,
      ownedByOtherToken: (otherRes?.rows.length ?? 0) > 0,
      lastReassignment: activityRow
        ? {
          old_value: typeof activityRow.old_value === "string" ? activityRow.old_value : null,
          new_value: typeof activityRow.new_value === "string" ? activityRow.new_value : null,
          actor: String(activityRow.actor),
          actor_type: String(activityRow.actor_type),
          correlation_id: typeof activityRow.correlation_id === "string" ? activityRow.correlation_id : null,
          created_at: Number(activityRow.created_at),
        }
        : null,
    }
  }

  /** Atomic agent hand-back, including note and owned retry receipt, without task-read authority. */
  async handBackTaskCommand(idOrKey: string, options: { to?: string | null, note?: string, requestId?: string } = {}): Promise<
    { ok: true, id: string, ticket_key: string, assigned_to: string | null, note_posted: boolean, replayed: boolean, eventId: string } |
    { ok: false, errorCode: "unavailable" | "conflict" | "invalid" }
  > {
    if (this.scope.principal.kind !== "agent" || options.note !== undefined && (!options.note.trim() || options.note.length > 10000 || hasCommentMentionSelector(options.note)) ||
      options.to !== undefined && options.to !== null && !/^(ha|custom)_[\w-]{1,128}$/.test(options.to) ||
      options.requestId !== undefined && (!options.requestId.trim() || options.requestId.length > 128)) return { ok: false, errorCode: "invalid" }
    const note = options.note === undefined ? undefined : sanitize(options.note).trim()
    if (options.note !== undefined && !note) return { ok: false, errorCode: "invalid" }
    const requestId = options.requestId?.trim() ?? crypto.randomUUID()
    const inputDigest = createHash("sha256").update(JSON.stringify({ to: options.to === undefined ? "automatic" : options.to, note: note ?? "" })).digest("hex")
    const reader = await this.forOperation("assign").transaction("read")
    let selected: { id: string, version: number, assignee: string, tokenName: string, target: string | null, fallback: string | null, key: string }
    try {
      const number = this.ticketNumberForScope(idOrKey)
      const { rows: [task] } = await reader.execute(scopedTaskRead(this.scope, sql`SELECT id, assigned_to, ${sourceSql(taskTimestampMs("updated_at"))} AS version
        FROM scoped_tasks WHERE id = ${idOrKey} OR ticket_number = ${number} LIMIT 1`))
      if (!task) return { ok: false, errorCode: "unavailable" }
      const key = createHash("sha256").update(JSON.stringify(["mcp.handback", this.scope.boardId, this.scope.principal.tokenId, task.id, requestId])).digest("hex")
      const { rows: [receipt] } = await reader.execute(sql`SELECT response_payload FROM integration_attempts WHERE integration = 'mcp.handback' AND idempotency_key = ${key} AND task_id = ${String(task.id)} AND status = 'completed'`)
      if (receipt) {
        let saved: Record<string, unknown>
        try { saved = JSON.parse(String(receipt.response_payload)) } catch { return { ok: false, errorCode: "conflict" } }
        if (saved.inputDigest !== inputDigest || saved.id !== task.id || typeof saved.ticket_key !== "string" || typeof saved.eventId !== "string" || saved.assigned_to !== null && typeof saved.assigned_to !== "string") return { ok: false, errorCode: "conflict" }
        if (saved.assigned_to !== task.assigned_to) return { ok: false, errorCode: "unavailable" }
        const proof = saved._authority as Record<string, unknown> | undefined
        const standard = await reader.execute(sql`SELECT 1 FROM integration_attempts WHERE integration = 'task.reassignment' AND task_id = ${String(task.id)} AND idempotency_key = ${`${this.scope.principal.tokenId}:${proof?.oldAssignedTo}:${task.id}:${requestId}`} AND status = 'completed'`)
        if (!standard.rows.length) return { ok: false, errorCode: "unavailable" }
        await reader.commit()
        return { ok: true, id: String(task.id), ticket_key: saved.ticket_key, assigned_to: saved.assigned_to as string | null, note_posted: saved.note_posted === true, replayed: true, eventId: saved.eventId as string }
      }
      const { rows: [token] } = await reader.execute(sql`SELECT assignee_id, name FROM agent_tokens WHERE id = ${this.scope.principal.tokenId}`)
      if (!token || typeof token.assignee_id !== "string" || task.assigned_to !== token.assignee_id) return { ok: false, errorCode: "unavailable" }
      if (options.to === token.assignee_id) return { ok: false, errorCode: "invalid" }
      const { rows: identities } = await reader.execute(sql`SELECT 1 FROM custom_users WHERE id = ${token.assignee_id} AND kind = 'agent'`)
      if (!identities.length) return { ok: false, errorCode: "unavailable" }
      let target = options.to ?? null
      let fallbackTarget: string | null = null
      if (options.to === undefined) {
        const { rows: [previous] } = await reader.execute(sql`SELECT old_value FROM task_activity_log WHERE task_id = ${String(task.id)} AND field = 'assigned_to'
          AND new_value = ${token.assignee_id} ORDER BY created_at DESC, id DESC LIMIT 1`)
        const candidate = typeof previous?.old_value === "string" ? previous.old_value : null
        const { rows: [fallback] } = await reader.execute(sql`SELECT value FROM app_settings WHERE key = ${`default_assignee:${this.scope.boardId}`}`)
        fallbackTarget = typeof fallback?.value === "string" && fallback.value !== token.assignee_id ? fallback.value : null
        target = candidate && candidate !== token.assignee_id && /^(ha|custom)_[\w-]{1,128}$/.test(candidate) ? candidate :
          fallbackTarget
      }
      selected = { id: String(task.id), version: Number(task.version), assignee: token.assignee_id, tokenName: typeof token.name === "string" ? token.name : "Agent", target, fallback: fallbackTarget, key }
      await reader.commit()
    } finally { reader.close() }
    const preflightTarget = async (target: string | null) => {
      if (!target) return { valid: true, proof: undefined }
      if (target.startsWith("ha_")) {
        const proof = await resolveHAAssignmentProof(this.scope, target.slice(3))
        return { valid: Boolean(proof), proof }
      }
      const { rows } = await this.forOperation("assign").execute(sql`SELECT 1 FROM custom_users WHERE id = ${target}`)
      return { valid: rows.length === 1, proof: undefined }
    }
    let evidence = await preflightTarget(selected.target)
    if (!evidence.valid && options.to === undefined) {
      selected.target = selected.fallback
      evidence = await preflightTarget(selected.target)
      if (!evidence.valid) { selected.target = null; evidence = { valid: true, proof: undefined } }
    }
    if (!evidence.valid) return { ok: false, errorCode: "invalid" }
    let assignmentProof = evidence.proof
    const tx = await acquireWriteTransaction(this.forOperation("assign"))
    try {
      const { rows: [existing] } = await tx.execute(sql`SELECT response_payload FROM integration_attempts WHERE integration = 'mcp.handback' AND idempotency_key = ${selected.key} AND task_id = ${selected.id} AND status = 'completed'`)
      if (existing) {
        let saved: Record<string, unknown>
        try { saved = JSON.parse(String(existing.response_payload)) } catch { return { ok: false, errorCode: "conflict" } }
        if (saved.inputDigest !== inputDigest || saved.id !== selected.id || typeof saved.ticket_key !== "string" || typeof saved.eventId !== "string" || saved.assigned_to !== null && typeof saved.assigned_to !== "string") return { ok: false, errorCode: "conflict" }
        const { rows: [current] } = await tx.execute(scopedTaskRead(this.scope, sql`SELECT assigned_to FROM scoped_tasks WHERE id = ${selected.id}`))
        const proof = saved._authority as Record<string, unknown> | undefined
        const standard = await tx.execute(sql`SELECT 1 FROM integration_attempts WHERE integration = 'task.reassignment' AND task_id = ${selected.id} AND idempotency_key = ${`${this.scope.principal.tokenId}:${proof?.oldAssignedTo}:${selected.id}:${requestId}`} AND status = 'completed'`)
        if (!current || current.assigned_to !== saved.assigned_to || !standard.rows.length) return { ok: false, errorCode: "unavailable" }
        await tx.commit()
        return { ok: true, id: selected.id, ticket_key: saved.ticket_key, assigned_to: saved.assigned_to as string | null, note_posted: saved.note_posted === true, replayed: true, eventId: saved.eventId as string }
      }
      const { rows: [currentToken] } = await tx.execute(sql`SELECT assignee_id, name FROM agent_tokens WHERE id = ${this.scope.principal.tokenId}`)
      if (currentToken?.assignee_id !== selected.assignee) return { ok: false, errorCode: "conflict" }
      if (typeof currentToken.name === "string") selected.tokenName = currentToken.name
      if (selected.target && !await this.validateAssignmentTarget(tx, selected.target, assignmentProof)) {
        if (options.to !== undefined) return { ok: false, errorCode: "invalid" }
        selected.target = null; assignmentProof = undefined
      }
      const actor: RecentTaskActor = { kind: "agent", personKey: null, provenance: { tokenName: selected.tokenName, originKind: "agent_token", originName: null, originTarget: null } }
      const updated = await this.updateTaskCommand(selected.id, { assigned_to: selected.target }, {
        version: { updatedAt: selected.version }, expectedAssignedTo: selected.assignee, assignmentProof,
        activity: actor, activityRequestId: requestId,
        reassignmentReceipt: { key: `${this.scope.principal.tokenId}:${selected.assignee}:${selected.id}:${requestId}`, requestId, assignedTo: selected.target },
      }, tx)
      if (!updated.ok) return { ok: false, errorCode: updated.errorCode === "conflict" ? "conflict" : "unavailable" }
      if (note) await tx.execute(sql`INSERT INTO comments(task_id,content,author,owner_key,inactivity_spike_human)
        SELECT id, ${note}, ${stripHtml(selected.tokenName).trim().slice(0, 80) || "Agent"}, ${createHash("sha256").update(`comment-owner:automation:${this.scope.principal.tokenId}`).digest("hex")}, 0
        FROM tasks WHERE id = ${selected.id} AND ${taskOwnedBy(this.scope)}`)
      const result = { id: selected.id, ticket_key: String(updated.task.ticket_ref), assigned_to: selected.target, note_posted: Boolean(note) }
      const eventId = crypto.randomUUID()
      const task = { ...projectPublicTaskFields(updated.task), id: selected.id, board_id: this.scope.boardId, ticket_key: result.ticket_key }
      const bindingRefs = ((await readWorkDestinations(tx))?.bindings ?? []).filter(binding => binding.enabled && binding.destination.boardId === this.scope.boardId &&
        binding.allowedOperations.some(operation => operation.resource === "task" && operation.action === "read")).map(binding => ({ id: binding.id, generation: binding.generation }))
      const { rows: [written] } = await tx.execute(scopedTaskRead(this.scope, sql`SELECT ${sourceSql(taskTimestampMs("updated_at"))} AS version FROM scoped_tasks WHERE id = ${selected.id}`))
      const placement = await this.effectiveTaskPlacement(tx, updated.task)
      const receipt = { ...result, inputDigest, eventId, task, _authority: { version: 1, boardId: this.scope.boardId, principalKind: this.scope.principal.kind,
        principalId: this.scope.principal.id, operation: "assign", oldAssignedTo: selected.assignee, taskVersion: Number(written!.version), placement, bindingRefs } }
      await tx.execute(sql`INSERT INTO integration_attempts(attempt_id,task_id,integration,request_id,idempotency_key,status,response_payload,created_at,updated_at)
        VALUES (${eventId}, ${selected.id}, 'mcp.handback', ${requestId}, ${selected.key}, 'completed', ${JSON.stringify(receipt)}, ${Date.now()}, ${Date.now()})`)
      await tx.commit()
      return { ok: true, ...result, replayed: false, eventId }
    } finally { tx.close() }
  }

  async fileTask(id: string, version: number, placement: { areaId?: string | null, projectId?: string | null }) {
    const result = await this.updateTask(id, {
      ...(placement.areaId === undefined ? {} : { area_id: placement.areaId }),
      ...(placement.projectId === undefined ? {} : { project_id: placement.projectId }),
    }, { version: { updatedAt: version } })
    return result.ok ? { ok: true, task: result.task } as const : { ok: false, stale: result.errorCode === "conflict" } as const
  }

  /** Compatibility name; all Boards use the same filing command. */
  async fileHouseholdTask(id: string, version: number, placement: { areaId?: string | null, projectId?: string | null }) {
    return this.fileTask(id, version, placement)
  }

  /** Apply a partial update with atomic dependency, version and checklist guards. */
  async updateTask(id: string, fields: Record<string, InValue>, options: {
    version?: { updatedAt: number, expectedStatus?: "backlog" }, expectedChecklists?: string | null,
    expectedAssignedTo?: string, activity?: RecentTaskActor, activityRequestId?: string,
    reassignmentReceipt?: { key: string, requestId: string, assignedTo: string | null }, signal?: AbortSignal | undefined,
    assignmentProof?: AssignmentProof | undefined, recurrenceAssignment?: { assigneeId: string | null, proof?: AssignmentProof | undefined } | undefined,
  } = {}) {
    if (typeof fields.assigned_to === "string" && fields.assigned_to.startsWith("ha_") && !options.assignmentProof) options = { ...options, assignmentProof: await resolveHAAssignmentProof(this.scope, fields.assigned_to.slice(3), options.signal) }
    if (typeof fields.status === "string" && isDoneStatus(fields.status) && !options.recurrenceAssignment) {
      const { rows: [probe] } = await this.readCommandStatement(
        "complete",
        sql`SELECT recurrence_rule, assigned_to FROM tasks WHERE ${taskOwnedBy(this.scope)} AND id = ${id} LIMIT 1`,
        [id],
      )
      if (probe?.recurrence_rule && String(probe.recurrence_rule)) {
        const assigneeId = probe.assigned_to ? String(probe.assigned_to) : null
        options = { ...options, recurrenceAssignment: { assigneeId,
          ...(assigneeId?.startsWith("ha_") ? { proof: await resolveHAAssignmentProof(this.scope, assigneeId.slice(3), options.signal) } : {}),
        } }
      }
    }
    return this.updateTaskCommand(id, fields, options)
  }

  private async updateTaskCommand(
    id: string,
    fields: Record<string, InValue>,
    { version, expectedChecklists, expectedAssignedTo, activity, reassignmentReceipt, signal, assignmentProof, recurrenceAssignment, activityRequestId }: {
      version?: { updatedAt: number; expectedStatus?: "backlog" }
      expectedChecklists?: string | null
      expectedAssignedTo?: string
      activity?: RecentTaskActor
      activityRequestId?: string
      /** Saved with the update, or not at all, so a retry of a hand-off can always be recognised. */
      reassignmentReceipt?: { key: string; requestId: string; assignedTo: string | null }
      signal?: AbortSignal | undefined
      assignmentProof?: AssignmentProof | undefined
      recurrenceAssignment?: { assigneeId: string | null, proof?: AssignmentProof | undefined } | undefined
    } = {},
    existingWriter?: Transaction,
    targetLaneId?: string,
    integrationContext?: IntegrationScope,
  ): Promise<
    { ok: true; task: TaskRow; previousStatus?: string; successor?: RecurrenceSuccessor; assignmentEventId?: string }
    | { ok: false; errorCode: "unavailable"; reason?: "routine-date" }
    | { ok: false; errorCode: "assignee_mismatch" }
    | { ok: false; errorCode: "checklist_conflict"; checklists: string | null }
    | { ok: false; errorCode: "conflict"; updatedAt: number }
    | { ok: false; errorCode: "blocked"; blockers: TaskBlocker[] }
    | { ok: false; errorCode: "hierarchy_invalid"; message: string }
    | { ok: false; errorCode: "hierarchy_conflict"; message: string }
  > {
    signal?.throwIfAborted()
    let commandClient = this.forOperation("edit", [id])
    if (typeof fields.status === "string" && isDoneStatus(fields.status)) commandClient = boardOperationClient(commandClient, this.scope, { resource: "task", action: "complete" })
    else if (typeof fields.status === "string") commandClient = boardOperationClient(commandClient, this.scope, { resource: "task", action: "edit" }, [id], async reader => {
      const { rows: [current] } = await reader.execute(sql`SELECT status FROM tasks WHERE id = ${id} AND ${taskOwnedBy(this.scope)}`)
      return current && isDoneStatus(String(current.status)) ? [{ resource: "task", action: "reopen" }] : []
    })
    if (Object.hasOwn(fields, "assigned_to")) commandClient = boardOperationClient(commandClient, this.scope, { resource: "task", action: "assign" })
    const editable = new Set([
      "title", "description", "status", "priority", "due_date", "time_tracked", "labels", "framework_payload", "parent_id", "area_id", "project_id", "goal_id",
      "custom_fields", "start_date", "end_date", "progress", "color", "is_promoted", "task_type", "task_kind", "summary",
      "recurrence_rule", "recurrence_anchor", "rotation_mode", "nfc_tag_id", "checklists", "reminder_at", "assigned_to", "time_block_start", "time_block_end",
      "urgency", "importance", "eisenhower_override", "effort_minutes", "effort_type", "blocked_by",
    ])
    if (Object.keys(fields).some(column => !editable.has(column))) return { ok: false, errorCode: "unavailable" }
    if (scopeServicePurpose(this.scope) && (!integrationContext || integrationContext.scope !== this.scope || !existingWriter)) throw new BoardOperationError("denied")
    const placementChanged = ["area_id", "project_id", "goal_id"].some(column => Object.hasOwn(fields, column))
    if (placementChanged) commandClient = boardOperationClient(commandClient, this.scope, { resource: "task", action: "move" })
    const updates: string[] = []
    const args: InValue[] = []
    for (const [column, value] of Object.entries(fields)) {
      if (storageBoardId(this.scope) !== null && ["area_id", "project_id", "goal_id"].includes(column)) continue
      updates.push(`${column} = ?`)
      args.push(column === "area_id" && value === null ? "__meitheal_no_area__" : value)
    }
    if (!Object.keys(fields).length) return { ok: false, errorCode: "unavailable" }
    if (typeof fields.status === "string" && storageBoardId(this.scope) !== null) {
      updates.push("board_column_id = (SELECT id FROM kanban_lanes WHERE board_id = ? AND EXISTS (SELECT 1 FROM json_each(includes) WHERE lower(value) = ?) ORDER BY position, id LIMIT 1)")
      args.push(this.scope.boardId, normalizeStatus(fields.status))
      if (targetLaneId) { updates[updates.length - 1] = "board_column_id = ?"; args.splice(args.length - 2, 2, targetLaneId) }
    }
    if (Object.hasOwn(fields, "assigned_to")) {
      updates.push("owner = CASE WHEN assigned_to IS ? THEN owner ELSE COALESCE((SELECT CASE WHEN kind = 'agent' THEN 'bot:' || name ELSE 'human' END FROM custom_users WHERE id = ?), 'human') END")
      args.push(fields.assigned_to ?? null, fields.assigned_to ?? null)
    }
    const storedVersion = taskTimestampMs("updated_at")
    updates.push(`updated_at = ${nextTaskTimestampMs("updated_at")}`)
    const guards = [sql`id = ${id}`, taskOwnedBy(this.scope)]
    const assigned = scopeAssignedTo(this.scope)
    if (assigned !== undefined) guards.push(sql`assigned_to = ${assigned}`)
    for (const [column, table] of [["area_id", "areas"], ["project_id", "projects"]] as const) {
      const value = fields[column]
      if (typeof value === "string") guards.push(sql`EXISTS (SELECT 1 FROM ${sourceSql(table)} WHERE id = ${value} AND ${ownedPlanning(this.scope, table)} AND retired_at IS NULL)`)
    }
    if (typeof fields.goal_id === "string" || placementChanged) {
      const goal = fields.goal_id === undefined ? taskField(this.scope, "goal_id") : sql`${fields.goal_id}`
      const area = fields.area_id === undefined ? taskField(this.scope, "area_id") : sql`${fields.area_id}`
      const project = fields.project_id === undefined ? taskField(this.scope, "project_id") : sql`${fields.project_id}`
      guards.push(sql`(${goal} IS NULL OR ${goalEligibility(this.scope, goal, { areaId: area, projectId: project })})`)
    }
    if (typeof fields.parent_id === "string") guards.push(sql`EXISTS (SELECT 1 FROM tasks AS parent WHERE parent.id = ${fields.parent_id} AND ${taskOwnedBy(this.scope, "parent")})`)
    if (typeof fields.status === "string") guards.push(sql`EXISTS (SELECT 1 FROM kanban_lanes WHERE board_id = ${this.scope.boardId} AND EXISTS (SELECT 1 FROM json_each(includes) WHERE lower(value) = ${normalizeStatus(fields.status)}))`)
    if (expectedChecklists !== undefined) guards.push(sql`checklists IS ${expectedChecklists}`)
    if (expectedAssignedTo !== undefined) guards.push(sql`assigned_to = ${expectedAssignedTo}`)
    if (version) {
      guards.push(sql`${sourceSql(storedVersion)} < 9007199254740991`, sql`${sourceSql(storedVersion)} ${sourceSql(version.expectedStatus ? "=" : "<=")} ${version.updatedAt}`)
      if (version.expectedStatus) guards.push(sql`tasks.status = ${version.expectedStatus}`, sourceSql("tasks.deferred_at IS NULL"))
    }
    const dependencies = fields.status === STATUS.ACTIVE ? openTaskDependencies(this.scope, id) : null
    if (dependencies) guards.push(sql`NOT EXISTS (${sourceSql(dependencies.sql, dependencies.args)})`)
    const condition = joinSql(guards, " AND ")
    const where = `WHERE ${condition.sql}`
    const whereArgs = condition.args
    const updateSql = `UPDATE tasks SET ${updates.join(", ")} ${where} RETURNING id, status, assigned_to, updated_at`

    const diagnostics: InStatement[] = []
    const versionIndex = version ? diagnostics.length : -1
    if (version) {
      diagnostics.push(scopedTaskRead(this.scope, sourceSql(`SELECT status, deferred_at, ${storedVersion} AS updated_at FROM scoped_tasks AS tasks WHERE id = ? AND 1`, [id]), "select"))
    }
    const checklistIndex = expectedChecklists !== undefined ? diagnostics.length : -1
    if (expectedChecklists !== undefined) {
      diagnostics.push(scopedTaskRead(this.scope, sourceSql("SELECT checklists FROM scoped_tasks AS tasks WHERE id = ? AND 1 AND checklists IS NOT ?", [id, expectedChecklists]), "select"))
    }
    const assigneeIndex = expectedAssignedTo !== undefined ? diagnostics.length : -1
    if (expectedAssignedTo !== undefined) {
      diagnostics.push(scopedTaskRead(this.scope, sourceSql("SELECT id FROM scoped_tasks AS tasks WHERE id = ? AND 1 AND (assigned_to IS NULL OR assigned_to != ?)", [id, expectedAssignedTo]), "select"))
    }
    const depsIndex = dependencies ? diagnostics.length : -1
    if (dependencies) {
      diagnostics.push({ ...dependencies, sql: `${dependencies.sql} ORDER BY t.id LIMIT 5` })
    }

    const completing = typeof fields.status === "string" && isDoneStatus(fields.status)
    const reassigning = fields.assigned_to !== undefined
    const assigneeDiagIndex = reassigning ? diagnostics.length : -1
    if (reassigning) {
      diagnostics.push(scopedTaskRead(this.scope, sourceSql("SELECT assigned_to FROM scoped_tasks AS tasks WHERE id = ? AND 1", [id]), "select"))
    }

    const writeIndex = diagnostics.length + (activity ? 1 : 0)
    let writerActivity = activity
    const buildBatch = (txNow: number): { update: InStatement; statements: InStatement[] } => {
      const eventId = activity ? crypto.randomUUID() : null
      const update: InStatement = sourceSql(updateSql, [...args, txNow, ...whereArgs])
      const statements: InStatement[] = [...diagnostics]
      // Capture the old state and commit the event and update in the same writer batch.
      if (writerActivity && eventId) statements.push(taskChangedActivity(this.scope, fields, where, whereArgs, writerActivity, txNow, eventId))
      statements.push(update)
      if (eventId) statements.push(discardUnappliedTaskActivity(eventId))
      return { update, statements }
    }

    let results: ResultSet[]
    let previousStatus: string
    let recurrence: RecurrenceOutcome
    let assignmentEventId: string | undefined
    {
      const repo = this
      const steps = function* (): Generator<
        InStatement[], ResultSet[], ResultSet[]
      > {
        const txNow = Date.now()
        const { statements } = buildBatch(txNow)
        const writeResults = yield statements
        const updatedRow = writeResults[writeIndex]?.rows[0] as Record<string, unknown> | undefined
        if (reassigning && updatedRow) {
          const priorAssignee = writeResults[assigneeDiagIndex]?.rows[0]?.assigned_to ?? null
          const nextAssignee = updatedRow.assigned_to ?? null
          if (priorAssignee !== nextAssignee) {
            const commitTs = Number(updatedRow.updated_at) || txNow
            const keepKey = reassignmentReceipt?.key ?? null
            yield [sourceSql("UPDATE integration_attempts SET status = 'superseded', updated_at = ? WHERE integration = 'task.reassignment' AND task_id = ? AND status = 'completed' AND (? IS NULL OR idempotency_key != ?)", [commitTs, id, keepKey, keepKey])]
          }
        }
        if (updatedRow) {
          if (placementChanged && storageBoardId(repo.scope) !== null) {
            const [previous] = yield [sql`SELECT area_id, project_id, goal_id FROM board_task_planning WHERE task_id = ${id}`]
            const row = previous?.rows[0]
            const area = Object.hasOwn(fields, "area_id") ? (fields.area_id) : row?.area_id ?? null
            const project = Object.hasOwn(fields, "project_id") ? fields.project_id : row?.project_id ?? null
            const goal = Object.hasOwn(fields, "goal_id") ? fields.goal_id : row?.goal_id ?? null
            if (area == null && project == null && goal == null) yield [sql`DELETE FROM board_task_planning WHERE task_id = ${id}`]
            else yield [sql`INSERT INTO board_task_planning(task_id, area_id, project_id, goal_id) VALUES (${id}, ${area as InValue}, ${project as InValue}, ${goal as InValue})
              ON CONFLICT(task_id) DO UPDATE SET area_id = excluded.area_id, project_id = excluded.project_id, goal_id = excluded.goal_id`]
          }
          const [projection] = yield [scopedTaskRead(repo.scope, sql`SELECT * FROM scoped_tasks AS tasks WHERE id = ${id}`)]
          if (!projection?.rows[0]) throw new BoardOperationError("unavailable")
          writeResults[writeIndex] = projection
        }
        return writeResults
      }
      const tx = existingWriter ?? await acquirePrivateBoardWriter(commandClient, this.scope, signal)
      try {
        signal?.throwIfAborted()
        // Retain cancellation through any borrowed compound writer's precommit
        // checks as well as this command's own awaited effect loop.
        if (signal) await requireBoardWriterCheck(tx, this.scope, async () => { signal.throwIfAborted() })
        const { rows: [original] } = await tx.execute(scopedTaskRead(this.scope, sql`SELECT * FROM scoped_tasks AS tasks WHERE id = ${id}`))
        if (!original) return { ok: false, errorCode: "unavailable" }
        // The owned writer admitted this target. Project-backed tasks still
        // require a current owned Project, and borrowed writers prove edit here.
        if ((existingWriter || (typeof original.project_id === "string" && original.project_id)) &&
          !await validateTaskOperation(tx, this.scope, id, { resource: "task", action: "edit" })) {
          return { ok: false, errorCode: "unavailable" }
        }
        // The original row and the status transition share the same writer.
        previousStatus = String(original.status ?? "")
        const statusIntent: WorkAction[] = typeof fields.status !== "string" ? [] : completing ? ["complete"] : isDoneStatus(previousStatus) ? ["reopen"] : []
        const intents: WorkAction[] = ["edit", ...statusIntent,
          ...(reassigning ? ["assign" as const] : []), ...(placementChanged || targetLaneId ? ["move" as const] : [])]
        for (const action of intents) {
          signal?.throwIfAborted()
          // The owned adapter retains these static intents throughout every
          // operation and commit. Derived and compound intents still join it.
          if (existingWriter || (action !== "edit" && action !== "complete")) {
            await requireBoardWriterIntent(tx, this.scope, { resource: "task", action })
          }
          if (integrationContext) await this.requireIntegrationWriter(tx, integrationContext, action, id)
        }
        if (Object.hasOwn(fields, "goal_id")) await requireBoardWriterCheck(tx, this.scope, async () => {
          if (!await validateBoardFeature(this.scope, tx, "goals")) throw new BoardOperationError("unavailable")
        })
        if (Object.hasOwn(fields, "assigned_to") && fields.assigned_to !== original.assigned_to) await requireBoardWriterCheck(tx, this.scope, async () => {
          if (!await this.validateAssignmentTarget(tx, fields.assigned_to as string | null, assignmentProof)) throw new BoardOperationError("denied")
        })
        if (original.routine_occurrence === 1 && fields.due_date !== undefined && fields.due_date !== original.due_date) {
          return { ok: false, errorCode: "unavailable", reason: "routine-date" }
        }
        if (original.routine_occurrence === 1 && fields.task_kind !== undefined && fields.task_kind !== original.task_kind ||
          fields.task_kind === "routine_instance" && original.task_kind !== "routine_instance") return { ok: false, errorCode: "unavailable" }
        if (placementChanged && !await validateBoardPlacement(this.scope, tx, {
          areaId: fields.area_id === undefined ? original.area_id as string | null : fields.area_id as string | null,
          projectId: fields.project_id === undefined ? original.project_id as string | null : fields.project_id as string | null,
        })) return { ok: false, errorCode: "unavailable" }
        if (placementChanged) {
          const area = fields.area_id === undefined ? original.area_id : fields.area_id
          const project = fields.project_id === undefined ? original.project_id : fields.project_id
          if (typeof project === "string") {
            const { rows: [placement] } = await tx.execute(sql`SELECT area_id FROM projects WHERE id = ${project} AND ${ownedPlanning(this.scope, "projects")} AND retired_at IS NULL`)
            if (!placement || area != null && placement.area_id != null && area !== placement.area_id) return { ok: false, errorCode: "unavailable" }
          }
        }
        if (fields.task_type !== undefined) {
          const nextType = typeof fields.task_type === "string" ? fields.task_type : ""
          if (!(VALID_TASK_TYPES as readonly string[]).includes(nextType)) {
            return { ok: false, errorCode: "hierarchy_invalid", message: "Invalid task_type; must be epic, story, or task." }
          }
        }
        const effectiveType = typeof fields.task_type === "string" ? fields.task_type : String(original.task_type ?? "task")
        const effectiveParentId = fields.parent_id !== undefined ? (fields.parent_id as string | null) : (original.parent_id as string | null)
        let ancestorDepth = 0
        let targetParentType: string | null = null

        if (typeof fields.parent_id === "string") {
          if (fields.parent_id === id) {
            return { ok: false, errorCode: "hierarchy_invalid", message: "A task cannot be its own parent." }
          }
          if (!await validateTaskOperation(tx, this.scope, fields.parent_id, { resource: "task", action: "read" })) {
            return { ok: false, errorCode: "unavailable" }
          }
          // Traverse the Board's physical ancestry to detect cycles and depth without revealing hidden titles.
          const { rows: ancestorRows } = await tx.execute(sql`WITH RECURSIVE ancestors(id, parent_id, task_type, depth) AS (
            SELECT ancestor.id, ancestor.parent_id, ancestor.task_type, 1 FROM tasks AS ancestor
              WHERE ancestor.id = ${fields.parent_id} AND ancestor.task_board_id IS ${storageBoardId(this.scope)}
            UNION ALL
            SELECT ancestor.id, ancestor.parent_id, ancestor.task_type, previous.depth + 1
            FROM tasks AS ancestor JOIN ancestors AS previous ON previous.parent_id = ancestor.id
              WHERE ancestor.task_board_id IS ${storageBoardId(this.scope)} AND previous.depth < 32
          ) SELECT id, task_type, depth FROM ancestors ORDER BY depth ASC`)
          const parentNode = ancestorRows[0]
          if (!parentNode) return { ok: false, errorCode: "unavailable" }
          targetParentType = String(parentNode.task_type ?? "task")
          ancestorDepth = ancestorRows.reduce((max, row) => Math.max(max, Number(row.depth ?? 0)), 0)

          const cycleIndex = ancestorRows.findIndex(row => String(row.id) === id)
          if (cycleIndex >= 0) {
            const chainIds = ancestorRows.slice(0, cycleIndex + 1).map(row => String(row.id))
            const placeholders = chainIds.map(() => "?").join(", ")
            const { rows: [vis] } = await tx.execute(scopedTaskRead(this.scope, sourceSql(`SELECT COUNT(*) AS cnt FROM scoped_tasks WHERE id IN (${placeholders})`, chainIds)))
            if (Number(vis?.cnt ?? 0) < chainIds.length) {
              return { ok: false, errorCode: "unavailable" }
            }
            return { ok: false, errorCode: "hierarchy_invalid", message: "Cannot set parent: this would create a circular parent-child relationship." }
          }
        }

        if (typeof effectiveParentId === "string" && (fields.parent_id !== undefined || fields.task_type !== undefined)) {
          if (targetParentType === null) {
            const { rows: [pRow] } = await tx.execute(sql`SELECT task_type FROM tasks WHERE id = ${effectiveParentId} AND task_board_id IS ${storageBoardId(this.scope)} LIMIT 1`)
            targetParentType = pRow ? String(pRow.task_type ?? "task") : null
          }
          if (targetParentType) {
            const typeViolation = validateParentChildType(targetParentType, effectiveType)
            if (typeViolation) {
              const parentVisible = await validateTaskOperation(tx, this.scope, effectiveParentId, { resource: "task", action: "read" })
              return {
                ok: false,
                errorCode: "hierarchy_invalid",
                message: parentVisible ? typeViolation : `Cannot change type to ${effectiveType} while nested under its parent task.`,
              }
            }
          }
        }

        if (typeof fields.parent_id === "string") {
          const { rows: [subRow] } = await tx.execute(sql`WITH RECURSIVE descendants(id, depth) AS (
            SELECT ${id}, 0
            UNION ALL
            SELECT child.id, descendants.depth + 1 FROM tasks AS child JOIN descendants ON child.parent_id = descendants.id
              WHERE child.task_board_id IS ${storageBoardId(this.scope)} AND descendants.depth < 32
          ) SELECT MAX(depth) AS max_depth FROM descendants`)
          const maxDescendantDepth = Number(subRow?.max_depth ?? 0)
          if (ancestorDepth + 1 + maxDescendantDepth > MAX_TASK_HIERARCHY_DEPTH) {
            return { ok: false, errorCode: "hierarchy_invalid", message: `Maximum task hierarchy depth is ${MAX_TASK_HIERARCHY_DEPTH} levels.` }
          }
        }

        if (fields.task_type !== undefined) {
          const { rows: childTypes } = await tx.execute(sql`SELECT DISTINCT task_type FROM tasks WHERE parent_id = ${id} AND task_board_id IS ${storageBoardId(this.scope)}`)
          for (const childRow of childTypes) {
            const childType = String(childRow.task_type ?? "task")
            const childViolation = validateParentChildType(effectiveType, childType)
            if (childViolation) {
              return {
                ok: false,
                errorCode: "hierarchy_conflict",
                message: `Cannot change type from ${String(original.task_type ?? "task")} to ${effectiveType} while it has ${childType} child tasks.`,
              }
            }
          }
        }
        const assignmentDigest = reassignmentReceipt ? createHash("sha256").update(JSON.stringify(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)))).digest("hex") : undefined
        if (reassignmentReceipt) {
          const { rows: [priorReceipt] } = await tx.execute(sql`SELECT attempt_id, task_id, response_payload FROM integration_attempts WHERE integration = 'task.reassignment' AND idempotency_key = ${reassignmentReceipt.key}`)
          if (priorReceipt) {
            if (priorReceipt.task_id !== id) return { ok: false, errorCode: "unavailable" }
            let prior: Record<string, unknown>
            try { prior = JSON.parse(String(priorReceipt.response_payload)) } catch { return { ok: false, errorCode: "unavailable" } }
            const proof = prior._authority as Record<string, unknown> | undefined
            if (proof && (proof.boardId !== this.scope.boardId || proof.principalKind !== this.scope.principal.kind || proof.principalId !== this.scope.principal.id)) return { ok: false, errorCode: "unavailable" }
            if (prior.inputDigest !== undefined && prior.inputDigest !== assignmentDigest) return { ok: false, errorCode: "conflict", updatedAt: Number(original.updated_at) }
            assignmentEventId = String(priorReceipt.attempt_id)
          } else assignmentEventId = crypto.randomUUID()
        }
        if (activity && this.scope.principal.kind === "agent") {
          const { rows: [token] } = await tx.execute(sql`SELECT name FROM agent_tokens WHERE id=${this.scope.principal.tokenId} AND revoked=0`)
          if (!token) throw new BoardOperationError("denied")
          const tokenName = sanitizeOriginName(stripHtml(String(token.name)))?.slice(0, 80) || "Agent"
          // A displayed token identity comes from this writer's current verified
          // credential row, never caller origin headers or a supplied actor name.
          writerActivity = { ...activity, kind: "agent", provenance: { ...activity.provenance, tokenName } }
        }
        const iterator = steps()
        let step = iterator.next()
        while (!step.done) {
          signal?.throwIfAborted()
          const batch = await tx.batch(step.value)
          signal?.throwIfAborted()
          step = iterator.next(batch)
        }
        results = step.value
        const written = results[writeIndex]?.rows[0]
        // The final projection includes any rule added or cleared by this same command.
        if (completing && !isDoneStatus(previousStatus) && typeof written?.recurrence_rule === "string" && written.recurrence_rule) {
          signal?.throwIfAborted()
          recurrence = await this.createRecurrenceSuccessor(tx, id, new Date().toISOString().slice(0, 10), recurrenceAssignment)
          signal?.throwIfAborted()
        }
        signal?.throwIfAborted()
        if (written && activity) {
          const actor = this.scope.principal.kind === "agent" ? writerActivity?.provenance?.tokenName ?? "Agent" : "user"
          const actorType = this.scope.principal.kind === "agent" ? "agent" : this.scope.principal.kind === "service" ? "system" : "user"
          const changed = Object.entries({ ...fields, ...(reassigning ? { owner: written.owner ?? original.owner } : {}) }).filter(([field, value]) =>
            String(original[field] ?? "") !== String(value ?? ""))
          if (changed.length) await tx.execute(sql`INSERT INTO task_activity_log(task_id, field, old_value, new_value, actor, actor_type, event_type, summary, correlation_id, created_at)
            VALUES ${joinSql(changed.map(([field, value]) => sql`(${id}, ${field}, ${original[field] == null ? null : String(original[field])}, ${value == null ? "" : String(value)}, ${actor}, ${actorType}, ${field === "status" ? "status_change" : "field_change"}, ${`${field}: ${original[field] == null ? "(empty)" : String(original[field])} → ${value == null ? "" : String(value)}`}, ${activityRequestId ?? reassignmentReceipt?.requestId ?? null}, ${Number(written.updated_at)})`))}`)
        }
        signal?.throwIfAborted()
        if (written && reassignmentReceipt && assignmentEventId) {
          const task = { ...projectPublicTaskFields(written), id, board_id: this.scope.boardId, ticket_key: written.ticket_ref }
          const bindingRefs = ((await readWorkDestinations(tx))?.bindings ?? []).filter(binding => binding.enabled && binding.destination.boardId === this.scope.boardId &&
            binding.allowedOperations.some(operation => operation.resource === "task" && operation.action === "read")).map(binding => ({ id: binding.id, generation: binding.generation }))
          const placement = await this.effectiveTaskPlacement(tx, written)
          const payload = { id, ticket_key: written.ticket_ref, assigned_to: written.assigned_to ?? null, inputDigest: assignmentDigest, eventId: assignmentEventId, task,
            _authority: { version: 1, boardId: this.scope.boardId, principalKind: this.scope.principal.kind, principalId: this.scope.principal.id,
              operation: "assign", oldAssignedTo: original.assigned_to ?? null, taskVersion: Number(written.updated_at), placement, bindingRefs } }
          await tx.execute(sql`INSERT INTO integration_attempts(attempt_id, task_id, integration, request_id, idempotency_key, status, response_payload, created_at, updated_at)
            VALUES (${assignmentEventId}, ${id}, 'task.reassignment', ${reassignmentReceipt.requestId}, ${reassignmentReceipt.key}, 'completed', ${JSON.stringify(payload)}, ${Date.now()}, ${Number(written.updated_at)})
            ON CONFLICT(idempotency_key,integration) DO UPDATE SET status='completed', response_payload=excluded.response_payload, updated_at=excluded.updated_at`)
        }
        signal?.throwIfAborted()
        if (!existingWriter) await tx.commit()
      } finally { if (!existingWriter) tx.close() }
    }
    if (recurrence === "invalid") logApiWarn("recurrence-auto-create", "Invalid saved recurrence rule or date")
    const successor = recurrence === "invalid" ? undefined : recurrence
    const row = results[writeIndex]?.rows[0]
    if (row) return { ok: true, task: row as unknown as TaskRow,
      ...(typeof fields.status === "string" ? { previousStatus } : {}),
      ...(successor ? { successor } : {}),
      ...(assignmentEventId ? { assignmentEventId } : {}),
    }

    if (assigneeIndex >= 0 && results[assigneeIndex]?.rows.length) {
      return { ok: false, errorCode: "assignee_mismatch" }
    }
    if (versionIndex >= 0) {
      const current = results[versionIndex]?.rows[0]
      if (!current) return { ok: false, errorCode: "unavailable" }
      const updatedAt = Number(current.updated_at)
      const changed = version!.expectedStatus
        ? updatedAt !== version!.updatedAt || current.status !== version!.expectedStatus || current.deferred_at !== null
        : updatedAt > version!.updatedAt
      if (changed || updatedAt === Number.MAX_SAFE_INTEGER) {
        return { ok: false, errorCode: "conflict", updatedAt }
      }
    }
    const changedChecklist = checklistIndex >= 0 ? results[checklistIndex]?.rows[0]?.checklists : undefined
    if (typeof changedChecklist === "string" || changedChecklist === null) {
      return { ok: false, errorCode: "checklist_conflict", checklists: changedChecklist }
    }
    const blockers = depsIndex >= 0 ? results[depsIndex]?.rows : undefined
    if (blockers?.length) {
      return {
        ok: false,
        errorCode: "blocked",
        blockers: blockers as unknown as TaskBlocker[],
      }
    }
    return { ok: false, errorCode: "unavailable" }
  }

  /** Move open work in or out of deferral without changing its workflow clock. */
  async setDeferral(
    id: string,
    deferred: boolean,
    guard: { updatedAt: number; revision: string | null; inactivityNow?: number },
    actor: { id: string; type: "agent" | "human" | "system"; requestId?: string | null },
    expectedAssignedTo?: string,
  ): Promise<DeferralResult> {
    const purpose = scopeServicePurpose(this.scope)
    if (purpose && (purpose !== "builtin.inactivity.defer" || !deferred || guard.inactivityNow === undefined || actor.type !== "system")) throw new BoardOperationError("denied")
    const now = guard.inactivityNow ?? Date.now()
    const marker = deferred ? now : null
    const correlationId = actor.requestId ?? null
    const version = taskTimestampMs("updated_at")
    const columns = `id, status, deferred_at, deferral_revision, ${version} AS updated_at`
    if (deferred && guard.inactivityNow !== undefined) {
      const eligibility = inactivityWriteGuard(this.scope, now)
      const transaction = await this.forOperation("edit", [id]).transaction("write")
      try {
        const [changed, audit, verified] = await transaction.batch([
          scopedTaskRead(this.scope, sourceSql(`UPDATE tasks SET deferred_at = ?, deferral_revision = lower(hex(randomblob(16)))
              WHERE id = ? AND ${version} = ? AND deferral_revision IS ? AND (${eligibility.sql})
              RETURNING ${columns}`, [now, id, guard.updatedAt, guard.revision, ...eligibility.args]), "select"),
          scopedTaskRead(this.scope, sourceSql(`INSERT INTO task_activity_log
                (task_id, field, old_value, new_value, actor, actor_type, event_type, summary, correlation_id, created_at)
              SELECT id, 'deferred_at', NULL, CAST(deferred_at AS TEXT), ?, 'system', 'field_change', ?, ?, ?
              FROM tasks WHERE changes() = 1 AND id = ? AND deferred_at = ?`, [inactivityRuleActor, "Automatically deferred after inactivity", correlationId, now, id, now]), "select"),
          scopedTaskRead(this.scope, sourceSql(`SELECT 1 FROM task_activity_log WHERE id = last_insert_rowid() AND task_id = ?
              AND field = 'deferred_at' AND old_value IS NULL AND new_value = ?
              AND actor = ? AND actor_type = 'system' AND event_type = 'field_change'
              AND correlation_id IS ? AND created_at = ?`, [id, String(now), inactivityRuleActor, correlationId, now]), "select"),
        ])
        const task = changed?.rows[0] as unknown as DeferralState | undefined
        if (!task && audit?.rowsAffected === 0) return { ok: false, errorCode: "ineligible" }
        if (!task || audit?.rowsAffected !== 1 || verified?.rows.length !== 1) {
          throw new Error("Automatic deferral requires one matching audit row")
        }
        await transaction.commit()
        return { ok: true, task }
      } finally {
        if (!transaction.closed) await transaction.rollback()
      }
    }
    const dependencies = openTaskDependencies(this.scope, id)
    const activeStates = [STATUS.ACTIVE, ...(getStatusDef(STATUS.ACTIVE)?.aliases ?? [])]
    const activePredicate = `lower(status) IN (${activeStates.map(() => "?").join(", ")})`
    const assigneeGuard = expectedAssignedTo === undefined ? "" : " AND assigned_to = ?"
    const assigneeArgs = expectedAssignedTo === undefined ? [] : [expectedAssignedTo]
    const eligible = `task_board_id IS (SELECT owner_board_id FROM scoped_storage) AND id = ? AND ${version} = ? AND deferral_revision IS ?
      AND lower(status) NOT IN ${deferralTerminalStatusesSql}
      AND deferred_at IS ${deferred ? "" : "NOT "}NULL${assigneeGuard}
      ${deferred ? "" : `AND (NOT (${activePredicate}) OR NOT EXISTS (${dependencies.sql}))`}`
    const args = [id, guard.updatedAt, guard.revision, ...assigneeArgs, ...(deferred ? [] : [...activeStates, ...dependencies.args])]
    const [diagnostic, audit, changed, blockers] = await this.forOperation("edit", [id]).batch([
      scopedTaskRead(this.scope, sourceSql(`SELECT ${columns}, assigned_to FROM scoped_tasks AS tasks WHERE id = ? AND 1`, [id]), "select"),
      scopedTaskRead(this.scope, sourceSql(`INSERT INTO task_activity_log
                (task_id, field, old_value, new_value, actor, actor_type, event_type, correlation_id, created_at)
              SELECT id, 'deferred_at', CAST(deferred_at AS TEXT), ?, ?, ?, 'field_change', ?, ?
              FROM tasks WHERE ${eligible}`, [marker === null ? null : String(marker), actor.id, actor.type, correlationId, now, ...args]), "select"),
      scopedTaskRead(this.scope, sourceSql(`UPDATE tasks SET deferred_at = ?, deferral_revision = lower(hex(randomblob(16)))
              WHERE changes() = 1 AND ${eligible} RETURNING ${columns}`, [marker, ...args]), "select"),
      ...(!deferred ? [{ ...dependencies, sql: `${dependencies.sql} ORDER BY t.id LIMIT 5` }] : []),
    ], "write")
    const row = changed?.rows[0] as unknown as DeferralState | undefined
    if (row && audit?.rowsAffected === 1) return { ok: true, task: row }

    const currentDiag = diagnostic?.rows[0] as unknown as DeferralDiagnostic | undefined
    if (!currentDiag) return { ok: false, errorCode: "unavailable" }
    if (expectedAssignedTo !== undefined && currentDiag.assigned_to !== expectedAssignedTo) {
      return { ok: false, errorCode: "assignee_mismatch" }
    }
    const { assigned_to: _assignedTo, ...current } = currentDiag
    if (current.updated_at !== guard.updatedAt || current.deferral_revision !== guard.revision) {
      return { ok: false, errorCode: "conflict", task: current }
    }
    if (isDeferralTerminalStatus(current.status)) {
      return { ok: false, errorCode: "terminal" }
    }
    if ((current.deferred_at !== null) === deferred) return { ok: true, task: current }
    if (!deferred && normalizeStatus(current.status) === STATUS.ACTIVE && blockers?.rows.length) {
      return { ok: false, errorCode: "blocked", blockers: blockers.rows as unknown as TaskBlocker[] }
    }
    throw new Error("Task deferral write did not match its transaction snapshot")
  }

  /** Fetch old field values for activity log diffing before an update */
  async getFieldsForDiff(id: string): Promise<TaskRow | null> {
    const result = await this.readCommandStatement("edit", scopedTaskRead(this.scope, sourceSql("SELECT title, description, status, priority, due_date, labels,\n                   framework_payload, area_id, custom_fields, parent_id,\n                   task_type, task_kind, project_id, owner, handoff_state,\n                   start_date, end_date, progress, color, is_promoted, assigned_to,\n                   urgency, importance, eisenhower_override\n            FROM scoped_tasks AS tasks WHERE id = ? AND 1 LIMIT 1", [id]), "select"), [id]);
    return (result.rows[0] as unknown as TaskRow) ?? null;
  }

  /**
   * Log field-level activity changes (fire-and-forget).
   * Uses a single multi-row INSERT for performance — avoids N parallel statements.
   */
  async logActivity(
    taskId: string,
    changes: Array<{ field: string; oldValue: string | null; newValue: string }>,
    opts?: { actor?: string; actor_type?: string; correlation_id?: string; createdAt?: number },
  ): Promise<void> {
    if (changes.length === 0) return
    const now = opts?.createdAt ?? Date.now()
    const actorType = opts?.actor_type ?? "user"
    const actor = opts?.actor ?? "user"
    const correlationId = opts?.correlation_id ?? null

    const placeholders: string[] = []
    const args: InValue[] = []
    for (const { field, oldValue, newValue } of changes) {
      const eventType = field === "status" ? "status_change" : "field_change"
      const summary = `${field}: ${oldValue ?? '(empty)'} → ${newValue}`
      placeholders.push("(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      args.push(taskId, field, oldValue, newValue, actor, actorType, eventType, summary, correlationId, now)
    }

    await this.forOperation("edit", [taskId]).execute(scopedTaskRead(this.scope, sourceSql(`INSERT INTO task_activity_log (task_id, field, old_value, new_value, actor, actor_type, event_type, summary, correlation_id, created_at)
            VALUES ${placeholders.join(", ")}`, args), "select")).catch((err) => logApiError("audit-activity", "Failed to write activity log entries", err))
  }

  /**
   * Record a non-field-change timeline event (created, delegated, sync, etc.)
   * Part of the Immutable Audit Ledger — every significant action gets recorded.
   */
  async recordTimelineEvent(taskId: string, event: {
    event_type: string
    actor: string
    actor_type: string
    summary: string
    field?: string
    old_value?: string | null
    new_value?: string
    correlation_id?: string
  }): Promise<void> {
    const now = Date.now()
    await this.forOperation("edit", [taskId]).execute(scopedTaskRead(this.scope, sourceSql(`INSERT INTO task_activity_log (task_id, field, old_value, new_value, actor, actor_type, event_type, summary, correlation_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        taskId,
        event.field ?? event.event_type,
        event.old_value ?? null,
        event.new_value ?? null,
        event.actor,
        event.actor_type,
        event.event_type,
        event.summary,
        event.correlation_id ?? null,
        now,
      ] as InValue[]), "select")).catch((err) => logApiError("audit-timeline", "Failed to write timeline event", err))
  }

  async moveToLane(id: string, laneId: string, version: number) {
    const tx = await this.forOperation("move", [id]).transaction("write")
    try {
      const { rows: [lane] } = await tx.execute(sql`SELECT key, includes FROM kanban_lanes WHERE board_id = ${this.scope.boardId} AND id = ${laneId}`)
      if (!lane) return { ok: false, errorCode: "unavailable" } as const
      let includes: unknown
      try { includes = JSON.parse(String(lane.includes)) } catch { return { ok: false, errorCode: "unavailable" } as const }
      const status = Array.isArray(includes) && typeof includes[0] === "string" ? normalizeStatus(includes[0]) : normalizeStatus(String(lane.key))
      const result = await this.updateTaskCommand(id, { status }, { version: { updatedAt: version } }, tx, laneId)
      if (result.ok) await tx.commit()
      return result
    } finally { tx.close() }
  }

  /** One scoped writer owns optimistic deletion, its receipt and all related cleanup. */
  async deleteWorkCommand(idOrKey: string, options?: { signal?: AbortSignal | undefined, version?: number }): Promise<DeleteWorkResult> {
    options?.signal?.throwIfAborted()
    const tx = await acquireWriteTransaction(this.forOperation("delete"), { signal: options?.signal })
    try {
      const result = await this.deleteWorkInWriter(tx, idOrKey, options)
      if (!result.ok) return result
      options?.signal?.throwIfAborted()
      await tx.commit()
      return result
    } finally { tx.close() }
  }

  async deleteTask(id: string, options?: { signal?: AbortSignal | undefined, version?: number }): Promise<boolean> {
    return (await this.deleteWorkCommand(id, options)).ok
  }

  private async deleteWorkInWriter(tx: Transaction, idOrKey: string, options?: { signal?: AbortSignal | undefined, version?: number }, batchIds?: readonly string[]): Promise<DeleteWorkResult> {
    await requireBoardWriterIntent(tx, this.scope, { resource: "task", action: "delete" })
    const assigned = scopeAssignedTo(this.scope)
    const number = this.ticketNumberForScope(idOrKey)
    const { rows: [task] } = await tx.execute(scopedTaskRead(this.scope, sql`SELECT tasks.*, tasks.ticket_ref AS ticket_key,
      ${sourceSql(taskTimestampMs("updated_at"))} AS task_version FROM scoped_tasks AS tasks
      WHERE (id = ${idOrKey} OR ticket_number = ${number}) ${assigned === undefined ? sourceSql("") : sql`AND assigned_to = ${assigned}`} LIMIT 1`))
    if (!task) return { ok: false, errorCode: "unavailable" }
    if (options?.version !== undefined && Number(task.task_version) !== options.version) return { ok: false, errorCode: "conflict" }
    const id = String(task.id)
    // Detach any remaining direct children on the same Board so they become standalone items without broken parent_id.
    await tx.execute(sql`UPDATE tasks SET parent_id = NULL WHERE parent_id = ${id} AND ${taskOwnedBy(this.scope)}`)
    const settings = await readWorkDestinations(tx)
    const bindingIds = new Set<string>()
    for (const table of ["calendar_confirmations", "todo_sync_confirmations", "grocy_sync_confirmations"] as const) {
      if (!(await tx.execute(sql`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ${table}`)).rows.length) continue
      const { rows } = await tx.execute(sql`SELECT DISTINCT binding_id FROM ${sourceSql(table)} WHERE task_id = ${id} AND binding_id IS NOT NULL`)
      for (const row of rows) if (typeof row.binding_id === "string") bindingIds.add(row.binding_id)
    }
    const placement = await this.effectiveTaskPlacement(tx, task)
    // Outbound receivers need the approval that existed at deletion, even
    // when the task was never linked to an inbound sync source.
    const bindingRefs = (settings?.bindings ?? []).filter(binding => {
      if (!binding.enabled || binding.destination.boardId !== this.scope.boardId) return false
      if (bindingIds.has(binding.id)) return true
      const { areaId, projectId } = binding.destination
      return (binding.integration === "webhook" || binding.integration === "ha_events" && binding.sourceId === "meitheal") &&
        binding.purpose === "webhook.delivery" &&
        bindingAllows(binding, { resource: "task", action: "read" }) &&
        (!areaId || areaId === placement.areaId) && (!projectId || projectId === placement.projectId)
    }).map(binding => ({ id: binding.id, generation: binding.generation }))
    const eventId = crypto.randomUUID()
    const now = Date.now()
    const snapshot = { ...projectPublicTaskFields(task), id, board_id: this.scope.boardId, ticket_key: task.ticket_ref }
    const payload = { ...snapshot, _authority: { version: 1, boardId: this.scope.boardId, principalKind: this.scope.principal.kind,
      principalId: this.scope.principal.id, operation: "delete", oldAssignedTo: task.assigned_to ?? null,
      oldAreaId: placement.areaId, oldProjectId: placement.projectId, placement, bindingRefs } }
    await tx.execute(sql`INSERT INTO domain_events(event_id,event_type,task_id,request_id,idempotency_key,payload,created_at)
      VALUES (${eventId}, 'task.deleted', ${id}, ${eventId}, ${eventId}, ${JSON.stringify(payload)}, ${now})`)
    await tx.execute(sql`DELETE FROM task_links WHERE source_task_id = ${id} OR target_task_id = ${id}`)
    await tx.execute(sql`DELETE FROM comments WHERE task_id = ${id}`)
    await tx.execute(sql`DELETE FROM task_activity_log WHERE task_id = ${id}`)
    const deleted = await tx.execute(sql`DELETE FROM tasks WHERE id = ${id} AND ${taskOwnedBy(this.scope)}`)
    if (deleted.rowsAffected !== 1) throw new Error("Task deletion changed while recording its receipt")
    return { ok: true, id, eventId }
  }

  async purgeWorkCommand(cutoffMs?: number): Promise<{ id: string, eventId: string }[]> {
    const tx = await this.forOperation("delete").transaction("write")
    try {
      const assigned = scopeAssignedTo(this.scope)
      const { rows } = await tx.execute(scopedTaskRead(this.scope, sql`SELECT id FROM scoped_tasks AS tasks WHERE 1
        ${cutoffMs === undefined ? sourceSql("") : sql`AND status IN ('complete', 'archived') AND updated_at < ${cutoffMs}`}
        ${assigned === undefined ? sourceSql("") : sql`AND assigned_to = ${assigned}`} ORDER BY id`))
      const ids = rows.map(row => String(row.id))
      const receipts: { id: string, eventId: string }[] = []
      for (const id of ids) {
        const result = await this.deleteWorkInWriter(tx, id, undefined, ids)
        if (result.ok) receipts.push({ id: result.id, eventId: result.eventId })
      }
      await tx.commit()
      return receipts
    } finally { tx.close() }
  }
  async purgeAll(): Promise<void> { await this.purgeWorkCommand() }

  async archiveCompletedForDay(day: string, timezone: string, placement?: TaskReadPlacement): Promise<number> {
    let db = this.forOperation("delete")
    db = boardOperationClient(db, this.scope, { resource: "task", action: "edit" })
    db = boardOperationClient(db, this.scope, { resource: "task", action: "complete" })
    const filter = todayCompletionFilter(day, timezone)
    const result = await db.execute(scopedTaskRead(this.scope, sql`UPDATE tasks SET status = 'archived', updated_at = ${Date.now()}
      WHERE id IN (SELECT id FROM scoped_tasks AS tasks WHERE ${sourceSql(filter.sql, [...filter.args])} AND ${taskReadPlacement(placement)}
        ${scopeAssignedTo(this.scope) === undefined ? sourceSql("") : sql`AND assigned_to = ${scopeAssignedTo(this.scope)!}`})`))
    return result.rowsAffected
  }

  /**
   * Count completed/archived tasks older than a cutoff timestamp.
   * Used for dry-run preview before destructive deletion.
   * @param cutoffMs - Epoch milliseconds; tasks with updated_at < this are counted
   */
  async countCompletedBefore(cutoffMs: number): Promise<number> {
    const result = await this.forOperation("read").execute(scopedTaskRead(this.scope, sourceSql("SELECT COUNT(*) as cnt FROM scoped_tasks AS tasks\n            WHERE 1 AND status IN ('complete', 'archived')\n              AND updated_at < ?", [cutoffMs]), "select"));
    return Number((result.rows[0] as Record<string, unknown>)?.cnt ?? 0);
  }

  /**
   * Permanently delete completed/archived tasks older than a cutoff timestamp.
   * Cascades to: task_activity_log, comments, task_links.
   *
   * @param cutoffMs - Epoch milliseconds; tasks with updated_at < this are deleted
   * @returns Number of tasks deleted
   *
   * @safety Only touches tasks with status IN ('complete', 'archived').
   * Active, pending, and in-progress tasks are NEVER affected regardless of age.
   */
  async deleteCompletedBefore(cutoffMs: number): Promise<number> { return (await this.purgeWorkCommand(cutoffMs)).length }

  private async createRecurrenceSuccessor(
    tx: Transaction, id: string,
    completionDay: string,
    assignment?: { assigneeId: string | null, proof?: AssignmentProof | undefined },
  ): Promise<RecurrenceOutcome> {
    const recurrence = await tx.execute(this.recurrenceDataQuery(id))
    const source = recurrence?.rows[0] as unknown as TaskRow | undefined
    const rule = source?.recurrence_rule
    if (!source || typeof rule !== "string" || !rule) return
    // An external calendar owns the repeats of an event that sync created: sync reopens
    // it at the next occurrence. A Meitheal Event task that sync only matched by title
    // keeps creating its own next occurrence.
    if (Number((source as { calendar_imported?: unknown }).calendar_imported ?? 0) > 0 || source.source_template_id) return

    const parsed = parseRRule(rule)
    if (!parsed) return "invalid"

    const scheduledSource = effectiveTaskScheduledDate(source)
    const base = source.recurrence_anchor === "completion_date" || !scheduledSource
      ? completionDay
      : scheduledSource
    const savedDate = new Date(base)
    const writtenDay = readStoredCalendarDay(base)
    const writtenDate = writtenDay && writtenDay !== base && Number.isFinite(savedDate.getTime())
      ? new Date(writtenDay)
      : savedDate
    const anchor = Number.isFinite(writtenDate.getTime()) ? writtenDate : savedDate
    const next = getNextOccurrence(parsed, anchor)
    if (next === null) return
    if (!Number.isFinite(next.getTime())) return "invalid"

    const dueDate = next.toISOString().split("T")[0]!
    const completionVersion = Number((await tx.execute(scopedTaskRead(this.scope, sql`SELECT ${sourceSql(taskTimestampMs("updated_at"))} AS version FROM scoped_tasks WHERE id = ${id}`))).rows[0]?.version)
    if (!Number.isSafeInteger(completionVersion)) throw new BoardOperationError("stale")
    const created = await this.createRecurrenceInWriter(tx, source, dueDate, rule, `recurrence:${id}:${completionVersion}:${dueDate}`, assignment)
    return { id: created.id, ticketNumber: created.ticketNumber, title: source.title, dueDate, rule }
  }

  /** Fetch the task fields inherited by its next occurrence. */
  async getRecurrenceData(id: string): Promise<TaskRow | null> {
    const result = await this.forOperation("read", [id]).execute(this.recurrenceDataQuery(id))
    return (result.rows[0] as unknown as TaskRow) ?? null
  }

  private recurrenceDataQuery(id: string): InStatement {
    return scopedTaskRead(this.scope, sourceSql("SELECT tasks.*,\n                   (task_kind = 'calendar_event' AND calendar_sync_state = 'synced' AND EXISTS(\n                     -- The calendar owns the repeats only when it has a rule for the event. A\n                     -- one-off event imported by an earlier release, to which the user later\n                     -- added a rule in Meitheal, keeps creating its next occurrence.\n                     SELECT 1 FROM calendar_confirmations\n                     WHERE task_id = tasks.id AND source IN ('ha.calendar_sync', 'caldav')\n                       AND json_valid(payload)\n                       AND (json_extract(payload, '$.rrule') IS NOT NULL OR json_extract(payload, '$.inferred_rrule') IS NOT NULL)\n                   ) AND NOT EXISTS(\n                     SELECT 1 FROM calendar_confirmations\n                     WHERE task_id = tasks.id AND source = 'ha.write_back'\n                   )) AS calendar_imported\n            FROM scoped_tasks AS tasks WHERE id = ? AND 1 LIMIT 1", [id]), "select")
  }

  /**
   * Clone a task for recurrence — creates next occurrence with new due date.
   * Resets checklists (all items unchecked) and status to pending.
   */
  async cloneForRecurrence(
    sourceTask: TaskRow,
    nextDueDate: string,
    recurrenceRule: string,
  ): Promise<{ id: string; ticketNumber: number }> {
    const proof = sourceTask.assigned_to?.startsWith("ha_") ? await resolveHAAssignmentProof(this.scope, sourceTask.assigned_to.slice(3)) : undefined
    const tx = await acquireWriteTransaction(this.forOperation("create", [sourceTask.id]))
    try {
      const current = await tx.execute(scopedTaskRead(this.scope, sql`SELECT * FROM scoped_tasks WHERE id = ${sourceTask.id}`))
      if (!current.rows[0]) throw new BoardOperationError("unavailable")
      const created = await this.createRecurrenceInWriter(tx, current.rows[0] as unknown as TaskRow, nextDueDate, recurrenceRule, `recurrence:${sourceTask.id}:${nextDueDate}`, { assigneeId: sourceTask.assigned_to ?? null, proof })
      await tx.commit()
      return created
    } finally { tx.close() }
  }

  private async createRecurrenceInWriter(tx: Transaction, source: TaskRow, due: string, rule: string, idempotencyKey: string, assignment?: { assigneeId: string | null, proof?: AssignmentProof | undefined }): Promise<{ id: string, ticketNumber: number }> {
    if (source.assigned_to && (!assignment || assignment.assigneeId !== source.assigned_to)) throw new BoardOperationError("stale")
    const { rows: [version] } = await tx.execute(scopedTaskRead(this.scope, sql`SELECT ${sourceSql(taskTimestampMs("updated_at"))} AS version FROM scoped_tasks WHERE id = ${source.id}`))
    if (!version) throw new BoardOperationError("unavailable")
    const shiftedWindow = source.task_kind === "calendar_event"
      ? shiftEventWindow(due, source.start_date, source.end_date)
      : { start_date: null, end_date: null }
    const nextDueDate = source.due_date ? due : (source.task_kind === "calendar_event" ? null : due)
    const result = await this.createWorkInWriter(tx, {
      id: crypto.randomUUID(), title: source.title, description: source.description ?? "", status: STATUS.PENDING,
      priority: Number(source.priority ?? 3), due_date: nextDueDate, labels: source.labels ?? "[]", framework_payload: source.framework_payload ?? "{}",
      parent_id: source.parent_id ?? null, area_id: source.area_id ?? null, project_id: source.project_id ?? null, goal_id: source.goal_id ?? null,
      custom_fields: source.custom_fields ?? "{}", start_date: shiftedWindow.start_date, end_date: shiftedWindow.end_date, progress: 0, color: source.color ?? null,
      task_type: source.task_type ?? "task", task_kind: source.task_kind ?? "standard_action", assigned_to: source.assigned_to ?? null,
      checklists: cloneRecurringChecklist(source.checklists), recurrence_rule: rule,
    }, { clientIdempotencyKey: idempotencyKey, assignmentProof: assignment?.proof, recurrenceSource: { taskId: source.id, rule, version: Number(version.version) } }, Date.now())
    if (!result.ok) throw new BoardOperationError(result.errorCode === "denied" ? "denied" : "unavailable")
    await tx.execute(sql`UPDATE tasks SET recurrence_anchor = ${source.recurrence_anchor ?? "due_date"} WHERE id = ${result.task.id} AND ${taskOwnedBy(this.scope)}`)
    return { id: result.task.id, ticketNumber: result.ticketNumber }
  }

  /** Count open tasks (non-complete) — used for iOS badge count */
  async getOpenTaskCount(): Promise<number> {
    try {
      const result = await this.forOperation("read").execute(scopedTaskRead(this.scope, sourceSql("SELECT COUNT(*) as cnt FROM scoped_tasks AS tasks WHERE 1 AND status NOT IN (?)", [STATUS.COMPLETE]), "select"));
      return Number((result.rows[0] as Record<string, unknown>).cnt) || 0;
    } catch (error) { throw error }
  }

  /**
   * Get immediate child task IDs for cascade completion.
   * Only returns non-complete children.
   */
  async getChildrenIds(parentId: string, assignedTo?: string): Promise<string[]> {
    const assigneeFilter = assignedTo === undefined ? "" : " AND assigned_to = ?"
    const args = assignedTo === undefined ? [parentId, STATUS.COMPLETE] : [parentId, STATUS.COMPLETE, assignedTo]
    const result = await this.forOperation("read", [parentId]).execute(scopedTaskRead(this.scope, sourceSql(`SELECT id FROM scoped_tasks AS tasks WHERE 1 AND parent_id = ? AND status != ?${assigneeFilter}`, args), "select"));
    return result.rows.map((r) => String((r as Record<string, unknown>).id));
  }

  /**
   * Cascade complete — set all non-complete children to complete and return their IDs.
   * When assignedTo is supplied, only children assigned to that agent are updated.
   */
  async cascadeCompleteIds(parentId: string, assignedTo?: string): Promise<string[]> {
    const assigned = scopeAssignedTo(this.scope) ?? assignedTo
    const openProbe = await this.readCommandStatement(
      "complete",
      sql`SELECT 1 FROM tasks WHERE ${taskOwnedBy(this.scope)} AND parent_id = ${parentId} AND status != ${STATUS.COMPLETE} ${assigned === undefined ? sourceSql("") : sql`AND assigned_to = ${assigned}`} LIMIT 1`,
      [parentId],
    )
    if (openProbe.rows.length === 0) return []
    const childLookup = scopedTaskRead(this.scope, sql`SELECT id, recurrence_rule, assigned_to
      FROM scoped_tasks WHERE parent_id = ${parentId} AND status != ${STATUS.COMPLETE}
      ${assigned === undefined ? sourceSql("") : sql`AND assigned_to = ${assigned}`}`, "select", "minimal")
    const rows = await this.readCommandStatement("complete", tagTaskProjectionRead(childLookup, "task-cascade"), [parentId])
    if (rows.rows.length === 0) return []
    const inherit = new Map<string, { assigneeId: string | null, proof?: AssignmentProof | undefined }>()
    for (const row of rows.rows) if (row.recurrence_rule) {
      const assignee = typeof row.assigned_to === "string" ? row.assigned_to : null
      inherit.set(String(row.id), { assigneeId: assignee, proof: assignee?.startsWith("ha_") ? await resolveHAAssignmentProof(this.scope, assignee.slice(3)) : undefined })
    }
    const tx = await acquireWriteTransaction(this.forOperation("complete", [parentId]))
    try {
      const current = await tx.execute(scopedTaskRead(this.scope, sql`SELECT id FROM scoped_tasks WHERE parent_id = ${parentId} AND status != ${STATUS.COMPLETE}
        ${assigned === undefined ? sourceSql("") : sql`AND assigned_to = ${assigned}`}`, "select", "minimal"))
      const changed: string[] = []
      for (const row of current.rows) {
        const id = String(row.id)
        const result = await this.updateTaskCommand(id, { status: STATUS.COMPLETE }, { recurrenceAssignment: inherit.get(id), ...(assigned === undefined ? {} : { expectedAssignedTo: assigned }) }, tx)
        if (!result.ok) throw new BoardOperationError("unavailable")
        changed.push(id)
      }
      await tx.commit()
      return changed
    } finally { tx.close() }
  }

  /**
   * Cascade complete — set all non-complete children to complete.
   * When assignedTo is supplied, only children assigned to that agent are updated.
   */
  async cascadeComplete(parentId: string, assignedTo?: string): Promise<number> {
    return (await this.cascadeCompleteIds(parentId, assignedTo)).length
  }

  private async reorderPositionColumn(
    ids: string[],
    opts: { column: "kanban_position" | "table_position"; orderBySql: string; activeOnly?: boolean },
  ): Promise<boolean> {
    if (ids.length === 0) return false
    const deferredGuard = opts.activeOnly ? "AND tasks.deferred_at IS NULL" : ""
    const col = sourceSql(opts.column)
    const assigned = scopeAssignedTo(this.scope)
    const result = await this.forOperation("move", ids).execute(scopedTaskRead(this.scope, sourceSql(`requested AS MATERIALIZED (
              SELECT value AS id, key AS ordinal FROM json_each(?)
            ), allowed AS MATERIALIZED (
              SELECT COUNT(*) AS total FROM requested
              JOIN scoped_tasks AS tasks ON tasks.id = requested.id AND 1 ${deferredGuard}
              HAVING total = (SELECT COUNT(*) FROM requested)
                 AND total = COUNT(DISTINCT requested.id)
            ), ordered AS MATERIALIZED (
              SELECT id, ROW_NUMBER() OVER (
                ORDER BY ${opts.orderBySql}
              ) - 1 AS position
              FROM scoped_tasks AS tasks WHERE 1 AND EXISTS (SELECT 1 FROM allowed)
            ), slots AS MATERIALIZED (
              SELECT position, ROW_NUMBER() OVER (ORDER BY position) - 1 AS ordinal
              FROM ordered WHERE id IN (SELECT id FROM requested)
            ), ranks AS MATERIALIZED (
              SELECT ordered.id, COALESCE(slots.position, ordered.position) AS position,
                     requested.id IS NOT NULL AS submitted
              FROM ordered
              LEFT JOIN requested ON requested.id = ordered.id
              LEFT JOIN slots ON slots.ordinal = requested.ordinal
            )
            UPDATE tasks SET ${col.sql} = ranks.position,
              deferral_revision = CASE WHEN ranks.submitted AND ${taskTimestampMs("tasks.updated_at")} = 9007199254740991
                THEN lower(hex(randomblob(16))) ELSE deferral_revision END,
              updated_at = CASE WHEN ranks.submitted THEN ${nextTaskTimestampMs("tasks.updated_at")} ELSE updated_at END
            FROM ranks WHERE tasks.id = ranks.id AND tasks.id IN (SELECT id FROM scoped_tasks)
              ${assigned === undefined ? "" : "AND tasks.assigned_to = ?"}
              AND (ranks.submitted OR tasks.${col.sql} IS NOT ranks.position)`, [JSON.stringify(ids), Date.now(), ...(assigned === undefined ? [] : [assigned])]), "with", "minimal"))
    return result.rowsAffected > 0
  }

  /** Reorder submitted tasks across their existing slots in the shared order. */
  async reorderTasks(ids: string[]): Promise<boolean> {
    return this.reorderPositionColumn(ids, {
      column: "kanban_position",
      orderBySql: "kanban_position ASC NULLS LAST, priority ASC, created_at DESC, id ASC",
      activeOnly: true,
    })
  }

  /** Persist manual row ordering in Table view using tasks.table_position within this board. */
  async reorderTableTasks(ids: string[]): Promise<boolean> {
    return this.reorderPositionColumn(ids, {
      column: "table_position",
      orderBySql: "table_position ASC NULLS LAST, created_at DESC, id ASC",
    })
  }

  /** Place a card in the shared order while preserving every other card's relative order. */
  async reorderKanbanCard(input: { id: string; anchorId: string; lane: string; before: boolean }): Promise<boolean> {
    // Lane membership and promotion group are checked before ranking the full
    // board. The underlying order is shared across lanes, filters and groups.
    // Leave the unranked suffix alone; it still sorts by the same tie-breaks.
    const result = await this.forOperation("move", [input.id, input.anchorId]).execute(scopedTaskRead(this.scope, sourceSql(`requested(moved_id, anchor_id, lane, after_anchor) AS (VALUES (?, ?, ?, ?)),\n            allowed AS MATERIALIZED (\n              SELECT requested.*\n              FROM requested\n              WHERE (\n                SELECT COUNT(*) = 2 AND MIN(is_promoted) = MAX(is_promoted) FROM scoped_tasks AS tasks\n                WHERE id IN (requested.moved_id, requested.anchor_id)\n                  AND 1 AND deferred_at IS NULL\n                  AND status IN (\n                    SELECT value FROM json_each((\n                      SELECT includes FROM kanban_lanes WHERE board_id = (SELECT board_id FROM scoped_storage) AND key = requested.lane\n                    ))\n                  )\n              )\n            ),\n            ordered AS MATERIALIZED (\n              SELECT id, kanban_position, ROW_NUMBER() OVER (\n                ORDER BY kanban_position ASC NULLS LAST, priority ASC, created_at DESC, id ASC\n              ) AS position\n              FROM scoped_tasks AS tasks\n              WHERE 1 AND EXISTS (SELECT 1 FROM allowed)\n            ),\n            move AS MATERIALIZED (\n              SELECT moved_id, source.position AS from_position,\n                     anchor.position + after_anchor - (source.position < anchor.position) AS to_position\n              FROM allowed\n              JOIN ordered AS source ON source.id = moved_id\n              JOIN ordered AS anchor ON anchor.id = anchor_id\n            ),\n            updated_order AS MATERIALIZED (\n              SELECT ordered.id, ordered.kanban_position AS prior_position, CASE\n                WHEN from_position = to_position THEN kanban_position\n                ELSE (CASE\n                  WHEN ordered.id = moved_id THEN to_position\n                  WHEN position > from_position AND position <= to_position THEN position - 1\n                  WHEN position >= to_position AND position < from_position THEN position + 1\n                  ELSE position\n                END) - 1\n              END AS position\n              FROM ordered CROSS JOIN move\n              WHERE from_position != to_position OR ordered.id = moved_id\n            )\n            UPDATE tasks\n            SET kanban_position = updated_order.position,\n                inactivity_touched_at = CASE WHEN tasks.id = (SELECT moved_id FROM move WHERE from_position != to_position)\n                  THEN MAX(COALESCE(inactivity_touched_at, 0), ?) ELSE inactivity_touched_at END\n            FROM updated_order\n            WHERE tasks.id = updated_order.id AND tasks.id IN (SELECT id FROM scoped_tasks)\n              ${scopeAssignedTo(this.scope) === undefined ? "" : "AND tasks.assigned_to = ?"}\n              AND (\n                tasks.id = (SELECT moved_id FROM move)\n                OR (tasks.kanban_position IS NOT updated_order.position AND updated_order.position <= (\n                  SELECT MAX(position) FROM updated_order\n                  WHERE prior_position IS NOT NULL OR id = (SELECT moved_id FROM move)\n                ))\n              )`, [input.id, input.anchorId, input.lane, input.before ? 0 : 1, Date.now(), ...(scopeAssignedTo(this.scope) === undefined ? [] : [scopeAssignedTo(this.scope)!])]), "with", "kanban-order"))
    return result.rowsAffected > 0
  }

  /** Look up custom user display name by ID */
  async getCustomUserName(userId: string): Promise<string | null> {
    try {
      const result = await this.forOperation("read").execute(scopedTaskRead(this.scope, sourceSql("SELECT name FROM custom_users WHERE id = ? LIMIT 1", [userId]), "select"));
      if (result.rows.length > 0) return String((result.rows[0] as Record<string, unknown>).name);
    } catch { /* table may not exist */ }
    return null;
  }

  /** Fetch notification preferences from settings table */
  async getNotificationPreferences(): Promise<{
    enabled: boolean;
    disabledUsers: Set<string>;
    channels: { sidebar: boolean; mobile_push: boolean };
    mobileTargets: string[];
  }> {
    const defaults = {
      enabled: true,
      disabledUsers: new Set<string>(),
      channels: { sidebar: true, mobile_push: false },
      mobileTargets: [] as string[],
    };
    try {
      const intent = { resource: "task", action: "read" } as const;
      if (!(await validateBoardScope(this.scope, this.client, intent)).ok) return defaults;
      const state = localReaderCacheToken(this.client);
      let rawValue: string | null | undefined = state && notifPrefsCache.get(state.owner)?.token === state.token
        ? notifPrefsCache.get(state.owner)!.rawValue
        : undefined;
      if (rawValue === undefined) {
        const result = await this.client.execute("SELECT value FROM settings WHERE key = 'notification_preferences' LIMIT 1");
        if (!(await validateBoardScope(this.scope, this.client, intent)).ok) return defaults;
        rawValue = result.rows.length > 0 ? String((result.rows[0] as Record<string, unknown>).value) : null;
        if (state && localReaderCacheToken(this.client)?.token === state.token) {
          notifPrefsCache.set(state.owner, { token: state.token, rawValue });
        }
      }
      if (rawValue !== null) {
        const raw = JSON.parse(rawValue);
        if (typeof raw === "object" && raw !== null) {
          defaults.enabled = raw.enabled !== false;
          if (Array.isArray(raw.disabled_users)) defaults.disabledUsers = new Set(raw.disabled_users);
          if (raw.channels && typeof raw.channels === "object") defaults.channels = { ...raw.channels };
          if (Array.isArray(raw.mobile_targets)) defaults.mobileTargets = [...raw.mobile_targets];
        }
      }
    } catch { /* settings not available */ }
    return defaults;
  }

  // ── Comment Methods ─────────────────────────────────────────────────

  /** List comments for a task, ordered by creation time ascending */
  async getComments(taskId: string, ownerKey: string | null) {
    const result = await this.forOperation("read", [taskId]).execute(scopedTaskRead(this.scope, sourceSql(`SELECT id, task_id, content, author, created_at,
                   CASE WHEN owner_key = ? THEN 1 ELSE 0 END AS can_manage
            FROM comments WHERE task_id = ? ORDER BY created_at ASC, id ASC`, [ownerKey, taskId]), "select"))
    return result.rows.map(row => ({ ...row, content: String(row.content), can_manage: Number(row.can_manage) === 1 }))
  }

  /** Insert and return a comment atomically with optional assignee ownership guard. */
  async addCommentChecked(
    taskId: string,
    content: string,
    author: string,
    ownerKey: string | null,
    verifiedHuman = false,
    expectedAssignedTo?: string,
  ): Promise<{ state: "created"; comment: Record<string, unknown> } | { state: "not_found" } | { state: "assignee_mismatch" }> {
    const tx = await this.forOperation("edit", [taskId]).transaction("write")
    try {
      const assigneeSql = expectedAssignedTo === undefined ? "" : " AND assigned_to = ?"
      const assigneeArgs = expectedAssignedTo === undefined ? [] : [expectedAssignedTo]
      const inserted = await tx.execute(scopedTaskRead(this.scope, sourceSql(`INSERT INTO comments (task_id, content, author, owner_key, inactivity_spike_human)
              SELECT id, ?, ?, ?, ? FROM tasks WHERE id = ? AND task_board_id IS (SELECT owner_board_id FROM scoped_storage)${assigneeSql}
              RETURNING id, task_id, content, author, created_at`, [content, author, ownerKey, verifiedHuman ? 1 : 0, taskId, ...assigneeArgs]), "select"))
      const row = inserted.rows[0] as Record<string, unknown> | undefined
      if (row) {
        await tx.commit()
        return { state: "created", comment: row }
      }
      if (expectedAssignedTo !== undefined) {
        const current = await tx.execute(scopedTaskRead(this.scope, sourceSql("SELECT assigned_to FROM scoped_tasks AS tasks WHERE id = ? AND 1", [taskId]), "select"))
        await tx.commit()
        return current.rows.length > 0 ? { state: "assignee_mismatch" } : { state: "not_found" }
      }
      await tx.commit()
      return { state: "not_found" }
    } finally {
      tx.close()
    }
  }

  /** Insert and return this comment while the parent task exists. */
  async addComment(taskId: string, content: string, author: string, ownerKey: string | null, verifiedHuman = false) {
    const res = await this.addCommentChecked(taskId, content, author, ownerKey, verifiedHuman)
    return res.state === "created" ? res.comment : undefined
  }

  async getComment(taskId: string, commentId: number) {
    const result = await this.forOperation("read", [taskId]).execute(scopedTaskRead(this.scope, sourceSql("SELECT id, task_id, content, author, created_at FROM comments WHERE task_id = ? AND id = ?", [taskId, commentId]), "select"))
    return result.rows[0]
  }

  async deleteComment(taskId: string, commentId: number, ownerKey: string): Promise<boolean> {
    const result = await this.forOperation("edit", [taskId]).execute(scopedTaskRead(this.scope, sourceSql("DELETE FROM comments WHERE task_id = ? AND id = ? AND owner_key = ?", [taskId, commentId, ownerKey]), "select"))
    return result.rowsAffected > 0
  }

  // ── Activity Log Methods ────────────────────────────────────────────

  /** Fetch paginated activity log for a task */
  async getActivityLog(taskId: string, limit: number, offset: number) {
    const where = `WHERE task_id = ? AND ${taskHistoryPredicate}`
    const [events, count] = await this.forOperation("read", [taskId]).batch([
      scopedTaskRead(this.scope, sourceSql(`SELECT id, task_id, field, old_value, new_value, actor, actor_type, event_type, ${PUBLIC_ACTIVITY_SUMMARY} AS summary, correlation_id, created_at
              FROM task_activity_log ${where}
              ORDER BY created_at DESC, id DESC
              LIMIT ? OFFSET ?`, [taskId, limit, offset]), "select"),
      scopedTaskRead(this.scope, sourceSql(`SELECT COUNT(*) AS total FROM task_activity_log ${where}`, [taskId]), "select"),
    ], "read")
    return { activity: events?.rows ?? [], total: Number(count?.rows[0]?.total ?? 0) }
  }

  /**
   * Unified timeline: merges activity log + comments chronologically.
   * Returns a combined view for the Immutable Audit Ledger UI.
   * Uses a single query with COUNT(*) OVER() window function for pagination.
   */
  async getTimeline(taskId: string, opts?: {
    limit?: number
    offset?: number
    event_type?: string
    actor_type?: string
  }) {
    const limit = Math.min(200, Math.max(1, opts?.limit ?? 50))
    const offset = Math.max(0, opts?.offset ?? 0)

    const conditions = ["task_id = ?", taskHistoryPredicate]
    const args: InValue[] = [taskId]

    if (opts?.event_type) {
      conditions.push("event_type = ?")
      args.push(opts.event_type)
    }
    if (opts?.actor_type) {
      conditions.push("actor_type = ?")
      args.push(opts.actor_type)
    }

    const where = conditions.join(" AND ")

    // Skip comments subquery when filtering by event_type that isn't 'comment'
    const includeComments = !opts?.event_type || opts.event_type === "comment"

    // Build unified query with COUNT(*) OVER() to avoid a second round-trip
    const commentSubquery = includeComments
      ? `UNION ALL
         SELECT id, task_id, 'comment' as field, NULL as old_value, content as new_value,
                author as actor, 'user' as actor_type, 'comment' as event_type,
                'Comment: ' || SUBSTR(content, 1, 100) as summary,
                NULL as correlation_id,
                CAST(strftime('%s', created_at) * 1000 AS INTEGER) as created_at
         FROM comments
         WHERE task_id = ?
           ${opts?.actor_type ? "AND author = ?" : ""}`
      : ""

    const commentArgs: InValue[] = includeComments
      ? [taskId, ...(opts?.actor_type ? [opts.actor_type] : [])]
      : []

    const result = await this.forOperation("read", [taskId]).execute(scopedTaskRead(this.scope, sourceSql(`SELECT *, COUNT(*) OVER() as _total
            FROM (
              SELECT id, task_id, field, old_value, new_value, actor, actor_type, event_type, ${PUBLIC_ACTIVITY_SUMMARY} AS summary, correlation_id, created_at
              FROM task_activity_log
              WHERE ${where}
              ${commentSubquery}
            )
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?`, [
        ...args,
        ...commentArgs,
        limit,
        offset,
      ]), "select"))

    const total = result.rows.length > 0
      ? Number((result.rows[0] as Record<string, unknown>)?._total ?? 0)
      : 0

    // Strip the _total window column from output rows
    const events = result.rows.map((row) => {
      const { _total, ...rest } = row as Record<string, unknown>
      return rest
    })

    return { events, total, limit, offset }
  }

  /**
   * Purge all activity log entries for a specific task.
   * GDPR right to erasure — allows deleting audit trail without deleting the task itself.
   * @returns Number of records deleted
   */
  async purgeActivityLog(taskId: string): Promise<number> {
    const result = await this.forOperation("delete", [taskId]).execute(scopedTaskRead(this.scope, sourceSql("DELETE FROM task_activity_log WHERE task_id = ?", [taskId]), "select"))
    return result.rowsAffected
  }

  /**
   * Retention-based cleanup — delete activity log entries older than a cutoff.
   * Use for regular maintenance to prevent unbounded audit log growth.
   * @param cutoffMs - Epoch milliseconds; entries with created_at < this are deleted
   * @returns Number of records deleted
   */
  async purgeActivityLogBefore(cutoffMs: number): Promise<number> {
    const assigned = scopeAssignedTo(this.scope)
    const result = await this.forOperation("delete").execute(scopedTaskRead(this.scope, sql`DELETE FROM task_activity_log
      WHERE task_id IN (SELECT id FROM scoped_tasks ${assigned === undefined ? sourceSql("") : sql`WHERE assigned_to = ${assigned}`}) AND created_at < ${cutoffMs}`))
    return result.rowsAffected
  }

  // ── Task Link Methods ──────────────────────────────────────────────

  /** Get outbound links (this task → other tasks) with target info */
  async getOutboundLinks(taskId: string) {
    const result = await this.forOperation("read", [taskId]).execute(scopedTaskRead(this.scope, sourceSql("SELECT tl.id, tl.source_task_id, tl.target_task_id, tl.link_type, tl.created_at,\n                   t.title AS target_title, t.task_type AS target_task_type, t.ticket_number AS target_ticket_number\n            FROM task_links tl\n            JOIN scoped_tasks t ON t.id = tl.target_task_id AND 1\n            JOIN scoped_tasks source ON source.id = tl.source_task_id AND 1\n            WHERE tl.source_task_id = ?\n            ORDER BY tl.created_at DESC", [taskId]), "select"));
    return result.rows;
  }

  /** Get inbound links (other tasks → this task) with source info */
  async getInboundLinks(taskId: string) {
    const result = await this.forOperation("read", [taskId]).execute(scopedTaskRead(this.scope, sourceSql("SELECT tl.id, tl.source_task_id, tl.target_task_id, tl.link_type, tl.created_at,\n                   t.title AS source_title, t.task_type AS source_task_type, t.ticket_number AS source_ticket_number\n            FROM task_links tl\n            JOIN scoped_tasks t ON t.id = tl.source_task_id AND 1\n            JOIN scoped_tasks target ON target.id = tl.target_task_id AND 1\n            WHERE tl.target_task_id = ?\n            ORDER BY tl.created_at DESC", [taskId]), "select"));
    return result.rows;
  }

  /** Check if a specific link already exists (idempotency) */
  async linkExists(sourceTaskId: string, targetTaskId: string, linkType: string): Promise<boolean> {
    const result = await this.forOperation("read", [sourceTaskId, targetTaskId]).execute(scopedTaskRead(this.scope, sourceSql("SELECT id FROM task_links WHERE source_task_id = ? AND target_task_id = ? AND link_type = ?\n        AND EXISTS (SELECT 1 FROM scoped_tasks AS tasks WHERE id = task_links.source_task_id AND 1)\n        AND EXISTS (SELECT 1 FROM scoped_tasks AS tasks WHERE id = task_links.target_task_id AND 1)", [sourceTaskId, targetTaskId, linkType]), "select"));
    return result.rows.length > 0;
  }

  /** Create a task link inside a write lock with optional atomic assignee verification on both endpoints. */
  async createLinkChecked(
    id: string,
    sourceTaskId: string,
    targetTaskId: string,
    linkType: string,
    expectedAssignedTo?: string,
  ): Promise<{ ok: true; createdAt: string } | { ok: false; errorCode: "not_found" | "assignee_mismatch" }> {
    const now = new Date().toISOString()
    const tx = await this.forOperation("edit", [sourceTaskId, targetTaskId]).transaction("write")
    try {
      const res = await tx.execute(scopedTaskRead(this.scope, sourceSql("SELECT id, assigned_to FROM scoped_tasks AS tasks WHERE 1 AND id IN (?, ?)", [sourceTaskId, targetTaskId]), "select"))
      const byId = new Map(res.rows.map(r => [String((r as Record<string, unknown>).id), (r as Record<string, unknown>).assigned_to]))
      if (!byId.has(sourceTaskId) || !byId.has(targetTaskId)) {
        await tx.commit()
        return { ok: false, errorCode: "not_found" }
      }
      if (expectedAssignedTo !== undefined && (byId.get(sourceTaskId) !== expectedAssignedTo || byId.get(targetTaskId) !== expectedAssignedTo)) {
        await tx.commit()
        return { ok: false, errorCode: "assignee_mismatch" }
      }
      await tx.execute(scopedTaskRead(this.scope, sourceSql("INSERT INTO task_links (id, source_task_id, target_task_id, link_type, created_at) VALUES (?, ?, ?, ?, ?)", [id, sourceTaskId, targetTaskId, linkType, now]), "select"))
      await tx.commit()
      return { ok: true, createdAt: now }
    } finally {
      tx.close()
    }
  }

  /** Create a new task link */
  async createLink(id: string, sourceTaskId: string, targetTaskId: string, linkType: string): Promise<string> {
    const res = await this.createLinkChecked(id, sourceTaskId, targetTaskId, linkType)
    return res.ok ? res.createdAt : new Date().toISOString()
  }

  /** Fetch endpoints for a task link belonging to the specified task */
  async getLinkEndpoints(linkId: string, taskId: string): Promise<{ source_task_id: string; target_task_id: string } | null> {
    const result = await this.forOperation("read", [taskId]).execute(scopedTaskRead(this.scope, sourceSql("SELECT source_task_id, target_task_id FROM task_links WHERE id = ? AND (source_task_id = ? OR target_task_id = ?)\n        AND EXISTS (SELECT 1 FROM scoped_tasks AS tasks WHERE id = task_links.source_task_id AND 1)\n        AND EXISTS (SELECT 1 FROM scoped_tasks AS tasks WHERE id = task_links.target_task_id AND 1)", [linkId, taskId, taskId]), "select"))
    const row = result.rows[0] as Record<string, unknown> | undefined
    if (!row) return null
    return {
      source_task_id: String(row.source_task_id),
      target_task_id: String(row.target_task_id),
    }
  }

  /** Delete a task link atomically with optional assignee ownership guard on both endpoints. */
  async deleteLinkChecked(
    linkId: string,
    taskId: string,
    expectedAssignedTo?: string,
  ): Promise<{ deleted: number; assigneeMismatch: boolean }> {
    const tx = await this.forOperation("edit", [taskId]).transaction("write")
    try {
      const { rows: [link] } = await tx.execute(scopedTaskRead(this.scope, sql`SELECT source_task_id, target_task_id FROM task_links WHERE id = ${linkId}
        AND (source_task_id = ${taskId} OR target_task_id = ${taskId})
        AND EXISTS (SELECT 1 FROM scoped_tasks WHERE id = source_task_id) AND EXISTS (SELECT 1 FROM scoped_tasks WHERE id = target_task_id)`))
      if (!link) return { deleted: 0, assigneeMismatch: false }
      for (const id of [String(link.source_task_id), String(link.target_task_id)]) {
        if (!await validateTaskOperation(tx, this.scope, id, { resource: "task", action: "edit" }, expectedAssignedTo)) return { deleted: 0, assigneeMismatch: expectedAssignedTo !== undefined }
      }
      const result = await tx.execute(scopedTaskRead(this.scope, sql`DELETE FROM task_links WHERE id = ${linkId}
        AND EXISTS (SELECT 1 FROM scoped_tasks WHERE id = source_task_id) AND EXISTS (SELECT 1 FROM scoped_tasks WHERE id = target_task_id)`))
      await tx.commit()
      return { deleted: result.rowsAffected, assigneeMismatch: false }
    } finally { tx.close() }
  }

  /** Delete a task link (scoped to a specific task for authorization) */
  async deleteLink(linkId: string, taskId: string): Promise<number> {
    return (await this.deleteLinkChecked(linkId, taskId)).deleted
  }

  private async requireIntegrationWriter(tx: Transaction, context: IntegrationScope, action: WorkAction, taskId?: string): Promise<void> {
    if (context.scope !== this.scope || !["calendar.sync", "todo.sync", "grocy.sync"].includes(context.binding.purpose)) throw new BoardOperationError("denied")
    await requireBoardWriterCheck(tx, this.scope, async () => {
      const allowed = await validateIntegrationScope(context, tx, { resource: "task", action })
      if (!allowed.ok) throw new BoardOperationError(allowed.errorCode === "destination_unavailable" ? "unavailable" : allowed.errorCode)
      if (!taskId) return
      if (!await validateTaskOperation(tx, context.scope, taskId, { resource: "task", action }) || context.originatingActor &&
        !await validateTaskOperation(tx, context.originatingActor, taskId, { resource: "task", action })) throw new BoardOperationError("unavailable")
    })
  }

  async persistManualCalendarConfirmation(params: {
    taskId: string, requestId: string, confirmationId: string, providerEventId?: string, payload?: unknown,
  }, context: IntegrationScope): Promise<{ confirmationId: string, alreadyExisted: boolean }> {
    const tx = await acquireWriteTransaction(this.forOperation("edit", [params.taskId]))
    try {
      await this.requireIntegrationWriter(tx, context, "edit", params.taskId)
      if (context.binding.purpose !== "calendar.sync") throw new BoardOperationError("denied")
      const { rows: [existing] } = await tx.execute(sql`SELECT confirmation_id FROM calendar_confirmations
        WHERE binding_id = ${context.binding.id} AND task_id = ${params.taskId} AND request_id = ${params.requestId} AND source = 'manual.confirmation'`)
      if (existing) { await tx.commit(); return { confirmationId: String(existing.confirmation_id), alreadyExisted: true } }
      // External confirmation identifiers remain data, never authority over the
      // global internal primary key namespace.
      const confirmationId = crypto.randomUUID()
      const now = Date.now()
      await tx.execute(sql`INSERT INTO calendar_confirmations(confirmation_id, task_id, request_id, provider_event_id, source, payload, created_at, binding_id)
        VALUES (${confirmationId}, ${params.taskId}, ${params.requestId}, ${params.providerEventId ?? null}, 'manual.confirmation', ${JSON.stringify(params.payload ?? null)}, ${now}, ${context.binding.id})`)
      await tx.execute(sql`UPDATE tasks SET calendar_sync_state = 'confirmed', updated_at = ${now} WHERE id = ${params.taskId} AND ${taskOwnedBy(this.scope)}`)
      await tx.execute(sql`INSERT INTO audit_trail(audit_id, request_id, task_id, integration, level, message, metadata, created_at)
        VALUES (${crypto.randomUUID()}, ${params.requestId}, ${params.taskId}, 'calendar', 'info', 'Manual calendar confirmation persisted', ${JSON.stringify({ confirmationId, providerEventId: params.providerEventId ?? null })}, ${now})`)
      await tx.commit()
      return { confirmationId, alreadyExisted: false }
    } finally { tx.close() }
  }

  private originatingProjectionOperation(context: IntegrationScope): WorkOperation {
    return context.originatingOperation?.resource === "task" ? context.originatingOperation : { resource: "task", action: "read" }
  }

  private async boundSyncReferenceRows(reader: Pick<Client, "execute">, context: IntegrationScope, entityId: string, source: "calendar" | "ha_todo" | "grocy" = "calendar", externalIds?: readonly string[]) {
    const purpose = source === "calendar" ? "calendar.sync" : source === "ha_todo" ? "todo.sync" : "grocy.sync"
    if (context.scope !== this.scope || context.binding.purpose !== purpose ||
      source !== "grocy" && context.binding.sourceId !== entityId && !(source === "calendar" && context.binding.sourceId === "configured-caldav")) throw new BoardOperationError("denied")
    const valid = await validateIntegrationScope(context, reader, { resource: "task", action: "read" })
    if (!valid.ok) throw new BoardOperationError(valid.errorCode === "destination_unavailable" ? "unavailable" : valid.errorCode)
    const table = source === "calendar" ? "calendar_confirmations" : source === "ha_todo" ? "todo_sync_confirmations" : "grocy_sync_confirmations"
    const column = source === "calendar" ? "provider_event_id" : source === "ha_todo" ? "ha_todo_uid" : "grocy_entity_id"
    const entity = source === "calendar" ? sql`CASE WHEN json_valid(c.payload) THEN COALESCE(json_extract(c.payload, '$.calendar_href'), json_extract(c.payload, '$.entity_id')) END = ${entityId}` :
      source === "ha_todo" ? sql`c.ha_entity_id = ${entityId}` : sql`c.grocy_entity_type = ${entityId}`
    const result = await reader.execute(scopedTaskRead(this.scope, sql`SELECT c.confirmation_id, c.task_id, ${sourceSql(`c.${column}`)} AS provider_event_id, c.payload,
      ${source === "grocy" ? sourceSql("'grocy'") : sourceSql("c.source")} AS source, c.created_at,
      ${source === "calendar" ? sourceSql("c.created_at") : sourceSql("COALESCE(c.updated_at,c.created_at)")} AS sync_updated_at,
      t.id AS visible_task_id, EXISTS (SELECT 1 FROM tasks physical_task WHERE physical_task.id = c.task_id) AS physical_task_exists
      FROM ${sourceSql(table)} c LEFT JOIN scoped_tasks t ON t.id = c.task_id
      WHERE c.binding_id = ${context.binding.id} AND ${entity}
        ${externalIds ? sql`AND ${sourceSql(`c.${column}`)} IN (SELECT value FROM json_each(${JSON.stringify(externalIds)}))` : sourceSql("")}
      ORDER BY c.created_at, c.confirmation_id`))
    const deletedIds = result.rows.filter(row => !row.physical_task_exists).map(row => String(row.task_id))
    const deletionEvents = new Map<string, Record<string, unknown>[]>()
    if (deletedIds.length) {
      const { rows } = await reader.execute(sql`SELECT task_id, payload FROM domain_events WHERE event_type = 'task.deleted'
        AND task_id IN (SELECT value FROM json_each(${JSON.stringify(deletedIds)})) ORDER BY created_at DESC`)
      for (const row of rows) {
        const id = String(row.task_id)
        const events = deletionEvents.get(id) ?? []
        events.push(row); deletionEvents.set(id, events)
      }
    }
    const values: Array<{ confirmationId: string, taskId: string, externalId: string, payload: string | null, source: string, createdAt: number, syncUpdatedAt: number, taskDeleted?: boolean, suppressed?: boolean }> = []
    for (const row of result.rows) {
      let authorized = row.visible_task_id != null
      let deleted = false
      if (authorized && context.originatingActor) authorized = await validateTaskOperation(reader, context.originatingActor, String(row.task_id), this.originatingProjectionOperation(context))
      if (!row.physical_task_exists) {
        for (const event of deletionEvents.get(String(row.task_id)) ?? []) {
          let snapshot: Record<string, unknown>
          try { snapshot = JSON.parse(String(event.payload)) } catch { continue }
          const proof = snapshot?._authority as Record<string, unknown> | undefined
          if (!proof || proof.version !== 1 || proof.operation !== "delete" || proof.boardId !== this.scope.boardId || snapshot.id !== row.task_id ||
            !Array.isArray(proof.bindingRefs) || !proof.bindingRefs.some(binding => binding?.id === context.binding.id && binding?.generation === context.binding.generation)) continue
          if (context.originatingActor && (proof.principalKind !== context.originatingActor.principal.kind || proof.principalId !== context.originatingActor.principal.id)) continue
          const recorded = proof.placement as { areaId?: unknown, projectId?: unknown } | undefined
          if (!recorded && proof.oldProjectId != null) continue
          if (recorded && (recorded.areaId !== null && typeof recorded.areaId !== "string" || recorded.projectId !== null && typeof recorded.projectId !== "string" || recorded.areaId !== proof.oldAreaId || recorded.projectId !== proof.oldProjectId)) continue
          const areaId = typeof recorded?.areaId === "string" ? recorded.areaId : typeof proof.oldAreaId === "string" ? proof.oldAreaId : null
          const projectId = typeof recorded?.projectId === "string" ? recorded.projectId : typeof proof.oldProjectId === "string" ? proof.oldProjectId : null
          let known = true
          for (const [table, id] of [["areas", areaId], ["projects", projectId]] as const) {
            if (id && !(await reader.execute(sql`SELECT 1 FROM ${sourceSql(table)} WHERE id = ${id} AND ${ownedPlanning(this.scope, table)}`)).rows.length) known = false
          }
          if (!known || context.binding.destination.projectId && projectId !== context.binding.destination.projectId ||
            context.binding.destination.areaId && areaId !== context.binding.destination.areaId ||
            !await validateBoardPlacement(this.scope, reader, { areaId }) || !await validateBoardPlacement(this.scope, reader, { projectId })) continue
          authorized = true; deleted = true; break
        }
      }
      // A known binding reference can suppress duplicate provider capture without
      // publishing any unavailable task identity or predecessor private payload.
      values.push({ confirmationId: String(row.confirmation_id), taskId: authorized ? String(row.task_id) : "", externalId: String(row.provider_event_id),
        payload: authorized && typeof row.payload === "string" ? row.payload : null, source: String(row.source), createdAt: Number(row.created_at), syncUpdatedAt: Number(row.sync_updated_at),
        ...(!row.physical_task_exists ? { taskDeleted: true } : {}), ...(!authorized ? { suppressed: true } : {}), ...(deleted ? { taskDeleted: true } : {}) })
    }
    // Predecessor dangling references have no proven Board ownership. Retain
    // them unbound and suppress only the exact historical source UID, without
    // adopting old identities, dates, rules or private provider payloads.
    const known = new Set(values.map(value => value.externalId))
    const unbound = await reader.execute(sql`SELECT DISTINCT ${sourceSql(`c.${column}`)} AS external_id
      FROM ${sourceSql(table)} c WHERE c.binding_id IS NULL AND ${entity}
        ${externalIds ? sql`AND ${sourceSql(`c.${column}`)} IN (SELECT value FROM json_each(${JSON.stringify(externalIds)}))` : sourceSql("")}
        AND NOT EXISTS (SELECT 1 FROM tasks physical_task WHERE physical_task.id = c.task_id)`)
    for (const row of unbound.rows) {
      if (typeof row.external_id !== "string" || known.has(row.external_id)) continue
      values.push({ confirmationId: "", taskId: "", externalId: row.external_id, payload: null,
        source: "unavailable", createdAt: 0, syncUpdatedAt: 0, taskDeleted: true, suppressed: true })
    }
    return values
  }

  private async listSyncReferences(context: IntegrationScope, source: "calendar" | "ha_todo" | "grocy", entityId: string) {
    const tx = await this.forOperation("read").transaction("read")
    try {
      const values = await this.boundSyncReferenceRows(tx, context, entityId, source)
      await tx.commit()
      const valid = await validateIntegrationScope(context, this.client, { resource: "task", action: "read" })
      if (!valid.ok) throw new BoardOperationError(valid.errorCode === "destination_unavailable" ? "unavailable" : valid.errorCode)
      for (const item of values) if (!item.taskDeleted && !item.suppressed && context.originatingActor &&
        !await validateTaskOperation(this.client, context.originatingActor, item.taskId, this.originatingProjectionOperation(context))) throw new BoardOperationError("stale")
      return values
    } finally { tx.close() }
  }

  async listCalendarSyncReferences(context: IntegrationScope, entityId: string): Promise<Array<{ confirmationId: string, taskId: string, externalId: string, payload: string | null, source: string, createdAt: number, taskDeleted?: boolean, suppressed?: boolean }>> {
    return this.listSyncReferences(context, "calendar", entityId)
  }

  async releaseSyncCalendarReferences(context: IntegrationScope, refs: readonly { confirmationId: string, taskId: string, externalId: string }[]): Promise<number> {
    if (context.scope !== this.scope || context.binding.purpose !== "calendar.sync") throw new BoardOperationError("denied")
    if (refs.length > 25) {
      let released = 0
      for (let offset = 0; offset < refs.length; offset += 25) {
        if (offset) await new Promise<void>(resolve => setImmediate(resolve))
        released += await this.releaseSyncCalendarReferences(context, refs.slice(offset, offset + 25))
      }
      return released
    }
    let released = 0
    const tx = await acquireWriteTransaction(this.client)
    try {
      const valid = await validateIntegrationScope(context, tx, { resource: "task", action: "read" })
      if (!valid.ok) throw new BoardOperationError(valid.errorCode === "destination_unavailable" ? "unavailable" : valid.errorCode)
      const entities = new Map<string, Awaited<ReturnType<TaskRepository["boundSyncReferenceRows"]>>>()
      for (const ref of refs) {
        const { rows: [record] } = await tx.execute(sql`SELECT payload FROM calendar_confirmations WHERE confirmation_id = ${ref.confirmationId}
          AND task_id = ${ref.taskId} AND provider_event_id = ${ref.externalId} AND binding_id = ${context.binding.id}`)
        if (!record || typeof record.payload !== "string") continue
        let payload: Record<string, unknown>
        try { payload = JSON.parse(record.payload) } catch { continue }
        const entity = typeof payload.calendar_href === "string" ? payload.calendar_href : typeof payload.entity_id === "string" ? payload.entity_id : null
        if (!entity) continue
        let references = entities.get(entity)
        if (!references) { references = await this.boundSyncReferenceRows(tx, context, entity); entities.set(entity, references) }
        const known = references.find(item => item.confirmationId === ref.confirmationId && item.taskId === ref.taskId && item.externalId === ref.externalId && !item.suppressed)
        if (!known) continue
        const result = await tx.execute(sql`DELETE FROM calendar_confirmations WHERE confirmation_id = ${ref.confirmationId} AND task_id = ${ref.taskId} AND provider_event_id = ${ref.externalId} AND binding_id = ${context.binding.id}`)
        released += result.rowsAffected
      }
      const current = await validateIntegrationScope(context, tx, { resource: "task", action: "read" })
      if (!current.ok) throw new BoardOperationError(current.errorCode === "destination_unavailable" ? "unavailable" : current.errorCode)
      await tx.commit()
      return released
    } finally { tx.close() }
  }

  async findTasksByExternalSyncIds(lookup: ExternalSyncLookup, context: IntegrationScope): Promise<Map<string, ExternalSyncMatch>> {
    if (context.scope !== this.scope) throw new BoardOperationError("denied")
    const matches = new Map<string, ExternalSyncMatch>()
      const requested = new Set(lookup.externalIds)
      const references = (await this.listSyncReferences(context, lookup.source, lookup.source === "grocy" ? lookup.grocyEntityType : lookup.entityId)).filter(reference => requested.has(reference.externalId))
      const ids = references.filter(item => !item.suppressed && !item.taskDeleted).map(item => item.taskId)
      const versions = new Map<string, number>()
      for (let offset = 0; offset < ids.length; offset += 190) {
        const { rows } = await this.forOperation("read").execute(scopedTaskRead(this.scope, sql`SELECT id, ${sourceSql(taskTimestampMs("updated_at"))} AS updated_at FROM scoped_tasks WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids.slice(offset, offset + 190))}))`))
        for (const row of rows) versions.set(String(row.id), Number(row.updated_at))
      }
      for (const reference of references) {
        const suppressed = reference.suppressed || !reference.taskDeleted && !versions.has(reference.taskId)
        matches.set(reference.externalId, { confirmationId: reference.confirmationId, taskId: suppressed ? "" : reference.taskId, externalId: reference.externalId,
          syncUpdatedAt: reference.syncUpdatedAt, taskUpdatedAt: versions.get(reference.taskId) ?? 0, payload: suppressed ? null : reference.payload,
          ...(reference.taskDeleted ? { taskDeleted: true } : {}), ...(suppressed ? { suppressed: true } : {}) })
      }
    if (!(await validateIntegrationScope(context, this.client, { resource: "task", action: "read" })).ok) throw new BoardOperationError("stale")
    return matches
  }

  /** Read the binding's link and the exact current task version in one authorized snapshot. */
  async findSyncConfirmation(taskId: string, context: IntegrationScope): Promise<{ taskVersion: number, confirmation: { confirmationId: string, externalId: string, payload: string | null } | null } | null> {
    if (context.scope !== this.scope) throw new BoardOperationError("denied")
    const tx = await this.forOperation("read", [taskId]).transaction("read")
    try {
      const valid = await validateIntegrationScope(context, tx, { resource: "task", action: "read" })
      if (!valid.ok) throw new BoardOperationError(valid.errorCode === "destination_unavailable" ? "unavailable" : valid.errorCode)
      if (context.originatingActor && !await validateTaskOperation(tx, context.originatingActor, taskId, this.originatingProjectionOperation(context))) return null
      const { rows: [task] } = await tx.execute(scopedTaskRead(this.scope, sql`SELECT ${sourceSql(taskTimestampMs("updated_at"))} AS version FROM scoped_tasks WHERE id = ${taskId}`))
      if (!task) return null
      const kind = context.binding.purpose === "calendar.sync" ? "calendar" : context.binding.purpose === "todo.sync" ? "todo" : context.binding.purpose === "grocy.sync" ? "grocy" : null
      if (!kind) throw new BoardOperationError("denied")
      const table = kind === "calendar" ? "calendar_confirmations" : kind === "todo" ? "todo_sync_confirmations" : "grocy_sync_confirmations"
      const column = kind === "calendar" ? "provider_event_id" : kind === "todo" ? "ha_todo_uid" : "grocy_entity_id"
      const { rows: [link] } = await tx.execute(sql`SELECT confirmation_id, ${sourceSql(column)} AS external_id, payload FROM ${sourceSql(table)}
        WHERE binding_id = ${context.binding.id} AND task_id = ${taskId} ORDER BY created_at DESC, confirmation_id DESC LIMIT 1`)
      await tx.commit()
      if (!(await validateIntegrationScope(context, this.client, { resource: "task", action: "read" })).ok || context.originatingActor &&
        !await validateTaskOperation(this.client, context.originatingActor, taskId, this.originatingProjectionOperation(context))) throw new BoardOperationError("stale")
      return { taskVersion: Number(task.version), confirmation: link ? { confirmationId: String(link.confirmation_id), externalId: String(link.external_id), payload: link.payload == null ? null : String(link.payload) } : null }
    } finally { tx.close() }
  }

  /** Dedicated outbound receipt bookkeeping. It grants no task mutation authority. */
  async saveSyncConfirmationForTask(taskId: string, confirmation: SyncConfirmationTarget, context: IntegrationScope, expectedTaskVersion: number): Promise<boolean> {
    if (context.scope !== this.scope || !Number.isSafeInteger(expectedTaskVersion) || expectedTaskVersion < 0) throw new BoardOperationError("denied")
    // The read-only public UoW stays read-only. This fixed command owns only its
    // binding-specific confirmation SQL and rechecks both authorities in writer.
    const tx = await acquireWriteTransaction(this.client)
    try {
      const current = async () => {
        const valid = await validateIntegrationScope(context, tx, { resource: "task", action: "read" })
        if (!valid.ok) throw new BoardOperationError(valid.errorCode === "destination_unavailable" ? "unavailable" : valid.errorCode)
        if (!await validateTaskOperation(tx, this.scope, taskId, { resource: "task", action: "read" }) || context.originatingActor &&
          !await validateTaskOperation(tx, context.originatingActor, taskId, this.originatingProjectionOperation(context))) throw new BoardOperationError("unavailable")
        const { rows: [task] } = await tx.execute(scopedTaskRead(this.scope, sql`SELECT ${sourceSql(taskTimestampMs("updated_at"))} AS version FROM scoped_tasks WHERE id = ${taskId}`))
        return task && Number(task.version) === expectedTaskVersion
      }
      if (!await current()) return false
      if (!confirmation.confirmationId) {
        const table = confirmation.source === "calendar" ? "calendar_confirmations" : confirmation.source === "ha_todo" ? "todo_sync_confirmations" : "grocy_sync_confirmations"
        if ((await tx.execute(sql`SELECT 1 FROM ${sourceSql(table)} WHERE binding_id = ${context.binding.id} AND task_id = ${taskId} LIMIT 1`)).rows.length) return false
      }
      if (!await this.saveSyncConfirmation(tx, context, confirmation, taskId, crypto.randomUUID(), expectedTaskVersion, true)) return false
      if (!await current()) return false
      await tx.commit()
      return true
    } finally { tx.close() }
  }

  private async saveSyncConfirmation(tx: Transaction, context: IntegrationScope, conf: SyncConfirmationTarget, taskId: string, requestId: string, now: number, requireExisting = false): Promise<boolean> {
    const expectedPurpose = conf.source === "calendar" ? "calendar.sync" : conf.source === "ha_todo" ? "todo.sync" : "grocy.sync"
    if (context.binding.purpose !== expectedPurpose || (conf.source !== "grocy" && conf.entityId !== context.binding.sourceId && !(conf.source === "calendar" && context.binding.sourceId === "configured-caldav" && conf.confirmationSource === "caldav"))) throw new BoardOperationError("denied")
    const table = conf.source === "calendar" ? "calendar_confirmations" : conf.source === "ha_todo" ? "todo_sync_confirmations" : "grocy_sync_confirmations"
    const column = conf.source === "calendar" ? "provider_event_id" : conf.source === "ha_todo" ? "ha_todo_uid" : "grocy_entity_id"
    const previousId = conf.source === "calendar" ? conf.previousExternalId ?? conf.externalId : conf.externalId
    const { rows: [old] } = await tx.execute(sql`SELECT confirmation_id FROM ${sourceSql(table)} WHERE binding_id = ${context.binding.id} AND task_id = ${taskId}
      ${conf.confirmationId ? sql`AND confirmation_id = ${conf.confirmationId}` : sql`AND ${sourceSql(column)} = ${previousId}`}
      ${conf.source === "grocy" ? sql`AND grocy_entity_type = ${conf.grocyEntityType}` : conf.source === "ha_todo" ? sql`AND ha_entity_id = ${conf.entityId}` : sql`AND source = ${conf.confirmationSource ?? "ha.calendar_sync"}`}
      ORDER BY created_at DESC, confirmation_id LIMIT 1`)
    if (old) {
      await tx.execute(sql`UPDATE ${sourceSql(table)} SET ${sourceSql(column)} = ${conf.externalId}, payload = ${conf.payload}
        ${conf.source === "calendar" ? sourceSql("") : sql`, updated_at = ${now}`}
        WHERE confirmation_id = ${String(old.confirmation_id)} AND binding_id = ${context.binding.id} AND task_id = ${taskId}`)
      return true
    }
    if (requireExisting && conf.confirmationId) return false
    const id = crypto.randomUUID()
    if (conf.source === "calendar") await tx.execute(sql`INSERT INTO calendar_confirmations(confirmation_id, task_id, request_id, provider_event_id, source, payload, created_at, binding_id)
      VALUES (${id}, ${taskId}, ${requestId}, ${conf.externalId}, ${conf.confirmationSource ?? "ha.calendar_sync"}, ${conf.payload}, ${now}, ${context.binding.id})`)
    else if (conf.source === "ha_todo") await tx.execute(sql`INSERT INTO todo_sync_confirmations(confirmation_id, task_id, request_id, ha_entity_id, ha_todo_uid, source, sync_direction, payload, created_at, updated_at, binding_id)
      VALUES (${id}, ${taskId}, ${requestId}, ${conf.entityId}, ${conf.externalId}, 'ha.todo_sync', ${conf.syncDirection ?? "inbound"}, ${conf.payload}, ${now}, ${now}, ${context.binding.id})`)
    else await tx.execute(sql`INSERT INTO grocy_sync_confirmations(confirmation_id, task_id, grocy_entity_type, grocy_entity_id, sync_direction, payload, created_at, updated_at, binding_id)
      VALUES (${id}, ${taskId}, ${conf.grocyEntityType}, ${conf.externalId}, ${conf.syncDirection ?? "inbound"}, ${conf.payload}, ${now}, ${now}, ${context.binding.id})`)
    return true
  }

  async commitSyncMutationChunks(mutations: SyncTaskMutation[], context: IntegrationScope,
    options?: { chunkSize?: number | undefined, signal?: AbortSignal | undefined },
  ): Promise<SyncChunkCommitResult> {
    const aggregate: SyncChunkCommitResult = { created: 0, updated: 0, linked: 0, skipped: 0, chunksCommitted: 0, ticketNumbers: [], errors: [] }
    if (context.scope !== this.scope || !["calendar.sync", "todo.sync", "grocy.sync"].includes(context.binding.purpose)) throw new BoardOperationError("denied")
    const chunkSize = Math.max(1, Math.min(25, Math.floor(options?.chunkSize ?? 25)))
    for (let offset = 0; offset < mutations.length; offset += chunkSize) {
      options?.signal?.throwIfAborted()
      if (offset) await new Promise<void>(resolve => setImmediate(resolve))
      const inheritedAssignments = new Map<string, { assigneeId: string | null, proof?: AssignmentProof | undefined }>()
      for (const mutation of mutations.slice(offset, offset + chunkSize)) {
        const ids = [...(mutation.kind === "update" && mutation.status && isDoneStatus(mutation.status) ? [mutation.taskId] : []),
          ...(mutation.replacedCalendarLinks ?? []).filter(link => link.completeIfStatus !== undefined).map(link => link.taskId)]
        for (const taskId of ids) {
          if (inheritedAssignments.has(taskId)) continue
          const source = await this.findTaskForCommand(taskId, "edit")
          if (!source?.recurrence_rule) continue
          const proof = source.assigned_to?.startsWith("ha_") ? await resolveHAAssignmentProof(this.scope, source.assigned_to.slice(3), options?.signal) : undefined
          inheritedAssignments.set(taskId, { assigneeId: source.assigned_to ?? null, ...(proof ? { proof } : {}) })
        }
      }
      const first = mutations[offset]!
      const tx = await acquireWriteTransaction(this.forOperation(first.kind === "create" ? "create" : "edit"), { signal: options?.signal })
      const outcome: SyncChunkCommitResult = { created: 0, updated: 0, linked: 0, skipped: 0, chunksCommitted: 1, ticketNumbers: [], errors: [] }
      try {
        for (let index = offset; index < Math.min(offset + chunkSize, mutations.length); index++) {
          options?.signal?.throwIfAborted()
          const mutation = mutations[index]!, savepoint = `sync_item_${index - offset}`
          await tx.execute(`SAVEPOINT ${savepoint}`)
          try {
            const now = mutation.kind === "update" ? mutation.updatedAt ?? Date.now() : mutation.createdAt ?? Date.now()
            const action = mutation.kind === "create" ? "create" : "edit"
            await requireBoardWriterIntent(tx, this.scope, { resource: "task", action })
            await this.requireIntegrationWriter(tx, context, action, mutation.kind === "create" ? undefined : mutation.taskId)
            if (mutation.confirmation?.source === "calendar") for (const link of mutation.replacedCalendarLinks ?? []) {
              const { rows: [live] } = await tx.execute(scopedTaskRead(this.scope, sql`SELECT id FROM scoped_tasks WHERE id = ${link.taskId}`))
              if (live) await this.requireIntegrationWriter(tx, context, "edit", link.taskId)
              else {
                const references = await this.boundSyncReferenceRows(tx, context, mutation.confirmation.entityId)
                const tombstone = references.find(item => item.confirmationId === link.confirmationId && item.taskId === link.taskId && item.externalId === link.externalId && item.taskDeleted && !item.suppressed)
                if (!tombstone || link.completeIfStatus !== undefined) throw new BoardOperationError("unavailable")
                await requireBoardWriterCheck(tx, this.scope, async () => {
                  const current = await validateIntegrationScope(context, tx, { resource: "task", action: "read" })
                  if (!current.ok) throw new BoardOperationError(current.errorCode === "destination_unavailable" ? "unavailable" : current.errorCode)
                })
              }
              const removed = await tx.execute(sql`DELETE FROM calendar_confirmations WHERE confirmation_id = ${link.confirmationId} AND task_id = ${link.taskId} AND provider_event_id = ${link.externalId} AND binding_id = ${context.binding.id}`)
              if (removed.rowsAffected && link.completeIfStatus !== undefined) {
                const { rows: [task] } = await tx.execute(scopedTaskRead(this.scope, sql`SELECT * FROM scoped_tasks WHERE id = ${link.taskId}`))
                const remaining = await tx.execute(sql`SELECT 1 FROM calendar_confirmations WHERE task_id = ${link.taskId} AND binding_id = ${context.binding.id}`)
                if (task?.status === link.completeIfStatus && !remaining.rows.length) {
                  const done = await this.updateTaskCommand(link.taskId, { status: STATUS.COMPLETE }, { recurrenceAssignment: inheritedAssignments.get(link.taskId) }, tx, undefined, context)
                  if (!done.ok) throw new BoardOperationError("unavailable")
                }
              }
            }
            if (mutation.kind === "create") {
              const confirmation = mutation.confirmation
              const references = await this.boundSyncReferenceRows(tx, context,
                confirmation.source === "grocy" ? confirmation.grocyEntityType : confirmation.entityId,
                confirmation.source, [confirmation.externalId])
              if (references.length) {
                // The provider's current UID is independent of transport retry
                // keys. A suppressed reference still reserves that occurrence.
                await tx.execute(`ROLLBACK TO SAVEPOINT ${savepoint}`)
                await tx.execute(`RELEASE SAVEPOINT ${savepoint}`)
                outcome.skipped++
                continue
              }
              const placement = context.binding.destination
              if (mutation.areaId !== undefined && mutation.areaId !== placement.areaId) throw new BoardOperationError("denied")
              const { prepareTaskCreation } = await import("../task-creation-service")
              const prepared = await prepareTaskCreation(this, {
                title: mutation.title, description: mutation.description ?? "", status: mutation.status ?? STATUS.PENDING, priority: mutation.priority ?? 3,
                due_date: mutation.dueDate ?? null, start_date: mutation.startDate ?? null, end_date: mutation.endDate ?? null, recurrence_rule: mutation.recurrenceRule ?? null,
                labels: mutation.labels ?? [], area_id: placement.areaId ?? null, project_id: placement.projectId ?? null,
                task_type: mutation.taskType ?? "task", task_kind: mutation.taskKind ?? "standard_action",
              }, { id: mutation.taskId ?? crypto.randomUUID(), useDefaultAssignee: false })
              if (!prepared.ok) throw new Error(prepared.error)
              if (isDoneStatus(prepared.task.status)) await this.requireIntegrationWriter(tx, context, "complete")
              const created = await this.createWorkInWriter(tx, prepared.task, { integrationContext: context, clientIdempotencyKey: `integration:${context.binding.id}:${mutation.idempotencyKey}`, requestId: mutation.requestId ?? crypto.randomUUID() }, now)
              if (!created.ok) throw new Error(`Task creation unavailable: ${created.errorCode}`)
              await this.saveSyncConfirmation(tx, context, mutation.confirmation, created.task.id, mutation.requestId ?? crypto.randomUUID(), now)
              await tx.execute(sql`UPDATE tasks SET calendar_sync_state = 'synced' WHERE id = ${created.task.id} AND ${taskOwnedBy(this.scope)}`)
              if (created.replayed) outcome.skipped++
              else { outcome.created++; outcome.ticketNumbers.push(created.ticketNumber) }
            } else if (mutation.kind === "link") {
              await this.saveSyncConfirmation(tx, context, mutation.confirmation, mutation.taskId, mutation.requestId ?? crypto.randomUUID(), now)
              outcome.linked++
            } else {
              const { rows: [current] } = await tx.execute(scopedTaskRead(this.scope, sql`SELECT *, ${sourceSql(taskTimestampMs("updated_at"))} AS current_version FROM scoped_tasks WHERE id = ${mutation.taskId}`))
              if (!current) throw new BoardOperationError("unavailable")
              if (mutation.expected && "status" in mutation.expected && current.status !== mutation.expected.status) {
                await tx.execute(`ROLLBACK TO SAVEPOINT ${savepoint}`); await tx.execute(`RELEASE SAVEPOINT ${savepoint}`); outcome.skipped++; continue
              }
              if (mutation.confirmation?.source === "ha_todo" && mutation.confirmation.requireUnmodifiedSinceSync) {
                const { rows: [link] } = await tx.execute(sql`SELECT updated_at FROM todo_sync_confirmations WHERE binding_id = ${context.binding.id} AND task_id = ${mutation.taskId} AND confirmation_id = ${mutation.confirmation.confirmationId ?? ""} AND ha_entity_id = ${mutation.confirmation.entityId} AND ha_todo_uid = ${mutation.confirmation.externalId}`)
                if (!link || Number(current.current_version) > Number(link.updated_at)) {
                  await tx.execute(`RELEASE SAVEPOINT ${savepoint}`); outcome.skipped++; continue
                }
              }
              const fields: Record<string, InValue> = {}
              const assign = (column: string, value: InValue | undefined, expectedKey?: keyof NonNullable<typeof mutation.expected>) => {
                if (value === undefined || expectedKey && mutation.expected && expectedKey in mutation.expected && current[column] !== mutation.expected[expectedKey]) return
                if (current[column] !== value) fields[column] = value
              }
              assign("title", mutation.title, "title")
              if (!(mutation.openEcho && current.deferred_at != null && !isClosedStatus(String(current.status)))) assign("status", mutation.status === undefined ? undefined : normalizeStatus(mutation.status), "status")
              assign("due_date", mutation.updateDueDate || mutation.dueDate !== undefined ? mutation.dueDate ?? null : undefined, "dueDate")
              assign("start_date", mutation.startDate, "startDate"); assign("end_date", mutation.endDate, "endDate")
              assign("recurrence_rule", mutation.recurrenceRule === null && !mutation.replaceRecurrenceRule ? undefined : mutation.recurrenceRule, "recurrenceRule")
              assign("task_kind", mutation.taskKind, "taskKind")
              assign("description", mutation.description === null && !mutation.replaceDescription ? undefined : mutation.description)
              if (mutation.areaId !== undefined) assign("area_id", mutation.areaId)
              if (mutation.ensureCalendarSyncLabel) {
                const labels = JSON.parse(String(current.labels || "[]"))
                if (Array.isArray(labels) && !labels.includes("calendar-sync")) fields.labels = JSON.stringify([...labels, "calendar-sync"])
              }
              if (Object.keys(fields).length) {
                const updated = await this.updateTaskCommand(mutation.taskId, fields, { version: { updatedAt: Number(current.current_version) }, recurrenceAssignment: inheritedAssignments.get(mutation.taskId) }, tx, undefined, context)
                if (!updated.ok) throw new Error(`Task update unavailable: ${updated.errorCode}`)
              }
              if (mutation.confirmation) {
                const { rows: [written] } = await tx.execute(scopedTaskRead(this.scope, sql`SELECT ${sourceSql(taskTimestampMs("updated_at"))} AS version FROM scoped_tasks WHERE id = ${mutation.taskId}`))
                await this.saveSyncConfirmation(tx, context, mutation.confirmation, mutation.taskId, crypto.randomUUID(), Number(written!.version))
              }
              outcome.updated++
            }
            await tx.execute(`RELEASE SAVEPOINT ${savepoint}`)
          } catch (error) {
            await tx.execute(`ROLLBACK TO SAVEPOINT ${savepoint}`); await tx.execute(`RELEASE SAVEPOINT ${savepoint}`)
            if (options?.signal?.aborted || error instanceof BoardOperationError && ["stale", "continuity_locked"].includes(error.errorCode)) throw error
            outcome.errors.push({ index, message: error instanceof Error ? error.message : "Sync mutation unavailable" })
          }
        }
        await tx.commit()
        aggregate.created += outcome.created; aggregate.updated += outcome.updated; aggregate.linked += outcome.linked; aggregate.skipped += outcome.skipped
        aggregate.chunksCommitted++; aggregate.ticketNumbers.push(...outcome.ticketNumbers); aggregate.errors.push(...outcome.errors)
      } finally { tx.close() }
    }
    return aggregate
  }

}
