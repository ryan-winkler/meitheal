export interface RiceInput {
  reach: number;
  impact: number;
  confidence: number;
  effort: number;
}

export function calculateRiceScore(input: RiceInput): number {
  if (input.effort <= 0) {
    return 0
  }
  return (input.reach * input.impact * (input.confidence / 100)) / input.effort
}

/** Per-dimension weights for customized RICE scoring */
export interface RiceWeights {
  reach: number
  impact: number
  confidence: number
  effort: number
}

/** Default equal weights */
export const DEFAULT_RICE_WEIGHTS: RiceWeights = {
  reach: 1,
  impact: 1,
  confidence: 1,
  effort: 1,
}

/**
 * Calculate a RICE score with custom per-field weights.
 * Formula: (reach × w_r × impact × w_i × (confidence / 100) × w_c) / (effort × w_e)
 */
export function calculateWeightedRiceScore(input: RiceInput, weights: RiceWeights = DEFAULT_RICE_WEIGHTS): number {
  const weightedEffort = input.effort * weights.effort
  if (weightedEffort <= 0) {
    return 0
  }
  return (
    (input.reach * weights.reach * input.impact * weights.impact * (input.confidence / 100) * weights.confidence) /
    weightedEffort
  )
}

/**
 * Calculate a Pillar alignment boost multiplier for RICE scores.
 *
 * When a task is aligned with a Pillar, its RICE score is multiplied
 * by a factor derived from the Pillar's weight (1-10).
 *
 * Boost range: 1.0 (weight=1, minimal boost) → 1.5 (weight=10, max boost).
 * Unaligned tasks (pillarWeight=0 or undefined) get no boost (1.0).
 *
 * @domain strategy + pillars
 * @kcs Pillar-aligned tasks surface higher in prioritization without
 *      overriding explicit user priority settings
 */
export function calculatePillarBoost(pillarWeight?: number): number {
  if (!pillarWeight || pillarWeight <= 0) return 1.0
  const clampedWeight = Math.min(Math.max(pillarWeight, 1), 10)
  // Linear interpolation: weight 1 → 1.0, weight 10 → 1.5
  return 1.0 + ((clampedWeight - 1) / 9) * 0.5
}

/**
 * Calculate RICE score with optional Pillar alignment boost.
 *
 * Convenience function that combines weighted RICE scoring
 * with Pillar weight boost.
 */
export function calculateBoostedRiceScore(
  input: RiceInput,
  pillarWeight?: number,
  weights: RiceWeights = DEFAULT_RICE_WEIGHTS,
): number {
  const base = calculateWeightedRiceScore(input, weights)
  return base * calculatePillarBoost(pillarWeight)
}

