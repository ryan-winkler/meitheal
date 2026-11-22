import test from "node:test"
import assert from "node:assert/strict"
import {
  comboFromKeyboardEvent,
  findShortcutConflicts,
  formatShortcutKeys,
  isSingleKeyCombo,
  matchesShortcutEvent,
  normalizeShortcutCombo,
  resolveShortcuts,
  sanitizeShortcutOverrides,
} from "./keyboard-shortcuts"

test("normalizeShortcutCombo canonicalizes modifiers and rejects blocked keys", () => {
  assert.equal(normalizeShortcutCombo("cmd+shift+k"), "Ctrl+Shift+K")
  assert.equal(normalizeShortcutCombo("ctrl+b"), "Ctrl+B")
  assert.equal(normalizeShortcutCombo("n"), "N")
  assert.equal(normalizeShortcutCombo("Shift+?"), "?")
  assert.equal(normalizeShortcutCombo("/"), "/")
  assert.equal(normalizeShortcutCombo("alt+f4"), "Alt+F4")
  assert.equal(normalizeShortcutCombo("Escape"), null)
  assert.equal(normalizeShortcutCombo("Tab"), null)
  assert.equal(normalizeShortcutCombo("Control"), null)
  assert.equal(normalizeShortcutCombo("Ctrl+Shift+"), null)
  assert.equal(normalizeShortcutCombo("a+b"), null)
})

test("comboFromKeyboardEvent maps KeyboardEvent cleanly across Ctrl/Meta and shifted symbols", () => {
  assert.equal(comboFromKeyboardEvent({ key: "k", metaKey: true }), "Ctrl+K")
  assert.equal(comboFromKeyboardEvent({ key: "N", shiftKey: true }), "Shift+N")
  assert.equal(comboFromKeyboardEvent({ key: "?", shiftKey: true }), "?")
  assert.equal(comboFromKeyboardEvent({ key: "1" }), "1")
  assert.equal(comboFromKeyboardEvent({ key: "Shift", shiftKey: true }), null)
  assert.equal(comboFromKeyboardEvent({ key: "a", isComposing: true }), null)
})

test("matchesShortcutEvent honors singleKeyEnabled for single keys while always allowing modifier chords", () => {
  assert.equal(matchesShortcutEvent({ key: "d" }, "D", true), true)
  assert.equal(matchesShortcutEvent({ key: "d" }, "D", false), false)
  assert.equal(matchesShortcutEvent({ key: "k", ctrlKey: true }, "Ctrl+K", false), true)
  assert.equal(matchesShortcutEvent({ key: "n", shiftKey: true }, "Shift+N", false), true)
  assert.equal(matchesShortcutEvent({ key: "n", shiftKey: true }, "N", true), true)
  assert.equal(matchesShortcutEvent({ key: "n" }, "", true), false)
  assert.equal(isSingleKeyCombo("D"), true)
  assert.equal(isSingleKeyCombo("Ctrl+K"), false)
})

test("sanitizeShortcutOverrides strips unknown actions, prototype keys, and invalid combos", () => {
  const clean = sanitizeShortcutOverrides({
    newTask: "shift+a",
    search: "",
    closeOverlay: "Q", // non-editable, must be dropped
    __proto__: "Ctrl+Z",
    unknownAction: "X",
    goDashboard: "Escape", // blocked key, must be dropped
    goToday: 123,
  })
  assert.deepEqual(clean, { newTask: "Shift+A", search: "" })
})

test("resolveShortcuts & findShortcutConflicts detect duplicate bindings across editable actions", () => {
  const resolved = resolveShortcuts({ newTask: "D", goToday: "" })
  assert.equal(resolved.newTask, "D")
  assert.equal(resolved.goDashboard, "D")
  assert.equal(resolved.goToday, "")
  assert.equal(resolved.commandPalette, "Ctrl+K")

  const conflicts = findShortcutConflicts(resolved)
  assert.deepEqual(conflicts.get("newTask"), ["goDashboard"])
  assert.deepEqual(conflicts.get("goDashboard"), ["newTask"])
  assert.equal(conflicts.has("goToday"), false)
})

test("formatShortcutKeys formats Ctrl as Ctrl/Cmd for display", () => {
  assert.deepEqual(formatShortcutKeys("Ctrl+Shift+K"), ["Ctrl/Cmd", "Shift", "K"])
  assert.deepEqual(formatShortcutKeys("?"), ["?"])
  assert.deepEqual(formatShortcutKeys(""), [])
})
