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

export const VALID_TASK_KINDS: readonly TaskKind[] = [
  "standard_action",
  "shopping_item",
  "checklist",
  "routine_instance",
  "quick_capture",
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

// --- Owner (human vs bot attribution) ---

export type Owner = "human" | `bot:${string}`

export function isBot(owner: string): boolean {
  return owner.startsWith("bot:")
}

export function getBotName(owner: Owner): string | null {
  if (!owner.startsWith("bot:")) return null
  return owner.slice(4)
}
