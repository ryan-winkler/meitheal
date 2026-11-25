/**
 * Active Scoring Framework Resolution & Formatting
 *
 * Lightweight, dependency-free pure helpers that resolve which scoring framework(s)
 * are enabled in strategy rules and format task scores/planning fields consistently
 * across Table, Timeline/Gantt, and Planning views without pulling triage UI definitions
 * into client bundles.
 *
 * @domain strategy / tasks
 */

import type { TriageFrameworkId, TriageTaskRecord } from "./scoring-triage"

export interface StrategyRuleLike {
  enabled?: boolean
  lensIds?: ReadonlyArray<string>
  lenses?: ReadonlyArray<{ lensId: string; enabled?: boolean }>
}

export interface FormattedFrameworkScore {
  framework: TriageFrameworkId
  frameworkLabel: string
  display: string
  numeric: number | null
  tone: "danger" | "warning" | "info" | "success" | "muted"
  scored: boolean
}

const KNOWN_LENS_IDS: readonly TriageFrameworkId[] = [
  "rice",
  "drice",
  "ice",
  "wsjf",
  "moscow",
  "eisenhower",
  "story-points",
]

const FRAMEWORK_SHORT_LABELS: Record<TriageFrameworkId, string> = {
  rice: "RICE",
  drice: "DRICE",
  ice: "ICE",
  wsjf: "WSJF",
  moscow: "MoSCoW",
  eisenhower: "Eisenhower",
  "story-points": "Story Points",
}

const MOSCOW_LABELS: Record<number, { label: string; tone: "danger" | "warning" | "info" | "muted" }> = {
  4: { label: "Must Have", tone: "danger" },
  3: { label: "Should Have", tone: "warning" },
  2: { label: "Could Have", tone: "info" },
  1: { label: "Won't Have", tone: "muted" },
}

const LENS_ALIASES: Record<string, TriageFrameworkId> = {
  rice: "rice",
  drice: "drice",
  ice: "ice",
  wsjf: "wsjf",
  moscow: "moscow",
  eisenhower: "eisenhower",
  "story-points": "story-points",
  story_points: "story-points",
  storypoints: "story-points",
}

