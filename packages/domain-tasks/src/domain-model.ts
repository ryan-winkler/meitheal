/**
 * Domain Model — Human-Agent DDD Core
 *
 * Defines the ubiquitous language for the Meitheal domain:
 * - Area → Goal → Project → Task → Routine (navigation hierarchy)
 * - TaskKind: behavioral classification (not hierarchy role)
 * - HandoffState: bot orchestration state machine
 * - EntityType: discriminator for domain events
 *
 * @domain tasks
 * @bounded-context domain-tasks
 * @see docs/decisions/ADR-007-hierarchy-model.md
 */

// --- Task Kind (behavioral classification, NOT hierarchy role) ---

/** How a task behaves — replaces the old TaskType hierarchy labels */
export type TaskKind =
  | "standard_action"
  | "shopping_item"
  | "checklist"
  | "routine_instance"
  | "quick_capture"
  | "calendar_event"

export const VALID_TASK_KINDS: readonly TaskKind[] = [
  "standard_action",
  "shopping_item",
  "checklist",
  "routine_instance",
  "quick_capture",
  "calendar_event",
] as const

export function isValidTaskKind(value: string): value is TaskKind {
  return (VALID_TASK_KINDS as readonly string[]).includes(value)
}

// --- Handoff State Machine (bot orchestration) ---

/**
 * Bot handoff lifecycle:
 *   idle → claimed → proposed → accepted → idle
 *   idle → claimed → proposed → rejected → idle
 *   idle → claimed → proposed → failed → idle (bot error)
 *   idle → claimed → proposed → timeout → idle (stale proposal)
 *   idle → claimed → proposed → human_override → idle (user took over)
 *   idle → claimed → idle (release without proposing)
 */
export type HandoffState =
  | "idle"
  | "claimed"
  | "proposed"
  | "accepted"
  | "rejected"
  | "failed"
  | "timeout"
  | "human_override"

export const VALID_HANDOFF_STATES: readonly HandoffState[] = [
  "idle",
  "claimed",
  "proposed",
  "accepted",
  "rejected",
  "failed",
  "timeout",
  "human_override",
] as const

/** Valid state transitions for the handoff state machine */
const VALID_TRANSITIONS: ReadonlyMap<HandoffState, readonly HandoffState[]> = new Map([
  ["idle", ["claimed"]],
  ["claimed", ["proposed", "idle", "failed"]],
  ["proposed", ["accepted", "rejected", "idle", "failed", "timeout", "human_override"]],
  ["accepted", ["idle"]],
  ["rejected", ["idle", "claimed"]],
  ["failed", ["idle", "claimed"]],
  ["timeout", ["idle", "claimed"]],
  ["human_override", ["idle"]],
])

export function isValidHandoffTransition(from: HandoffState, to: HandoffState): boolean {
  const allowed = VALID_TRANSITIONS.get(from)
  return allowed !== undefined && allowed.includes(to)
}

export function isValidHandoffState(value: string): value is HandoffState {
  return (VALID_HANDOFF_STATES as readonly string[]).includes(value)
}

// --- Entity Type (domain event discriminator) ---

/** Which aggregate root a domain event belongs to */
export type EntityType = "task" | "goal" | "project"

export const VALID_ENTITY_TYPES: readonly EntityType[] = [
  "task",
  "goal",
  "project",
] as const

// --- Goal (aggregate root) ---

export type GoalStatus = "active" | "completed" | "archived"

export const VALID_GOAL_STATUSES: readonly GoalStatus[] = [
  "active",
  "completed",
  "archived",
] as const

/** Goal metric type for progress tracking (PRA-27) */
export type MetricType = "count" | "percentage" | "currency" | "boolean"

export const VALID_METRIC_TYPES: readonly MetricType[] = [
  "count",
  "percentage",
  "currency",
  "boolean",
] as const

export interface Goal {
  id: string
  areaId: string | null
  title: string
  description: string | null
  status: GoalStatus
  targetDate: string | null
  /** Type of metric used to measure goal progress (PRA-27) */
  metricType: MetricType | null
  /** Target value for the metric (e.g., 100 for "100 blog posts") */
  metricTarget: number | null
  /** Current progress toward the target */
  metricCurrent: number
  createdAt: number
  updatedAt: number
}

// --- Project (aggregate root) ---

export type ProjectStatus = "active" | "completed" | "paused" | "archived"

export const VALID_PROJECT_STATUSES: readonly ProjectStatus[] = [
  "active",
  "completed",
  "paused",
  "archived",
] as const

export interface Project {
  id: string
  goalId: string | null
  title: string
  description: string | null
  status: ProjectStatus
  icon: string
  color: string
  position: number
  /** Whether this is the protected default project ("Every Day") */
  isDefault: boolean
  createdAt: number
  updatedAt: number
}

// --- Area (classification, not aggregate root) ---

export interface Area {
  id: string
  name: string
  icon: string
  color: string
  position: number
  createdAt: number
  updatedAt: number
}

// --- Eisenhower Matrix (urgency × importance strategic lens) ---

/**
 * Eisenhower quadrant — derived from urgency + importance scores.
 * - do-first:  urgent + important (Q1)
 * - schedule:  important, not urgent (Q2)
 * - delegate:  urgent, not important (Q3)
 * - not-now:   neither urgent nor important (Q4)
 *
 * Note: "not-now" replaces the traditional "eliminate" label — gentler framing
 * for ADHD users (see persona audit: Wall of Awful).
 */
