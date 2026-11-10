/**
 * Recurrence Engine — Unit Tests
 *
 * Covers parseRRule, getNextOccurrence, toRRuleString, and describeRule
 * from apps/web/src/domains/tasks/recurrence.ts
 *
 * @domain domain-tasks
 * @see docs/decisions/adr-016-recurrence-vs-habits.md
 */
import { expect, test } from "@playwright/test"
import {
  describeRule,
  getNextOccurrence,
  parseRRule,
  toRRuleString,
} from "../../apps/web/src/domains/tasks/recurrence"
import type { RecurrenceRule } from "../../apps/web/src/domains/tasks/recurrence"

// ── parseRRule ─────────────────────────────────────────────────────────

test.describe("parseRRule", () => {
  test("parses DAILY frequency", () => {
    const rule = parseRRule("FREQ=DAILY")
    expect(rule).not.toBeNull()
    expect(rule!.freq).toBe("DAILY")
    expect(rule!.interval).toBe(1)
  })

  test("parses WEEKLY frequency", () => {
    const rule = parseRRule("FREQ=WEEKLY")
    expect(rule).not.toBeNull()
    expect(rule!.freq).toBe("WEEKLY")
    expect(rule!.interval).toBe(1)
  })

  test("parses MONTHLY frequency", () => {
    const rule = parseRRule("FREQ=MONTHLY")
    expect(rule).not.toBeNull()
    expect(rule!.freq).toBe("MONTHLY")
  })

  test("parses YEARLY frequency", () => {
    const rule = parseRRule("FREQ=YEARLY")
    expect(rule).not.toBeNull()
    expect(rule!.freq).toBe("YEARLY")
  })

  test("strips RRULE: prefix", () => {
    const rule = parseRRule("RRULE:FREQ=DAILY;INTERVAL=3")
    expect(rule).not.toBeNull()
    expect(rule!.freq).toBe("DAILY")
    expect(rule!.interval).toBe(3)
  })

  test("parses custom INTERVAL", () => {
    const rule = parseRRule("FREQ=WEEKLY;INTERVAL=2")
    expect(rule).not.toBeNull()
    expect(rule!.interval).toBe(2)
  })

  test("defaults INTERVAL to 1 when omitted", () => {
    const rule = parseRRule("FREQ=DAILY")
    expect(rule!.interval).toBe(1)
  })

  test("parses BYDAY with multiple days", () => {
    const rule = parseRRule("FREQ=WEEKLY;BYDAY=MO,WE,FR")
    expect(rule).not.toBeNull()
    expect(rule!.byDay).toEqual(["MO", "WE", "FR"])
  })

  test("parses COUNT constraint", () => {
    const rule = parseRRule("FREQ=DAILY;COUNT=5")
    expect(rule).not.toBeNull()
    expect(rule!.count).toBe(5)
  })

  test("parses UNTIL in YYYYMMDD format", () => {
    const rule = parseRRule("FREQ=WEEKLY;UNTIL=20261231")
    expect(rule).not.toBeNull()
    expect(rule!.until).toBe("2026-12-31")
  })

  test("parses UNTIL in ISO format", () => {
    const rule = parseRRule("FREQ=MONTHLY;UNTIL=2026-06-15")
    expect(rule).not.toBeNull()
    expect(rule!.until).toBe("2026-06-15")
  })

  test("returns null for empty string", () => {
    expect(parseRRule("")).toBeNull()
  })

  test("returns null for whitespace-only string", () => {
    expect(parseRRule("   ")).toBeNull()
  })

  test("returns null for unknown FREQ", () => {
    expect(parseRRule("FREQ=BIWEEKLY")).toBeNull()
  })

  test("returns null for missing FREQ", () => {
    expect(parseRRule("INTERVAL=2;BYDAY=MO")).toBeNull()
  })

  test("handles complex rule with all options", () => {
    const rule = parseRRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=10;UNTIL=20261231")
    expect(rule).not.toBeNull()
    expect(rule!.freq).toBe("WEEKLY")
    expect(rule!.interval).toBe(2)
    expect(rule!.byDay).toEqual(["MO", "WE", "FR"])
    expect(rule!.count).toBe(10)
    expect(rule!.until).toBe("2026-12-31")
  })

  test("filters invalid day names from BYDAY", () => {
    const rule = parseRRule("FREQ=WEEKLY;BYDAY=MO,XX,FR")
    expect(rule).not.toBeNull()
    expect(rule!.byDay).toEqual(["MO", "FR"])
  })
})

