/**
 * Status configuration — single source of truth.
 * Domain: Task Management
 *
 * Replaces per-view hardcoded status maps with canonical definitions.
 * The system defines four built-in statuses. Known aliases are normalized
 * before persistence. Custom statuses retain their names.
 *
 * Usage:
 *   import { CANONICAL_STATUSES, normalizeStatus, STATUS_CONFIG } from '@lib/status-config';
 */

import { TASK_STATUS as STATUS, TASK_STATUS_ALIASES } from "@meitheal/domain-tasks/status-values"

export interface StatusDef {
  /** Canonical status value stored in DB */
  canonical: string;
  /** Human-readable label (English fallback) */
  label: string;
  /** i18n translation key */
  i18nKey: string;
  /** Emoji icon */
  icon: string;
  /** Default kanban lane key this status maps to */
  defaultLane: string;
  /** Whether tasks in this status are considered "done" */
  isDone: boolean;
  /** Whether tasks in this status are considered "active" (in-progress) */
  isActive: boolean;
  /** Aliases that should normalize to this canonical status */
  aliases: readonly string[];
}

/**
 * Canonical status definitions.
 * Known aliases map to these built-in statuses.
 */
export const STATUS_CONFIG: readonly StatusDef[] = [
  {
    canonical: STATUS.BACKLOG,
    label: "Backlog",
    i18nKey: "task_status.backlog",
    icon: "📥",
    defaultLane: "backlog",
    isDone: false,
    isActive: false,
    aliases: TASK_STATUS_ALIASES[STATUS.BACKLOG],
  },
  {
    canonical: STATUS.PENDING,
    label: "Todo",
    i18nKey: "task_status.pending",
    icon: "📋",
    defaultLane: "pending",
    isDone: false,
    isActive: false,
    aliases: TASK_STATUS_ALIASES[STATUS.PENDING],
  },
  {
    canonical: STATUS.ACTIVE,
    label: "In Progress",
    i18nKey: "task_status.active",
    icon: "⚡",
    defaultLane: "active",
    isDone: false,
    isActive: true,
    aliases: TASK_STATUS_ALIASES[STATUS.ACTIVE],
  },
  {
    canonical: STATUS.COMPLETE,
    label: "Done",
    i18nKey: "task_status.complete",
    icon: "✅",
    defaultLane: "complete",
    isDone: true,
    isActive: false,
    aliases: TASK_STATUS_ALIASES[STATUS.COMPLETE],
  },
] as const;

/** All canonical status values */
export const CANONICAL_STATUSES = STATUS_CONFIG.map((s) => s.canonical);

/** Full alias → canonical lookup table */
const ALIAS_MAP: Record<string, string> = Object.create(null);
for (const s of STATUS_CONFIG) {
  ALIAS_MAP[s.canonical] = s.canonical;
  for (const alias of s.aliases) {
    ALIAS_MAP[alias] = s.canonical;
  }
}

/**
 * Normalize a status value to its canonical form.
 * Returns the canonical status, or the original value if not recognized.
 *
 * @example
 *   normalizeStatus("todo")        // → "pending"
 *   normalizeStatus("in_progress") // → "active"
 *   normalizeStatus("done")        // → "complete"
 *   normalizeStatus("active")      // → "active" (already canonical)
 */
export function normalizeStatus(status: string): string {
  return ALIAS_MAP[status.toLowerCase()] ?? status;
}

/**
 * Check if a status string represents a "done" state.
 * Handles both canonical and alias values.
 */
export function isDoneStatus(status: string): boolean {
  const canonical = normalizeStatus(status);
  return STATUS_CONFIG.find((s) => s.canonical === canonical)?.isDone ?? false;
}

/** Whether a status represents a closed task omitted from default open-task listings. */
export function isClosedStatus(status: string): boolean {
  const canonical = normalizeStatus(status);
  return isDoneStatus(canonical) || canonical === "archived" || canonical === "cancelled" || canonical === "canceled";
}

/**
 * Check if a status string represents an "active" state.
 * Handles both canonical and alias values.
 */
export function isActiveStatus(status: string): boolean {
  const canonical = normalizeStatus(status);
  return STATUS_CONFIG.find((s) => s.canonical === canonical)?.isActive ?? false;
}

/**
 * Get status definition by canonical or alias value.
 * Returns undefined if not found.
 */
export function getStatusDef(status: string): StatusDef | undefined {
  const canonical = normalizeStatus(status);
  return STATUS_CONFIG.find((s) => s.canonical === canonical);
}

/** Lookup maps for SSR templates */
export const STATUS_LABELS: Record<string, string> = Object.fromEntries(
  STATUS_CONFIG.flatMap((s) => [
    [s.canonical, s.label],
    ...s.aliases.map((a) => [a, s.label]),
  ]),
);

export const STATUS_ICONS: Record<string, string> = Object.fromEntries(
  STATUS_CONFIG.flatMap((s) => [
    [s.canonical, s.icon],
    ...s.aliases.map((a) => [a, s.icon]),
  ]),
);

/**
 * Typed status constants for use in SQL queries and comparisons.
 * Use these instead of raw string literals to ensure consistency.
 *
 * @example
 *   import { STATUS } from '@lib/status-config';
 *   `WHERE status = '${STATUS.COMPLETE}'`
 *   `WHERE status NOT IN ('${STATUS.COMPLETE}')`
 */
export { STATUS }

export type StatusValue = (typeof STATUS)[keyof typeof STATUS];

/** Set of status values considered "done" — use for filtering completed tasks */
export const DONE_STATUSES: ReadonlySet<string> = new Set(
  STATUS_CONFIG.filter((s) => s.isDone).map((s) => s.canonical),
);

/** Set of status values considered "open" (not done) — use for active task counts */
export const OPEN_STATUSES: ReadonlySet<string> = new Set(
  STATUS_CONFIG.filter((s) => !s.isDone).map((s) => s.canonical),
);

/** Default status for new tasks */
export const DEFAULT_STATUS: StatusValue = STATUS.PENDING;

/** Default status for calendar-synced tasks */
export const CALENDAR_DEFAULT_STATUS: StatusValue = STATUS.PENDING;
