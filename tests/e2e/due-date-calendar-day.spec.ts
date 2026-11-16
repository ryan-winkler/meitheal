import { expect, test } from "@playwright/test"
import { calendarDaysFromToday, calendarToday, formatRegionalDate } from "../../apps/web/src/lib/date"

function shiftDay(day: string, days: number) {
  const date = new Date(day + "T00:00:00Z")
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

test("date-only due dates count whole calendar days in the user's timezone", () => {
  // 23:30 in Los Angeles on 8 March is already 9 March in UTC and Dublin.
  const now = new Date("2031-03-09T07:30:00Z")
  expect(calendarToday("America/Los_Angeles", now)).toBe("2031-03-08")
  expect(calendarToday("Europe/Dublin", now)).toBe("2031-03-09")
  expect(calendarDaysFromToday("2031-03-08", "America/Los_Angeles", now)).toBe(0)
  expect(calendarDaysFromToday("2031-03-08", "Europe/Dublin", now)).toBe(-1)
  expect(calendarDaysFromToday("2031-03-10", "Europe/Dublin", now)).toBe(1)
  expect(calendarDaysFromToday("2031-02-30", "Europe/Dublin", now)).toBeNull()
  expect(calendarDaysFromToday("not-a-date", "Europe/Dublin", now)).toBeNull()
  expect(calendarDaysFromToday("2031-03-08T10:00:00Z", "Europe/Dublin", now)).toBe(-1)
  expect(calendarDaysFromToday("2031-03-09T06:00:00Z", "America/Los_Angeles", now)).toBe(0)
})

test("date-only due dates keep their day in absolute formats west of UTC", () => {
  const options = { timezone: "America/Los_Angeles" } as const
  expect(formatRegionalDate("2031-03-08", { ...options, format: "absolute-iso" })).toBe("2031-03-08")
  expect(formatRegionalDate("2031-03-08", { ...options, format: "absolute-eu" })).toBe("08/03/2031")
  expect(formatRegionalDate("2031-03-08", { ...options, format: "absolute-us" })).toBe("03/08/2031")
})

test("relative due dates name the calendar day instead of hours from UTC midnight", () => {
  const timezone = "Europe/Dublin"
  const today = calendarToday(timezone)
  const relative = (days: number) => formatRegionalDate(shiftDay(today, days), { format: "relative", timezone })
  expect(relative(0)).toBe("today")
  expect(relative(1)).toBe("tomorrow")
  expect(relative(-1)).toBe("yesterday")
  expect(relative(-2)).toBe("2 days ago")
  expect(relative(14)).toBe("in 2 weeks")
})
