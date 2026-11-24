import { calendarToday, shiftCalendarDay } from "../../lib/date"

export function routinePeriod(cadence: string, now = new Date(), timezone = "UTC"): string {
  if (!timezone || timezone === "UTC") {
    const date = new Date(now)
    if (cadence === "weekly") date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
    return date.toISOString().slice(0, 10)
  }
  const today = calendarToday(timezone, now)
  if (cadence !== "weekly") return today
  const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay()
  return shiftCalendarDay(today, -((weekday + 6) % 7))
}
