/**
 * Multi-Framework Scoring Triage Domain Logic
 *
 * Pure, decoupled logic for filtering, scoring, previewing, and serializing
 * triage updates across Eisenhower, RICE, DRICE, ICE, WSJF, MoSCoW, and Story Points.
 *
 * @domain strategy / planning
 */

import { formatRiceFormulaBreakdown, readRiceAssessment, riceLensScore } from "./rice-lens"
import { normalizeStatus, OPEN_STATUSES } from "./status-config"

export type TriageFrameworkId =
  | "eisenhower"
  | "rice"
  | "drice"
  | "ice"
  | "wsjf"
  | "moscow"
  | "story-points"

export interface TriageFieldChoice {
  value: number
  label: string
  hint?: string
}

export interface TriageFieldDef {
  key: string
  label: string
  hint: string
  control: "range-number" | "selectgroup"
  min: number
  max: number
  step: number
  defaultValue: number
  suffix?: string
  minLabel?: string
  maxLabel?: string
  choices?: TriageFieldChoice[]
}

export interface TriageFrameworkDef {
  id: TriageFrameworkId
  label: string
  shortLabel: string
  description: string
  fields: TriageFieldDef[]
}

export interface TriageTaskRecord {
  id: string
  title: string
  task_version?: number | string | null
  updated_at?: number | string | null
  ticket_key?: string | null
  status?: string | null
  priority?: number | null
  task_type?: string | null
  parent_id?: string | null
  epic_id?: string | null
  project_id?: string | null
  area_id?: string | null
  due_date?: string | null
  labels?: string[] | string | null
  urgency?: number | null
  importance?: number | null
  effort_minutes?: number | null
  effort_type?: string | null
  framework_payload?: Record<string, unknown> | string | null
  deferred_at?: number | string | null
}

export interface TriageFilterOptions {
  framework: TriageFrameworkId
  unscoredOnly: boolean
  epicId?: string
  projectId?: string
  areaId?: string
  sprint?: string
  nowMs?: number
}

export interface TriagePreviewResult {
  score: number | null
  badgeText: string
  detailText: string
  tone: "danger" | "warning" | "info" | "success" | "muted"
  canSave: boolean
}

export interface TriageExtendedDetails {
  storyPoints?: number | null
  effortMinutes?: number | null
  effortType?: string
  delayImpact?: string
  interestTag?: string
}

export const STORY_POINT_CHOICES: TriageFieldChoice[] = [
  { value: 1, label: "1", hint: "Trivial" },
  { value: 2, label: "2", hint: "Small" },
  { value: 3, label: "3", hint: "Moderate" },
  { value: 5, label: "5", hint: "Medium" },
  { value: 8, label: "8", hint: "Large" },
  { value: 13, label: "13", hint: "XL" },
  { value: 21, label: "21", hint: "Split" },
]

export const MOSCOW_CHOICES: TriageFieldChoice[] = [
  { value: 4, label: "Must Have", hint: "Critical" },
  { value: 3, label: "Should Have", hint: "High value" },
  { value: 2, label: "Could Have", hint: "Nice to have" },
  { value: 1, label: "Won't Have", hint: "Deferred" },
]