export type EisenhowerQuadrant = "do-first" | "schedule" | "delegate" | "not-now"

export const VALID_EISENHOWER_QUADRANTS: readonly EisenhowerQuadrant[] = [
  "do-first",
  "schedule",
  "delegate",
  "not-now",
] as const

/** Urgency/Importance threshold — scores at or above this are "high" */
const EISENHOWER_THRESHOLD = 3

/**
 * Derive Eisenhower quadrant from urgency + importance scores.
 * Both are 0-5 integers. 0 = unclassified (treated as low).
 * Threshold: ≥3 = high, <3 = low.
 */
export function deriveEisenhowerQuadrant(urgency: number, importance: number): EisenhowerQuadrant {
  const urgent = urgency >= EISENHOWER_THRESHOLD
  const important = importance >= EISENHOWER_THRESHOLD
  if (urgent && important) return "do-first"
  if (important) return "schedule"
  if (urgent) return "delegate"
  return "not-now"
}

/** Validate urgency value (0-5 integer, 0 = unclassified) */
export function isValidUrgency(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 5
}

/** Validate importance value (0-5 integer, 0 = unclassified) */
export function isValidImportance(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 5
}

// --- Extended Planning (Phase 07): effort, delay impact, interest ---

/** Effort type — determines scheduling strategy */
export type EffortType = "deep" | "shallow" | "admin"

export const VALID_EFFORT_TYPES: readonly EffortType[] = ["deep", "shallow", "admin"] as const

/** Delay impact — cost of not doing this task */
export type DelayImpact = "none" | "inconvenient" | "costly" | "critical"

export const VALID_DELAY_IMPACTS: readonly DelayImpact[] = [
  "none", "inconvenient", "costly", "critical",
] as const

/** Interest-based tag — ADHD executive function triggers */
export type InterestTag = "engaging" | "dreaded" | "neutral" | "quick-win"

export const VALID_INTEREST_TAGS: readonly InterestTag[] = [
  "engaging", "dreaded", "neutral", "quick-win",
] as const

/** Validate effort_minutes (null = unestimated, positive integer) */
export function isValidEffortMinutes(value: number | null): boolean {
  if (value === null) return true
  return Number.isInteger(value) && value > 0 && value <= 480
}

/** Validate effort type */
export function isValidEffortType(value: string | null): boolean {
  if (value === null) return true
  return VALID_EFFORT_TYPES.includes(value as EffortType)
}

/** Effort badge — icon, label, CSS color class based on minutes */
export function effortBadge(minutes: number | null): { icon: string, label: string, cssClass: string } | null {
  if (minutes === null) return null
  if (minutes <= 5) return { icon: "⚡", label: `${minutes}m`, cssClass: "effort--quick" }
  if (minutes <= 15) return { icon: "⚡", label: `${minutes}m`, cssClass: "effort--short" }
  if (minutes <= 60) return { icon: "⏱️", label: `${minutes}m`, cssClass: "effort--medium" }
  return { icon: "🏋️", label: `${Math.round(minutes / 60)}h`, cssClass: "effort--long" }
}

/** Format total minutes for display: "~2h 30m" or "~45m" */
export function formatEffort(totalMinutes: number): string {
  if (totalMinutes <= 0) return ""
  const hours = Math.floor(totalMinutes / 60)
  const mins = totalMinutes % 60
  if (hours === 0) return `~${mins}m`
  if (mins === 0) return `~${hours}h`
  return `~${hours}h ${mins}m`
}

// --- Routine Template (Phase 15: hierarchy overhaul) ---

/** Cadence for routine templates — how often the routine repeats */
export type RoutineCadence = "daily" | "weekdays" | "weekends" | "weekly" | "monthly" | "custom"

export const VALID_ROUTINE_CADENCES: readonly RoutineCadence[] = [
  "daily", "weekdays", "weekends", "weekly", "monthly", "custom",
] as const

export function isValidRoutineCadence(value: string): value is RoutineCadence {
  return (VALID_ROUTINE_CADENCES as readonly string[]).includes(value)
}

/**
 * RoutineTemplate — defines a repeating pattern that auto-spawns task instances.
 * Separate from task_templates (which are blueprints for any task).
 * Routine templates own the streak and scheduling logic.
 */
export interface RoutineTemplate {
  id: string
  title: string
  description: string | null
  cadence: RoutineCadence
  /** JSON config for custom schedules (e.g. specific days, RRULE) */
  scheduleConfig: string
  /** When instances were last auto-spawned */
  lastSpawnedAt: number | null
  /** Current consecutive streak count */
  streakCurrent: number
  /** Best-ever streak count */
  streakBest: number
  /** Streak freezes used (forgivable misses) */
  streakFreezesUsed: number
  /** Max allowed streak freezes */
  streakFreezeLimit: number
  /** Whether this template is active (spawns instances) */
  isActive: boolean
  /** Project this routine belongs to (default: "Every Day") */
  projectId: string | null
  /** Goal this routine contributes to (optional) */
  goalId: string | null
  createdAt: number
  updatedAt: number
}

// --- Owner (human vs bot attribution) ---

export type Owner = "human" | `bot:${string}`

export function isBot(owner: string): boolean {
  return owner.startsWith("bot:")
}

export function getBotName(owner: Owner): string | null {
  if (!owner.startsWith("bot:")) return null
  return owner.slice(4)
}
