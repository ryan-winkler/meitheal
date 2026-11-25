import { calculateRiceScore, roundFrameworkScore, type RiceInput as BaseRiceInput } from "@meitheal/domain-strategy"

export const RICE_FIELDS = ["reach", "impact", "confidence", "effort"] as const

export interface RiceInput extends BaseRiceInput {
  confidence_unit?: "percent"
}

export type RiceAssessment =
  | { status: "scored"; inputs: RiceInput; score: number }
  | { status: "legacy_ambiguous"; inputs: RiceInput; legacyConfidence: number; suggestedPercent: number }
  | { status: "unscored" }

export function frameworkPayloadObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function finiteDecimal(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return null
  const number = Number(trimmed)
  return Number.isFinite(number) ? number : null
}

function riceContainer(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.rice && typeof payload.rice === "object" && !Array.isArray(payload.rice)
    ? payload.rice as Record<string, unknown>
    : payload
}

/** Validate interactive/percent-scale RICE inputs; allows reach = 0 and confidence = 0, requires effort > 0. */
export function parseRiceInputs(values: Record<string, unknown>): RiceInput | null {
  const reach = finiteDecimal(values.reach)
  const impact = finiteDecimal(values.impact)
  const confidence = finiteDecimal(values.confidence)
  const effort = finiteDecimal(values.effort)
  if (reach === null || impact === null || confidence === null || effort === null) return null
  if (reach < 0 || impact < 0 || confidence < 0 || confidence > 100 || effort <= 0) return null
  const result: RiceInput = { reach, impact, confidence, effort }
  if (values.confidence_unit === "percent") result.confidence_unit = "percent"
  return result
}

/** Detect legacy (0, 1] confidence fractions lacking `confidence_unit: "percent"`. */
export function detectLegacyConfidenceFraction(
  values: Record<string, unknown>,
): { legacyConfidence: number; suggestedPercent: number } | null {
  if (values.confidence_unit === "percent") return null
  const confidence = finiteDecimal(values.confidence)
  if (confidence === null || confidence <= 0 || confidence > 1) return null
  return {
    legacyConfidence: confidence,
    suggestedPercent: roundFrameworkScore(confidence * 100),
  }
}

/**
 * Assess persisted RICE data without mutating it. Distinguishes unambiguous
 * percent-normalized scores from legacy (0, 1] confidence fractions lacking `confidence_unit: "percent"`.
 */
export function readRiceAssessment(payload: Record<string, unknown>): RiceAssessment {
  const source = riceContainer(payload)
  const inputs = parseRiceInputs(source)
  if (!inputs) return { status: "unscored" }

  const legacy = detectLegacyConfidenceFraction(source)
  if (legacy) {
    return {
      status: "legacy_ambiguous",
      inputs,
      legacyConfidence: legacy.legacyConfidence,
      suggestedPercent: legacy.suggestedPercent,
    }
  }
  const score = riceLensScore(inputs)
  return score === null ? { status: "unscored" } : { status: "scored", inputs, score }
}

/** Read unambiguous RICE inputs for score computation and passive list rendering. */
export function readRiceInputs(payload: Record<string, unknown>): RiceInput | null {
  const assessment = readRiceAssessment(payload)
  return assessment.status === "scored" ? assessment.inputs : null
}

/** Compute percent-normalized RICE score: (reach * impact * (confidence / 100)) / effort, rounded to <= 2 decimals. */
export function riceLensScore(inputs: Pick<BaseRiceInput, "reach" | "impact" | "confidence" | "effort">): number | null {
  if (
    !Number.isFinite(inputs.reach) ||
    !Number.isFinite(inputs.impact) ||
    !Number.isFinite(inputs.confidence) ||
    !Number.isFinite(inputs.effort) ||
    inputs.reach < 0 ||
    inputs.impact < 0 ||
    inputs.confidence < 0 ||
    inputs.confidence > 100 ||
    inputs.effort <= 0
  ) {
    return null
  }
  const score = calculateRiceScore(inputs)
  return Number.isFinite(score) ? roundFrameworkScore(score) : null
}

/** Format the canonical human-readable RICE formula breakdown string. */
export function formatRiceFormulaBreakdown(
  inputs: Pick<BaseRiceInput, "reach" | "impact" | "confidence" | "effort">,
  score?: number | null,
): string {
  const expr = `(${inputs.reach} × ${inputs.impact} × ${inputs.confidence}%) ÷ ${inputs.effort}`
  return score !== undefined && score !== null ? `${expr} = ${score}` : expr
}