export const TRIAGE_FRAMEWORKS: readonly TriageFrameworkDef[] = [
  {
    id: "eisenhower",
    label: "Eisenhower Matrix",
    shortLabel: "Eisenhower",
    description: "Classify by Urgency × Importance into Do First, Schedule, Delegate, or Not Now.",
    fields: [
      { key: "urgency", label: "Urgency", hint: "How time-sensitive is this task?", control: "range-number", min: 0, max: 5, step: 1, defaultValue: 0, minLabel: "Not urgent", maxLabel: "Critical" },
      { key: "importance", label: "Importance", hint: "How much does this matter to your goals?", control: "range-number", min: 0, max: 5, step: 1, defaultValue: 0, minLabel: "Low impact", maxLabel: "Core goal" },
    ],
  },
  {
    id: "rice",
    label: "RICE Scoring",
    shortLabel: "RICE",
    description: "Score Reach × Impact × Confidence ÷ Effort to rank highest-leverage work.",
    fields: [
      { key: "reach", label: "Reach", hint: "How many people or cycles benefit (1–10)?", control: "range-number", min: 1, max: 10, step: 1, defaultValue: 5, minLabel: "Low (1)", maxLabel: "Wide (10)" },
      { key: "impact", label: "Impact", hint: "0.25 Minimal · 0.5 Low · 1 Medium · 2 High · 3 Massive", control: "range-number", min: 0.25, max: 3, step: 0.25, defaultValue: 1, minLabel: "0.25", maxLabel: "3.0" },
      { key: "confidence", label: "Confidence", hint: "Confidence percentage in these estimates (0–100%)", control: "range-number", min: 0, max: 100, step: 1, defaultValue: 80, suffix: "%", minLabel: "0%", maxLabel: "100%" },
      { key: "effort", label: "Effort", hint: "Relative effort units (0.5–10)", control: "range-number", min: 0.5, max: 10, step: 0.5, defaultValue: 2, minLabel: "0.5", maxLabel: "10" },
    ],
  },
  {
    id: "drice",
    label: "DRICE (Strategic RICE)",
    shortLabel: "DRICE",
    description: "RICE weighted by Strategic Alignment for roadmap and epic prioritization.",
    fields: [
      { key: "reach", label: "Reach", hint: "Scope of impact (1–10)", control: "range-number", min: 1, max: 10, step: 1, defaultValue: 5, minLabel: "1", maxLabel: "10" },
      { key: "impact", label: "Impact", hint: "Outcome lift (0.25–3)", control: "range-number", min: 0.25, max: 3, step: 0.25, defaultValue: 1, minLabel: "0.25", maxLabel: "3.0" },
      { key: "confidence", label: "Confidence", hint: "Estimate certainty (50–100%)", control: "range-number", min: 50, max: 100, step: 5, defaultValue: 80, suffix: "%", minLabel: "50%", maxLabel: "100%" },
      { key: "effort", label: "Effort", hint: "Relative effort units (0.5–10)", control: "range-number", min: 0.5, max: 10, step: 0.5, defaultValue: 2, minLabel: "0.5", maxLabel: "10" },
      { key: "strategic_alignment", label: "Strategic Alignment", hint: "Multiplier for alignment to key pillars (0.5–2.0)", control: "range-number", min: 0.5, max: 2, step: 0.25, defaultValue: 1, suffix: "×", minLabel: "0.5×", maxLabel: "2.0×" },
    ],
  },
  {
    id: "ice",
    label: "ICE Scoring",
    shortLabel: "ICE",
    description: "Fast prioritization using Impact × Confidence × Ease (1–10 each).",
    fields: [
      { key: "ice_impact", label: "Impact", hint: "How much needle movement (1–10)?", control: "range-number", min: 1, max: 10, step: 1, defaultValue: 5, minLabel: "1", maxLabel: "10" },
      { key: "ice_confidence", label: "Confidence", hint: "How sure are you (1–10)?", control: "range-number", min: 1, max: 10, step: 1, defaultValue: 5, minLabel: "1", maxLabel: "10" },
      { key: "ice_ease", label: "Ease", hint: "How easy is implementation (1–10)?", control: "range-number", min: 1, max: 10, step: 1, defaultValue: 5, minLabel: "Hard (1)", maxLabel: "Easy (10)" },
    ],
  },
  {
    id: "wsjf",
    label: "WSJF (Cost of Delay)",
    shortLabel: "WSJF",
    description: "(Business Value + Time Criticality + Risk Reduction) ÷ Job Size.",
    fields: [
      { key: "business_value", label: "Business Value", hint: "Relative value to household or project (1–10)", control: "range-number", min: 1, max: 10, step: 1, defaultValue: 5, minLabel: "1", maxLabel: "10" },
      { key: "time_criticality", label: "Time Criticality", hint: "Does value decay if delayed (1–10)?", control: "range-number", min: 1, max: 10, step: 1, defaultValue: 5, minLabel: "1", maxLabel: "10" },
      { key: "risk_reduction", label: "Risk Reduction / Enablement", hint: "Unblocks future work or lowers risk (1–10)", control: "range-number", min: 1, max: 10, step: 1, defaultValue: 3, minLabel: "1", maxLabel: "10" },
      { key: "job_size", label: "Job Size", hint: "Relative implementation size (1–10)", control: "range-number", min: 1, max: 10, step: 1, defaultValue: 3, minLabel: "Small (1)", maxLabel: "Huge (10)" },
    ],
  },
  {
    id: "moscow",
    label: "MoSCoW Prioritization",
    shortLabel: "MoSCoW",
    description: "Bucket scope into Must Have, Should Have, Could Have, or Won't Have.",
    fields: [
      { key: "moscow_tier", label: "Priority Bucket", hint: "Choose the commitment tier for this cycle", control: "selectgroup", min: 1, max: 4, step: 1, defaultValue: 0, choices: MOSCOW_CHOICES },
    ],
  },
  {
    id: "story-points",
    label: "Story Points (Fibonacci)",
    shortLabel: "Story Points",
    description: "Size relative effort and complexity on the Fibonacci scale for sprint planning.",
    fields: [
      { key: "story_points", label: "Story Points", hint: "Pick relative complexity (1 = trivial, 21 = consider splitting)", control: "selectgroup", min: 1, max: 21, step: 1, defaultValue: 0, choices: STORY_POINT_CHOICES },
    ],
  },
] as const

