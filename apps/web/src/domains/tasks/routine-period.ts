export function routinePeriod(cadence: string, now = new Date()): string {
  const date = new Date(now)
  if (cadence === "weekly") date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  return date.toISOString().slice(0, 10)
}