function parsePayload(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

function asNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Resolve all distinct enabled scoring frameworks from strategy rules.
 * If rules are empty (fresh install before explicit customization), defaults to ["rice"].
 * If rules exist and all lenses are disabled (Simple preset), returns [].
 */
export function resolveActiveScoringFrameworks(
  rules: ReadonlyArray<StrategyRuleLike> | null | undefined,
): TriageFrameworkId[] {
  if (!rules || rules.length === 0) return ["rice"]

  const enabled = new Set<TriageFrameworkId>()
  for (const rule of rules) {
    if (rule.enabled === false) continue
    if (Array.isArray(rule.lenses)) {
      for (const lens of rule.lenses) {
        if (lens.enabled === false) continue
        const normalized = LENS_ALIASES[String(lens.lensId ?? "").trim().toLowerCase()]
        if (normalized) enabled.add(normalized)
      }
    }
    if (Array.isArray(rule.lensIds)) {
      for (const lensId of rule.lensIds) {
        const normalized = LENS_ALIASES[String(lensId ?? "").trim().toLowerCase()]
        if (normalized) enabled.add(normalized)
      }
    }
  }

  return KNOWN_LENS_IDS.filter(id => enabled.has(id))
}

/**
 * Pick the primary scoring framework to display in the Table/Gantt Score column.
 * Returns null when zero frameworks are enabled (e.g., Simple preset).
 */
export function resolvePrimaryScoringFramework(
  enabled: readonly TriageFrameworkId[],
): TriageFrameworkId | null {
  if (enabled.length === 0) return null
  for (const id of KNOWN_LENS_IDS) {
    if (enabled.includes(id)) return id
  }
  return enabled[0] ?? null
}

/**
 * Compute formatted display + numeric sort value for a task under a framework.
 */
export function formatTaskFrameworkScore(
  task: TriageTaskRecord & { rice?: number | null },
  framework: TriageFrameworkId,
): FormattedFrameworkScore {
  const frameworkLabel = FRAMEWORK_SHORT_LABELS[framework] ?? "Score"
  const fp = parsePayload(task.framework_payload)
  const unscored = (): FormattedFrameworkScore => ({
    framework,
    frameworkLabel,
    display: "—",
    numeric: null,
    tone: "muted",
    scored: false,
  })

  switch (framework) {
    case "rice": {
      const r = asNum(fp.reach)
      const i = asNum(fp.impact)
      const e = asNum(fp.effort)
      if (r !== null && i !== null && e !== null) {
        const rawC = asNum(fp.confidence) ?? 80
        const c = rawC > 0 && rawC <= 1 ? rawC * 100 : rawC
        const score = round2((Math.max(0.1, r) * Math.max(0.25, i) * (Math.max(1, c) / 100)) / Math.max(0.5, e))
        const tone = score >= 8 ? "danger" : score >= 4 ? "warning" : score >= 2 ? "info" : "success"
        return { framework, frameworkLabel, display: String(score), numeric: score, tone, scored: true }
      }
      if (typeof task.rice === "number" && Number.isFinite(task.rice)) {
        const score = round2(task.rice)
        const tone = score >= 8 ? "danger" : score >= 4 ? "warning" : score >= 2 ? "info" : "success"
        return { framework, frameworkLabel, display: String(score), numeric: score, tone, scored: true }
      }
      return unscored()
    }
    case "drice": {
      const r = asNum(fp.reach)
      const align = asNum(fp.strategic_alignment)
      if (r === null || align === null) return unscored()
      const i = asNum(fp.impact) ?? 1
      const rawC = asNum(fp.confidence) ?? 80
      const c = rawC > 0 && rawC <= 1 ? rawC * 100 : rawC
      const e = asNum(fp.effort) ?? 2
      const score = round2(((Math.max(0.1, r) * Math.max(0.25, i) * (Math.max(1, c) / 100)) / Math.max(0.5, e)) * Math.max(0.5, align))
      const tone = score >= 10 ? "danger" : score >= 5 ? "warning" : score >= 2.5 ? "info" : "success"
      return { framework, frameworkLabel, display: String(score), numeric: score, tone, scored: true }
    }
    case "ice": {
      const i = asNum(fp.ice_impact)
      const c = asNum(fp.ice_confidence)
      const e = asNum(fp.ice_ease)
      if (i === null || c === null || e === null) return unscored()
      const score = round2((Math.max(1, i) * Math.max(1, c) * Math.max(1, e)) / 10)
      const tone = score >= 50 ? "danger" : score >= 25 ? "warning" : score >= 10 ? "info" : "muted"
      return { framework, frameworkLabel, display: String(score), numeric: score, tone, scored: true }
    }
    case "wsjf": {
      const bv = asNum(fp.business_value)
      const js = asNum(fp.job_size)
      if (bv === null || js === null) return unscored()
      const tc = asNum(fp.time_criticality) ?? 5
      const rr = asNum(fp.risk_reduction) ?? 3
      const score = round2((Math.max(1, bv) + Math.max(1, tc) + Math.max(1, rr)) / Math.max(1, js))
      const tone = score >= 6 ? "danger" : score >= 3.5 ? "warning" : score >= 2 ? "info" : "success"
      return { framework, frameworkLabel, display: String(score), numeric: score, tone, scored: true }
    }
    case "moscow": {
      const tier = asNum(fp.moscow_tier)
      const meta = tier ? MOSCOW_LABELS[tier] : undefined
      if (!tier || !meta) return unscored()
      return { framework, frameworkLabel, display: meta.label, numeric: tier, tone: meta.tone, scored: true }
    }
    case "eisenhower": {
      const info = formatEisenhowerShort(task)
      if (info.rank <= 0) return unscored()
      const u = asNum(task.urgency) ?? 0
      const i = asNum(task.importance) ?? 0
      return { framework, frameworkLabel, display: info.label, numeric: u + i || info.rank, tone: info.tone, scored: true }
    }
    case "story-points": {
      const pts = readTaskStoryPoints(task)
      if (pts === null) return unscored()
      const tone = pts >= 13 ? "danger" : pts >= 8 ? "warning" : pts >= 3 ? "info" : "success"
      return { framework, frameworkLabel, display: `${pts} pts`, numeric: pts, tone, scored: true }
    }
  }
}

/**
 * Extract Story Points number from framework_payload if set (> 0).
 */
export function readTaskStoryPoints(task: { framework_payload?: Record<string, unknown> | string | null }): number | null {
  const fp = parsePayload(task.framework_payload)
  const num = asNum(fp.story_points)
  return num !== null && num > 0 ? num : null
}

/**
 * Format Eisenhower quadrant label & badge tone from urgency/importance.
 */
export function formatEisenhowerShort(task: {
  urgency?: number | null
  importance?: number | null
  eisenhower_quadrant?: string | null
}): { label: string; rank: number; tone: "danger" | "warning" | "info" | "muted" } {
  const u = typeof task.urgency === "number" ? task.urgency : 0
  const i = typeof task.importance === "number" ? task.importance : 0
  if (u > 0 || i > 0) {
    const urgent = u >= 3
    const important = i >= 3
    if (urgent && important) return { label: "Do First", rank: 4, tone: "danger" }
    if (!urgent && important) return { label: "Schedule", rank: 3, tone: "info" }
    if (urgent && !important) return { label: "Delegate", rank: 2, tone: "warning" }
    return { label: "Not Now", rank: 1, tone: "muted" }
  }
  const q = String(task.eisenhower_quadrant ?? "").toLowerCase()
  if (q === "do_first" || q === "do" || q === "q1") return { label: "Do First", rank: 4, tone: "danger" }
  if (q === "schedule" || q === "q2") return { label: "Schedule", rank: 3, tone: "info" }
  if (q === "delegate" || q === "q3") return { label: "Delegate", rank: 2, tone: "warning" }
  if (q === "eliminate" || q === "not_now" || q === "q4") return { label: "Not Now", rank: 1, tone: "muted" }
  return { label: "—", rank: 0, tone: "muted" }
}

/**
 * Format effort minutes concisely (e.g. "45m", "1h 30m", "2h").
 */
export function formatEffortMinutes(minutes: number | null | undefined): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return "—"
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h > 0 && m > 0) return `${h}h ${m}m`
  if (h > 0) return `${h}h`
  return `${m}m`
}