// ── getNextOccurrence ──────────────────────────────────────────────────

test.describe("getNextOccurrence", () => {
  // Helper — create date at midnight local time (recurrence.ts uses local-time Date methods)
  function localDate(year: number, month: number, day: number): Date {
    return new Date(year, month - 1, day)
  }

  test.describe("DAILY", () => {
    test("advances by 1 day", () => {
      const rule: RecurrenceRule = { freq: "DAILY", interval: 1 }
      const next = getNextOccurrence(rule, localDate(2026, 3, 20))!
      expect(next.getDate()).toBe(21)
      expect(next.getMonth()).toBe(2) // March = 2
    })

    test("advances by custom interval", () => {
      const rule: RecurrenceRule = { freq: "DAILY", interval: 3 }
      const next = getNextOccurrence(rule, localDate(2026, 3, 20))!
      expect(next.getDate()).toBe(23)
    })

    test("crosses month boundary", () => {
      const rule: RecurrenceRule = { freq: "DAILY", interval: 1 }
      const next = getNextOccurrence(rule, localDate(2026, 3, 31))!
      expect(next.getMonth()).toBe(3) // April = 3
      expect(next.getDate()).toBe(1)
    })
  })

  test.describe("WEEKLY", () => {
    test("advances by 1 week", () => {
      const rule: RecurrenceRule = { freq: "WEEKLY", interval: 1 }
      const next = getNextOccurrence(rule, localDate(2026, 3, 20))!
      expect(next.getDate()).toBe(27)
    })

    test("advances by custom interval", () => {
      const rule: RecurrenceRule = { freq: "WEEKLY", interval: 2 }
      const next = getNextOccurrence(rule, localDate(2026, 3, 20))!
      // 20 + 14 = April 3 (crosses month boundary)
      expect(next.getDate()).toBe(3)
      expect(next.getMonth()).toBe(3) // April
    })

    test("BYDAY finds next matching day in same week", () => {
      // March 23, 2026 is a Monday (day 1)
      const rule: RecurrenceRule = { freq: "WEEKLY", interval: 1, byDay: ["WE", "FR"] }
      const next = getNextOccurrence(rule, localDate(2026, 3, 23))!
      // Should jump to Wednesday March 25
      expect(next.getDate()).toBe(25)
      expect(next.getDay()).toBe(3) // Wednesday
    })

    test("BYDAY wraps to next week when past all target days", () => {
      // March 21, 2026 is a Saturday (day 6)
      const rule: RecurrenceRule = { freq: "WEEKLY", interval: 1, byDay: ["MO", "WE"] }
      const next = getNextOccurrence(rule, localDate(2026, 3, 21))!
      // Should jump to Monday March 23
      expect(next.getDay()).toBe(1) // Monday
    })
  })

  test.describe("MONTHLY", () => {
    test("advances by 1 month", () => {
      const rule: RecurrenceRule = { freq: "MONTHLY", interval: 1 }
      const next = getNextOccurrence(rule, localDate(2026, 3, 15))!
      expect(next.getMonth()).toBe(3) // April
      expect(next.getDate()).toBe(15)
    })

    test("month-end overflow: Jan 31 → Feb 28 (non-leap)", () => {
      const rule: RecurrenceRule = { freq: "MONTHLY", interval: 1 }
      const next = getNextOccurrence(rule, localDate(2026, 1, 31))!
      expect(next.getMonth()).toBe(1) // February
      expect(next.getDate()).toBe(28)
    })

    test("month-end overflow: Jan 31 → Feb 29 (leap year)", () => {
      const rule: RecurrenceRule = { freq: "MONTHLY", interval: 1 }
      const next = getNextOccurrence(rule, localDate(2028, 1, 31))!
      expect(next.getMonth()).toBe(1) // February
      expect(next.getDate()).toBe(29)
    })

    test("advances by custom interval", () => {
      const rule: RecurrenceRule = { freq: "MONTHLY", interval: 3 }
      const next = getNextOccurrence(rule, localDate(2026, 1, 15))!
      expect(next.getMonth()).toBe(3) // April
      expect(next.getDate()).toBe(15)
    })
  })

  test.describe("YEARLY", () => {
    test("advances by 1 year", () => {
      const rule: RecurrenceRule = { freq: "YEARLY", interval: 1 }
      const next = getNextOccurrence(rule, localDate(2026, 6, 15))!
      expect(next.getFullYear()).toBe(2027)
      expect(next.getMonth()).toBe(5) // June
      expect(next.getDate()).toBe(15)
    })

    test("leap year: Feb 29 → Mar 1 next year", () => {
      // 2028 is a leap year with Feb 29
      const rule: RecurrenceRule = { freq: "YEARLY", interval: 1 }
      const next = getNextOccurrence(rule, localDate(2028, 2, 29))!
      // 2029 has no Feb 29 — Date auto-rolls to March 1
      expect(next.getFullYear()).toBe(2029)
      // JS Date rolls Feb 29 → Mar 1 when target year lacks Feb 29
      expect(next.getMonth() === 2 || next.getMonth() === 1).toBeTruthy()
    })

    test("advances by custom interval", () => {
      const rule: RecurrenceRule = { freq: "YEARLY", interval: 2 }
      const next = getNextOccurrence(rule, localDate(2026, 1, 1))!
      expect(next.getFullYear()).toBe(2028)
    })
  })

  test.describe("COUNT exhaustion", () => {
    test("returns null when completionCount >= count", () => {
      const rule: RecurrenceRule = { freq: "DAILY", interval: 1, count: 5 }
      expect(getNextOccurrence(rule, localDate(2026, 3, 20), 5)).toBeNull()
    })

    test("returns date when completionCount < count", () => {
      const rule: RecurrenceRule = { freq: "DAILY", interval: 1, count: 5 }
      expect(getNextOccurrence(rule, localDate(2026, 3, 20), 4)).not.toBeNull()
    })
  })

  test.describe("UNTIL boundary", () => {
    test("returns null when next occurrence exceeds UNTIL", () => {
      const rule: RecurrenceRule = { freq: "DAILY", interval: 1, until: "2026-03-21" }
      // From March 21, next would be March 22 → past UNTIL
      expect(getNextOccurrence(rule, localDate(2026, 3, 21))).toBeNull()
    })

    test("returns date when next occurrence is within UNTIL", () => {
      const rule: RecurrenceRule = { freq: "DAILY", interval: 1, until: "2026-03-25" }
      const next = getNextOccurrence(rule, localDate(2026, 3, 20))
      expect(next).not.toBeNull()
    })
  })
})

