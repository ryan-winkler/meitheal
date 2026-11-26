/**
 * Scoring Slider Config — Pure configuration for Tabler range + editable number inputs.
 *
 * Domain: strategy / scoring UI
 * Provides sensible range slider bounds and steps for RICE, DRICE, ICE, WSJF,
 * and generic numeric framework fields while allowing users to type higher values
 * directly into the paired editable number input when needed.
 */

export interface ScoringSliderConfig {
  min: number
  max: number
  step: number
  suffix?: string
  /** When true, the number input allows values above slider max (soft cap). */
  softMax?: boolean
  /** Optional scale hints shown below the slider track. */
  ticks?: [string, string]
}

const RICE_SLIDER_DEFAULTS: Record<string, ScoringSliderConfig> = {
  reach: {
    min: 0,
    max: 100,
    step: 1,
    softMax: true,
    ticks: ["0", "100+"],
  },
  impact: {
    min: 0.25,
    max: 3,
    step: 0.25,
    softMax: true,
    ticks: ["0.25 (Minimal)", "3 (Massive)"],
  },
  confidence: {
    min: 0,
    max: 100,
    step: 5,
    suffix: "%",
    softMax: false,
    ticks: ["0%", "100%"],
  },
  effort: {
    min: 0.5,
    max: 20,
    step: 0.5,
    softMax: true,
    ticks: ["0.5", "20+"],
  },
  dependencies: {
    min: 1,
    max: 10,
    step: 1,
    softMax: true,
    ticks: ["1", "10+"],
  },
}

export function getScoringSliderConfig(
  frameworkId: string,
  fieldKey: string,
  fieldMin?: number,
  fieldMax?: number,
): ScoringSliderConfig | null {
  const fw = frameworkId.trim().toLowerCase()
  const key = fieldKey.trim().toLowerCase()

  if (fw === "rice" || fw === "drice") {
    const preset = RICE_SLIDER_DEFAULTS[key]
    if (preset) {
      const min = typeof fieldMin === "number" && Number.isFinite(fieldMin) ? fieldMin : preset.min
      const max = typeof fieldMax === "number" && Number.isFinite(fieldMax) && fieldMax > min ? fieldMax : preset.max
      return { ...preset, min, max }
    }
  }

  if (
    typeof fieldMin === "number" && Number.isFinite(fieldMin) &&
    typeof fieldMax === "number" && Number.isFinite(fieldMax) &&
    fieldMax > fieldMin
  ) {
    const span = fieldMax - fieldMin
    const step = span <= 5 ? 0.5 : span <= 20 ? 1 : span <= 100 ? 5 : 1
    return {
      min: fieldMin,
      max: fieldMax,
      step,
      softMax: false,
      ticks: [String(fieldMin), String(fieldMax)],
    }
  }

  return null
}

/** Clamp a numeric value onto the slider track's [min, max] range without altering the number input. */
export function clampSliderTrackValue(value: number | string, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) return min
  if (n < min) return min
  if (n > max) return max
  return n
}

/** Compute the track fill percentage (0-100) for accessible Tabler range visual progress. */
export function sliderFillPercent(value: number | string, min: number, max: number): number {
  if (max <= min) return 0
  const clamped = clampSliderTrackValue(value, min, max)
  return Math.round(((clamped - min) / (max - min)) * 100)
}
