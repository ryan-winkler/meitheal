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
