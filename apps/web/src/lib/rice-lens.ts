import type { RiceInput } from "@meitheal/domain-strategy"

export const RICE_FIELDS = ["reach", "impact", "confidence", "effort"] as const

export function frameworkPayloadObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function parseRiceInputs(values: Record<string, unknown>): RiceInput | null {
  const reach = riceNumber(values.reach)
  const impact = riceNumber(values.impact)
  const confidence = riceNumber(values.confidence)
  const effort = riceNumber(values.effort)
  if (reach === null || impact === null || confidence === null || effort === null || effort === 0) return null
  return { reach, impact, confidence, effort }
}

export function readRiceInputs(payload: Record<string, unknown>): RiceInput | null {
  const nested = payload.rice
  const inputs = nested ? parseRiceInputs(frameworkPayloadObject(nested)) : null
  return inputs ?? (payload.reach == null ? null : parseRiceInputs(payload))
}

/** Task badges and the built-in lens use whole percentages in their stored score scale. */
export function riceLensScore({ reach, impact, confidence, effort }: RiceInput): number | null {
  const score = Math.round((reach * impact * confidence) / effort)
  return Number.isFinite(score) ? score : null
}

function riceNumber(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}
