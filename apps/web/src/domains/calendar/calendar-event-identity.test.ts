import test from "node:test"
import assert from "node:assert/strict"
import {
  isHtmlDescription,
  isMeithealOriginatedEvent,
  normalizeCalendarDescription,
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

test("isMeithealOriginatedEvent catches outbound write-backs, HTML-wrapped reminders, and recursive prefix loops", () => {
  assert.equal(
    isMeithealOriginatedEvent("Dentist", "<p>Added from Meitheal</p>"),
    true,
  )
  assert.equal(
    isMeithealOriginatedEvent("Reminder", "<p>Task MTH-30 is due.</p><p>Open MTH-30 in Meitheal: https://tasks.example.com/tickets/MTH-30</p>"),
    true,
  )
  assert.equal(
    isMeithealOriginatedEvent("📋 MTH-30: Pay electricity bill — DUE", null),
    true,
  )
  assert.equal(
    isMeithealOriginatedEvent("📋 MTH-34: 📋 MTH-30: Pay electricity bill", null),
    true,
  )
  // Ordinary external calendar events are NOT filtered out
  assert.equal(
    isMeithealOriginatedEvent("Family Dinner", "Bring dessert & drinks"),
    false,
  )
})
