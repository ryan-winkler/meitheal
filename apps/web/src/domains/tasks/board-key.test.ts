import test from "node:test"
import assert from "node:assert/strict"
import {
  formatBoardTicketKey,
  normalizeBoardKey,
  rewriteTicketRefPrefix,
  suggestBoardKey,
  validateBoardKey,
} from "./board-key"

test("normalizeBoardKey uppercases and strips invalid characters", () => {
  assert.equal(normalizeBoardKey("  mth-12 "), "MTH12")
  assert.equal(normalizeBoardKey("garden_work_extra_long"), "GARDENWORK")
})

test("validateBoardKey accepts valid 2-10 char alphanumeric keys starting with a letter", () => {
  assert.deepEqual(validateBoardKey("mth"), { ok: true, key: "MTH" })
  assert.deepEqual(validateBoardKey("GRD2"), { ok: true, key: "GRD2" })
  assert.deepEqual(validateBoardKey("HOUSEHOLD1"), { ok: true, key: "HOUSEHOLD1" })
})

test("validateBoardKey rejects short, long, numeric-leading, symbolic, and reserved keys", () => {
  assert.equal(validateBoardKey("").ok, false)
  assert.equal(validateBoardKey("A").ok, false)
  assert.equal(validateBoardKey("1HOME").ok, false)
  assert.equal(validateBoardKey("MTH-1").ok, false)
  assert.equal(validateBoardKey("ABCDEFGHIJK").ok, false)
  assert.equal(validateBoardKey("API").ok, false)
  assert.equal(validateBoardKey("NEW").ok, false)
})

test("suggestBoardKey generates sensible keys from board names", () => {
  assert.equal(suggestBoardKey("Work"), "WORK")
  assert.equal(suggestBoardKey("Garden"), "GRD")
  assert.equal(suggestBoardKey("Home Maintenance"), "HM")
  assert.equal(suggestBoardKey("Side Hustle Lab"), "SHL")
  assert.equal(suggestBoardKey("12345"), "BRD")
  assert.equal(suggestBoardKey("New"), "BRD")
  assert.equal(validateBoardKey(suggestBoardKey("Café & Lawn")).ok, true)
})

test("rewriteTicketRefPrefix swaps only the key prefix while keeping ticket numbers", () => {
  assert.equal(rewriteTicketRefPrefix("MTH-30", "HOME"), "HOME-30")
  assert.equal(rewriteTicketRefPrefix("ABCDEFGH-004", "GRD"), "GRD-4")
  assert.equal(rewriteTicketRefPrefix("invalid", "GRD"), null)
  assert.equal(rewriteTicketRefPrefix(null, "GRD"), null)
})

test("formatBoardTicketKey prefers board-scoped ticket_key over MTH fallback", () => {
  assert.equal(formatBoardTicketKey("GRD-7", 7), "GRD-7")
  assert.equal(formatBoardTicketKey(null, 12), "MTH-12")
  assert.equal(formatBoardTicketKey(null, 12, "HOME"), "HOME-12")
  assert.equal(formatBoardTicketKey(null, null), null)
})
