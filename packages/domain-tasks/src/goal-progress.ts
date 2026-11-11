/** Convert a stored goal metric into bounded percentage progress. */
export function goalProgress(current: number, target: number | null): number {
  if (target === null || !Number.isFinite(target) || target <= 0 || !Number.isFinite(current)) return 0
  return Math.min(100, Math.max(0, current / target * 100))
}

export function isValidGoalProgress(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
}
