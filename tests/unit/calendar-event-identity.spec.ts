import { expect, test } from "@playwright/test"
import {
  isMeithealOriginatedEvent,
  normalizeCalendarDescription,
  stripCalendarReminderWrappers,
} from "../../apps/web/src/domains/calendar/calendar-event-identity"

const ticketUrl = "https://calendar.example/tasks/MTH-30"

test("calendar descriptions preserve plain text and normalize rich text once", () => {
  expect(normalizeCalendarDescription("<p>First line</p><p>Second &amp; &amp;lt;3</p>"))
    .toBe("First line\nSecond & &lt;3")
  expect(normalizeCalendarDescription("  Check whether a < b > c  ")).toBe("Check whether a < b > c")
  expect(normalizeCalendarDescription("<p> </p>")).toBeNull()
})

test("inbound sync recognizes reminder descriptions after calendar providers reformat them", () => {
  const reminders = [
    "<p>Task MTH-30 is due.</p><p>Bring a copy of the receipt.</p>",
    `Task MTH-30 is due. Open MTH-30 in Meitheal: ${ticketUrl}`,
    "Task MTH-30 is due. Added from Meitheal",
    `Task reminder. Open in Meitheal: ${ticketUrl}`,
    "Task reminder. Added from Meitheal",
    "📋 MTH-30",
    "📋 MTH-30 · Status: Upcoming",
  ]

  for (const description of reminders) {
    expect(isMeithealOriginatedEvent("Pay the electricity bill", description), description).toBe(true)
  }
})

test("similar descriptions still import as ordinary external events", () => {
  const notes = [
    "Discuss whether Task MTH-30 is due.",
    "Task MTH-30 is due. Bring a copy of the receipt.",
    "Task MTH-030 is due.",
    `Open the handout in Meitheal: ${ticketUrl}`,
    "Task reminder. Bring a copy of the receipt.",
    "📋 MTH-30 appears in the handout.",
  ]

  for (const description of notes) {
    expect(isMeithealOriginatedEvent("Budget meeting: review invoices", description), description).toBe(false)
  }
})

test("inbound sync recognizes reminder summaries with normalized or truncated suffixes", () => {
  const reminders = [
    "📋 Pay the electricity bill — DUE",
    "🎯 Pay the electricity bill – DUE",
    "📖 Pay the electricity bill - DUE",
    "📋 MTH-30: Pay the electricity bill",
    "MTH-30: Pay the electricity bill – DUE",
    "MTH-31: MTH-30: Pay the electricity bill",
  ]

  for (const summary of reminders) {
    expect(isMeithealOriginatedEvent(summary, null), summary).toBe(true)
  }
  expect(isMeithealOriginatedEvent("Pay the electricity bill — DUE", null)).toBe(false)
  expect(isMeithealOriginatedEvent("MTH-30: Review the budget", null)).toBe(false)
})

test("rewriting an outbound summary removes reminders recursively without growing its title", () => {
  const wrapped = "📋 MTH-31: 📋 MTH-30: Pay the electricity bill - DUE – DUE — DUE"
  const title = stripCalendarReminderWrappers(wrapped)
  expect(title).toBe("Pay the electricity bill")
  expect(stripCalendarReminderWrappers(title)).toBe(title)
  expect(stripCalendarReminderWrappers("⚡ Pay the electricity bill - DUE")).toBe(title)
  expect(stripCalendarReminderWrappers("✅ Task: Pay the electricity bill")).toBe(title)
  expect(stripCalendarReminderWrappers("Task: Meet at 10:30")).toBe("Task: Meet at 10:30")
})