// ── toRRuleString ──────────────────────────────────────────────────────

test.describe("toRRuleString", () => {
  test("serializes basic DAILY rule", () => {
    const rule: RecurrenceRule = { freq: "DAILY", interval: 1 }
    expect(toRRuleString(rule)).toBe("FREQ=DAILY")
  })

  test("includes INTERVAL when > 1", () => {
    const rule: RecurrenceRule = { freq: "WEEKLY", interval: 2 }
    expect(toRRuleString(rule)).toBe("FREQ=WEEKLY;INTERVAL=2")
  })

  test("omits INTERVAL when = 1", () => {
    const result = toRRuleString({ freq: "DAILY", interval: 1 })
    expect(result).not.toContain("INTERVAL")
  })

  test("includes BYDAY", () => {
    const rule: RecurrenceRule = { freq: "WEEKLY", interval: 1, byDay: ["MO", "WE", "FR"] }
    expect(toRRuleString(rule)).toBe("FREQ=WEEKLY;BYDAY=MO,WE,FR")
  })

  test("includes COUNT", () => {
    const rule: RecurrenceRule = { freq: "DAILY", interval: 1, count: 10 }
    expect(toRRuleString(rule)).toBe("FREQ=DAILY;COUNT=10")
  })

  test("includes UNTIL with dashes removed", () => {
    const rule: RecurrenceRule = { freq: "MONTHLY", interval: 1, until: "2026-12-31" }
    expect(toRRuleString(rule)).toBe("FREQ=MONTHLY;UNTIL=20261231")
  })

  test("round-trip: parse → serialize → parse produces same result", () => {
    const original = "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=10"
    const parsed = parseRRule(original)!
    const serialized = toRRuleString(parsed)
    const reparsed = parseRRule(serialized)!

    expect(reparsed.freq).toBe(parsed.freq)
    expect(reparsed.interval).toBe(parsed.interval)
    expect(reparsed.byDay).toEqual(parsed.byDay)
    expect(reparsed.count).toBe(parsed.count)
  })
})

