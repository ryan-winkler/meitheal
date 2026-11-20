export { TASK_STATUS, TASK_STATUS_ALIASES, type CanonicalTaskStatus } from "./status-values.mjs"

export type CalendarSyncState =
  | "not_synced"
  | "pending"
  | "synced"
  | "failed"
  | "skipped"
  | "manual_confirmed"

export interface IntegrationOutcome {
  status: "ok" | "synced" | "skipped" | "failed" | "queued" | "pending" | "degraded"
  integration?: string
  message?: string
  errorCode?: string
  retryAfterSeconds?: number
  providerEventId?: string | null
  [key: string]: unknown
}

export const VALID_TASK_TYPES = ["epic", "story", "task", "bug", "documentation"] as const
export type TaskType = (typeof VALID_TASK_TYPES)[number]

export const VALID_TASK_KINDS = [
  "standard_action",
  "shopping_item",
  "checklist",
  "routine_instance",
  "calendar_event",
  "quick_capture",
] as const
export type TaskKind = (typeof VALID_TASK_KINDS)[number]

export type EffortType = "deep" | "shallow" | "admin"
export type EisenhowerQuadrant = "do" | "schedule" | "delegate" | "eliminate" | "unclassified"

export const HANDOFF_CLAIM_TTL_MS = 15 * 60 * 1000

const TASK_KIND_SET: ReadonlySet<string> = new Set(VALID_TASK_KINDS)
const EFFORT_TYPE_SET: ReadonlySet<string> = new Set(["deep", "shallow", "admin"])

export function isValidTaskKind(value: unknown): value is TaskKind {
  return typeof value === "string" && TASK_KIND_SET.has(value)
}

export function isValidUrgency(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 5
}

export function isValidImportance(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 5
}

export function isValidEffortMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 480
}

export function isValidEffortType(value: unknown): value is EffortType {
  return typeof value === "string" && EFFORT_TYPE_SET.has(value)
}

export function isValidGoalProgress(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
}

export function goalProgress(current: number, target: number | null): number {
  if (!Number.isFinite(current)) return 0
  if (target === null || !Number.isFinite(target) || target <= 0) {
    return Math.min(100, Math.max(0, Math.round(current)))
  }
  return Math.min(100, Math.max(0, Math.round((current / target) * 100)))
}

export function deriveEisenhowerQuadrant(urgency: number, importance: number): EisenhowerQuadrant {
  const u = Number.isFinite(urgency) ? urgency : 0
  const i = Number.isFinite(importance) ? importance : 0
  if (u <= 0 && i <= 0) return "unclassified"
  const urgent = u >= 3
  const important = i >= 3
  if (urgent && important) return "do"
  if (!urgent && important) return "schedule"
  if (urgent && !important) return "delegate"
  return "eliminate"
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

export async function computeProposalHash(proposal: unknown): Promise<string> {
  const payload = JSON.stringify(canonicalize(proposal))
  const encoded = new TextEncoder().encode(payload)
  const digest = await crypto.subtle.digest("SHA-256", encoded)
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")
}
