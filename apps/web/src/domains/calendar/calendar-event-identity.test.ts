import test from "node:test"
import assert from "node:assert/strict"
import {
  isHtmlDescription,
  isMeithealOriginatedEvent,
  normalizeCalendarDescription,
  stripCalendarReminderWrappers,
  stripHtmlTags,
} from "./calendar-event-identity"

test("stripHtmlTags and normalizeCalendarDescription convert Google Calendar HTML safely without corrupting plain angle brackets", () => {
  assert.equal(isHtmlDescription("<p>Task MTH-30 is due.</p><p>Added from Meitheal</p>"), true)
  assert.equal(isHtmlDescription("Check pressure: a < b > c"), false)

  assert.equal(
    normalizeCalendarDescription("<p>Line 1</p><p>Line 2 &amp; &lt;3</p>"),
    "Line 1\nLine 2 & <3",
  )
  assert.equal(
    normalizeCalendarDescription("Check pressure: a < b > c"),
    "Check pressure: a < b > c",
  )
  // &amp; is decoded last so &amp;lt; becomes &lt; instead of double-unescaping to <
  assert.equal(stripHtmlTags("<p>&amp;lt;script&amp;gt;</p>").trim(), "&lt;script&gt;")
})

test("isMeithealOriginatedEvent catches outbound write-backs, HTML-wrapped reminders, collapsed single-line descriptions, and truncated loops", () => {
  assert.equal(
    isMeithealOriginatedEvent("Dentist", "<p>Added from Meitheal</p>"),
    true,
  )
  assert.equal(
    isMeithealOriginatedEvent("Reminder", "<p>Task MTH-30 is due.</p><p>Open MTH-30 in Meitheal: https://tasks.example.com/tickets/MTH-30</p>"),
    true,
  )
  // Production single-line collapsed description from Google Calendar
  assert.equal(
    isMeithealOriginatedEvent(
      "Mounjaro",
      "Task MTH-75 is due. Open in Meitheal: https://ha.0ii.top/api/hassio_ingress/abc123/kanban",
    ),
    true,
  )
  assert.equal(
    isMeithealOriginatedEvent(
      "Mounjaro",
      "Task reminder. Added from Meitheal",
    ),
    true,
  )
  assert.equal(
    isMeithealOriginatedEvent("📋 MTH-30: Pay electricity bill — DUE", null),
    true,
  )
  // En-dash and ASCII hyphen variants + emoji-stripped variants
  assert.equal(
    isMeithealOriginatedEvent("📋 MTH-15: Mounjaro - DUE", null),
    true,
  )
  assert.equal(
    isMeithealOriginatedEvent("MTH-15: Mounjaro – DUE", null),
    true,
  )
  // Single emoji+ticket prefix even when Google Calendar truncates the tail
  assert.equal(
    isMeithealOriginatedEvent("📋 MTH-15: Mounjaro", null),
    true,
  )
  // Truncated nested loop summary
  assert.equal(
    isMeithealOriginatedEvent("📋 MTH-75: 📋 MTH-74: 📋 MTH-73: 📋 MTH-15:...", null),
    true,
  )
  assert.equal(
    isMeithealOriginatedEvent("📋 MTH-34: 📋 MTH-30: Pay electricity bill", null),
    true,
  )
  // Ordinary external calendar events and human notes are NOT filtered out
  assert.equal(
    isMeithealOriginatedEvent("Family Dinner", "Bring dessert & drinks"),
    false,
  )
  assert.equal(
    isMeithealOriginatedEvent("Budget Review", "Discuss whether Task HOME-12 is due."),
    false,
  )
  assert.equal(
    isMeithealOriginatedEvent("Team Sync: 10:30 Q4", "Weekly catch-up"),
    false,
  )
})

test("stripCalendarReminderWrappers removes nested ticket prefixes and DUE suffixes idempotently", () => {
  assert.equal(
    stripCalendarReminderWrappers("📋 MTH-75: 📋 MTH-74: 📋 MTH-15: Mounjaro — DUE — DUE — DUE"),
    "Mounjaro",
  )
  assert.equal(
    stripCalendarReminderWrappers("MTH-30: Pay electricity bill - DUE"),
    "Pay electricity bill",
  )
  assert.equal(
    stripCalendarReminderWrappers("Mounjaro"),
    "Mounjaro",
  )
  assert.equal(
    stripCalendarReminderWrappers("Dentist: Dr. Smith"),
    "Dentist: Dr. Smith",
  )
})