export function getTriageFrameworkDef(id: string | null | undefined): TriageFrameworkDef {
  return TRIAGE_FRAMEWORKS.find(fw => fw.id === id) ?? TRIAGE_FRAMEWORKS[0]
}

export function parseTaskFrameworkPayload(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...(parsed as Record<string, unknown>) }
        : {}
    } catch {
      return {}
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>) }
  }
  return {}
}

export function parseTaskLabels(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map(v => String(v).trim()).filter(Boolean)
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.map(v => String(v).trim()).filter(Boolean)
    } catch {
      return raw.split(",").map(s => s.trim()).filter(Boolean)
    }
  }
  return []
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function isTaskScoredForFramework(task: TriageTaskRecord, framework: TriageFrameworkId): boolean {
  const fp = parseTaskFrameworkPayload(task.framework_payload)
  switch (framework) {
    case "eisenhower":
      return (asFiniteNumber(task.urgency) ?? 0) > 0 || (asFiniteNumber(task.importance) ?? 0) > 0
    case "rice":
      return readRiceAssessment(fp).status === "scored"
    case "drice":
      return asFiniteNumber(fp.reach) !== null && asFiniteNumber(fp.strategic_alignment) !== null
    case "ice":
      return asFiniteNumber(fp.ice_impact) !== null && asFiniteNumber(fp.ice_confidence) !== null && asFiniteNumber(fp.ice_ease) !== null
    case "wsjf":
      return asFiniteNumber(fp.business_value) !== null && asFiniteNumber(fp.job_size) !== null
    case "moscow":
      return (asFiniteNumber(fp.moscow_tier) ?? 0) > 0
    case "story-points":
      return (asFiniteNumber(fp.story_points) ?? 0) > 0
  }
}

export function extractInitialTriageValues(task: TriageTaskRecord, framework: TriageFrameworkId): Record<string, number> {
  const def = getTriageFrameworkDef(framework)
  const fp = parseTaskFrameworkPayload(task.framework_payload)
  if (framework === "rice") {
    const assessment = readRiceAssessment(fp)
    if (assessment.status !== "unscored") {
      const { reach, impact, confidence, effort } = assessment.inputs
      return { reach, impact, effort, confidence: assessment.status === "legacy_ambiguous" ? assessment.suggestedPercent : confidence }
    }
  }
  const values: Record<string, number> = {}
  for (const field of def.fields) {
    if (framework === "eisenhower" && field.key === "urgency") {
      values[field.key] = asFiniteNumber(task.urgency) ?? field.defaultValue
      continue
    }
    if (framework === "eisenhower" && field.key === "importance") {
      values[field.key] = asFiniteNumber(task.importance) ?? field.defaultValue
      continue
    }
    const existing = asFiniteNumber(fp[field.key])
    if (existing !== null) {
      if (field.key === "confidence" && existing > 0 && existing <= 1) {
        values[field.key] = Math.round(existing * 100)
      } else {
        values[field.key] = existing
      }
    } else {
      values[field.key] = field.defaultValue
    }
  }
  return values
}