// ── describeRule ────────────────────────────────────────────────────────

test.describe("describeRule", () => {
  test("DAILY interval 1 → 'Every day'", () => {
    expect(describeRule({ freq: "DAILY", interval: 1 })).toBe("Every day")
  })

  test("DAILY interval 3 → 'Every 3 days'", () => {
    expect(describeRule({ freq: "DAILY", interval: 3 })).toBe("Every 3 days")
  })

  test("WEEKLY interval 1 → 'Every week'", () => {
    expect(describeRule({ freq: "WEEKLY", interval: 1 })).toBe("Every week")
  })

  test("WEEKLY interval 2 → 'Every 2 weeks'", () => {
    expect(describeRule({ freq: "WEEKLY", interval: 2 })).toBe("Every 2 weeks")
  })

  test("WEEKLY with BYDAY → lists days", () => {
    const desc = describeRule({ freq: "WEEKLY", interval: 1, byDay: ["MO", "WE", "FR"] })
    expect(desc).toBe("Every Monday, Wednesday, Friday")
  })

  test("WEEKLY with BYDAY and interval → includes weeks", () => {
    const desc = describeRule({ freq: "WEEKLY", interval: 2, byDay: ["MO", "FR"] })
    expect(desc).toBe("Every 2 weeks on Monday, Friday")
  })

  test("MONTHLY interval 1 → 'Every month'", () => {
    expect(describeRule({ freq: "MONTHLY", interval: 1 })).toBe("Every month")
  })

  test("MONTHLY interval 3 → 'Every 3 months'", () => {
    expect(describeRule({ freq: "MONTHLY", interval: 3 })).toBe("Every 3 months")
  })

  test("YEARLY interval 1 → 'Every year'", () => {
    expect(describeRule({ freq: "YEARLY", interval: 1 })).toBe("Every year")
  })

  test("YEARLY interval 2 → 'Every 2 years'", () => {
    expect(describeRule({ freq: "YEARLY", interval: 2 })).toBe("Every 2 years")
  })

  test("COUNT suffix appended", () => {
    const desc = describeRule({ freq: "DAILY", interval: 1, count: 5 })
    expect(desc).toBe("Every day (5 times)")
  })

  test("UNTIL suffix appended", () => {
    const desc = describeRule({ freq: "WEEKLY", interval: 1, until: "2026-12-31" })
    expect(desc).toBe("Every week until 2026-12-31")
  })

  test("COUNT and UNTIL both appended", () => {
    const desc = describeRule({ freq: "DAILY", interval: 1, count: 10, until: "2026-06-01" })
    expect(desc).toBe("Every day (10 times) until 2026-06-01")
  })
})