export function computeTriagePreview(
  framework: TriageFrameworkId,
  values: Record<string, number>,
): TriagePreviewResult {
  const round2 = (n: number) => Math.round(n * 100) / 100
  switch (framework) {
    case "eisenhower": {
      const u = values.urgency ?? 0
      const i = values.importance ?? 0
      if (u <= 0 && i <= 0) {
        return { score: null, badgeText: "Unclassified", detailText: "Set urgency or importance above 0 to classify", tone: "muted", canSave: false }
      }
      const urgent = u >= 3
      const important = i >= 3
      if (urgent && important) return { score: u + i, badgeText: "Do First", detailText: "Urgent & Important — focus immediately", tone: "danger", canSave: true }
      if (!urgent && important) return { score: u + i, badgeText: "Schedule", detailText: "Important, Not Urgent — plan deep work", tone: "info", canSave: true }
      if (urgent && !important) return { score: u + i, badgeText: "Delegate", detailText: "Urgent, Low Importance — assign or batch", tone: "warning", canSave: true }
      return { score: u + i, badgeText: "Not Now", detailText: "Low Urgency & Importance — defer or drop", tone: "muted", canSave: true }
    }
    case "rice": {
      const inputs = { reach: values.reach ?? 5, impact: values.impact ?? 1, confidence: values.confidence ?? 80, effort: values.effort ?? 2 }
      const score = riceLensScore(inputs)
      if (score === null) return { score, badgeText: "Unscored", detailText: "Enter valid RICE inputs.", tone: "muted", canSave: false }
      const tone = score >= 8 ? "danger" : score >= 4 ? "warning" : score >= 2 ? "info" : "success"
      return { score, badgeText: `RICE ${score}`, detailText: formatRiceFormulaBreakdown(inputs), tone, canSave: true }
    }
    case "drice": {
      const reach = Math.max(0.1, values.reach ?? 5)
      const impact = Math.max(0.25, values.impact ?? 1)
      const confidence = Math.max(1, values.confidence ?? 80)
      const effort = Math.max(0.5, values.effort ?? 2)
      const align = Math.max(0.5, values.strategic_alignment ?? 1)
      const score = round2(((reach * impact * (confidence / 100)) / effort) * align)
      const tone = score >= 10 ? "danger" : score >= 5 ? "warning" : score >= 2.5 ? "info" : "success"
      return { score, badgeText: `DRICE ${score}`, detailText: `RICE × ${align}× strategic alignment`, tone, canSave: true }
    }
    case "ice": {
      const impact = Math.max(1, values.ice_impact ?? 5)
      const confidence = Math.max(1, values.ice_confidence ?? 5)
      const ease = Math.max(1, values.ice_ease ?? 5)
      const score = round2((impact * confidence * ease) / 10)
      const tone = score >= 50 ? "danger" : score >= 25 ? "warning" : score >= 10 ? "info" : "muted"
      return { score, badgeText: `ICE ${score}`, detailText: `(${impact} × ${confidence} × ${ease}) ÷ 10`, tone, canSave: true }
    }
    case "wsjf": {
      const bv = Math.max(1, values.business_value ?? 5)
      const tc = Math.max(1, values.time_criticality ?? 5)
      const rr = Math.max(1, values.risk_reduction ?? 3)
      const js = Math.max(1, values.job_size ?? 3)
      const score = round2((bv + tc + rr) / js)
      const tone = score >= 6 ? "danger" : score >= 3.5 ? "warning" : score >= 2 ? "info" : "success"
      return { score, badgeText: `WSJF ${score}`, detailText: `Cost of Delay ${bv + tc + rr} ÷ Job Size ${js}`, tone, canSave: true }
    }
    case "moscow": {
      const tier = values.moscow_tier ?? 0
      const choice = MOSCOW_CHOICES.find(c => c.value === tier)
      if (!choice) {
        return { score: null, badgeText: "Select bucket", detailText: "Pick Must, Should, Could, or Won't Have", tone: "muted", canSave: false }
      }
      const tone = tier === 4 ? "danger" : tier === 3 ? "warning" : tier === 2 ? "info" : "muted"
      return { score: tier, badgeText: choice.label, detailText: choice.hint ?? "", tone, canSave: true }
    }
    case "story-points": {
      const pts = values.story_points ?? 0
      if (pts <= 0) {
        return { score: null, badgeText: "Select points", detailText: "Pick a Fibonacci estimate (1–21)", tone: "muted", canSave: false }
      }
      const choice = STORY_POINT_CHOICES.find(c => c.value === pts)
      const tone = pts >= 13 ? "danger" : pts >= 8 ? "warning" : pts >= 3 ? "info" : "success"
      return {
        score: pts,
        badgeText: `${pts} pt${pts === 1 ? "" : "s"}`,
        detailText: choice?.hint ? `${choice.hint} complexity` : "Fibonacci estimate",
        tone,
        canSave: true,
      }
    }
  }
}

export function extractSprintLabels(tasks: readonly TriageTaskRecord[]): string[] {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    for (const label of parseTaskLabels(task.labels)) {
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
  }
  return Array.from(counts.keys()).sort((a, b) => {
    const aSprint = /(sprint|cycle|iter|milestone|q[1-4]|week)/i.test(a) ? 0 : 1
    const bSprint = /(sprint|cycle|iter|milestone|q[1-4]|week)/i.test(b) ? 0 : 1
    if (aSprint !== bSprint) return aSprint - bSprint
    return a.localeCompare(b)
  })
}

export function filterTriageTasks(
  tasks: readonly TriageTaskRecord[],
  filters: TriageFilterOptions,
): TriageTaskRecord[] {
  const nowMs = filters.nowMs ?? Date.now()
  const dayMs = 86_400_000

  return tasks.filter((task) => {
    if (task.deferred_at !== null && task.deferred_at !== undefined) return false
    if (!OPEN_STATUSES.has(normalizeStatus(String(task.status ?? "pending")))) return false

    if (filters.unscoredOnly && isTaskScoredForFramework(task, filters.framework)) {
      return false
    }

    if (filters.epicId) {
      const taskEpic = task.epic_id ?? task.parent_id ?? ""
      if (filters.epicId === "__none__") {
        if (taskEpic) return false
      } else if (taskEpic !== filters.epicId && task.id !== filters.epicId) {
        return false
      }
    }

    if (filters.projectId) {
      const taskProject = task.project_id ?? ""
      if (filters.projectId === "__none__") {
        if (taskProject) return false
      } else if (taskProject !== filters.projectId) {
        return false
      }
    }

    if (filters.areaId) {
      const taskArea = task.area_id ?? ""
      if (filters.areaId === "__none__") {
        if (taskArea) return false
      } else if (taskArea !== filters.areaId) {
        return false
      }
    }

    if (filters.sprint) {
      if (filters.sprint.startsWith("label:")) {
        const targetLabel = filters.sprint.slice("label:".length).toLowerCase()
        const labels = parseTaskLabels(task.labels).map(l => l.toLowerCase())
        if (!labels.includes(targetLabel)) return false
      } else if (filters.sprint === "due:unscheduled") {
        if (task.due_date) return false
      } else {
        if (!task.due_date) return false
        const dueMs = Date.parse(task.due_date)
        if (!Number.isFinite(dueMs)) return false
        if (filters.sprint === "due:overdue" && dueMs >= nowMs) return false
        if (filters.sprint === "due:this-week" && (dueMs < nowMs - dayMs || dueMs > nowMs + 7 * dayMs)) return false
        if (filters.sprint === "due:next-2-weeks" && (dueMs < nowMs - dayMs || dueMs > nowMs + 14 * dayMs)) return false
      }
    }

    return true
  })
}

export function buildTriagePatchPayload(
  framework: TriageFrameworkId,
  values: Record<string, number>,
  existingFrameworkPayload: Record<string, unknown>,
  details: TriageExtendedDetails = {},
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const nextFp: Record<string, unknown> = { ...existingFrameworkPayload }
  let fpDirty = false

  const preview = computeTriagePreview(framework, values)

  if (framework === "eisenhower") {
    patch.urgency = Math.max(0, Math.min(5, Math.round(values.urgency ?? 0)))
    patch.importance = Math.max(0, Math.min(5, Math.round(values.importance ?? 0)))
    patch.eisenhower_override = false
  } else if (framework === "rice") {
    nextFp.rice = {
      ...parseTaskFrameworkPayload(existingFrameworkPayload.rice),
      reach: values.reach,
      impact: values.impact,
      confidence: values.confidence,
      effort: values.effort,
      confidence_unit: "percent",
    }
    fpDirty = true
  } else {
    const def = getTriageFrameworkDef(framework)
    for (const field of def.fields) {
      const val = values[field.key]
      if (typeof val === "number" && Number.isFinite(val)) {
        nextFp[field.key] = val
        fpDirty = true
      }
    }
    if (preview.score !== null) {
      nextFp[`${framework.replace(/-/g, "_")}_score`] = preview.score
      fpDirty = true
    }
  }

  if (typeof details.storyPoints === "number" && details.storyPoints > 0) {
    nextFp.story_points = details.storyPoints
    nextFp.story_points_score = details.storyPoints
    fpDirty = true
  }
  if (typeof details.effortMinutes === "number" && details.effortMinutes > 0) {
    patch.effort_minutes = details.effortMinutes
  }
  if (details.effortType) {
    patch.effort_type = details.effortType
  }
  if (details.delayImpact && details.delayImpact !== "none") {
    nextFp.delay_impact = details.delayImpact
    fpDirty = true
  }
  if (details.interestTag) {
    nextFp.interest_tag = details.interestTag
    fpDirty = true
  }

  if (fpDirty) {
    patch.framework_payload = JSON.stringify(nextFp)
  }
  return patch
}
