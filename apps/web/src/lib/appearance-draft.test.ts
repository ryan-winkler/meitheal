import test from "node:test"
import assert from "node:assert/strict"
import {
  cloneAppearanceSnapshot,
  countAppearanceDraftChanges,
  isAppearanceDraftDirty,
  normalizeHexAccent,
  type AppearanceDraftSnapshot,
} from "./appearance-draft"

const baseSnapshot: AppearanceDraftSnapshot = {
  theme: "dark",
  matchHaTheme: false,
  accent: null,
  appearance: {
    font: "sans",
    base: "slate",
    radius: "1",
    width: "default",
    header: "sticky",
    panelStyle: "attached",
  },
}

test("clean snapshot reports 0 changes and not dirty", () => {
  const draft = cloneAppearanceSnapshot(baseSnapshot)
  assert.equal(countAppearanceDraftChanges(baseSnapshot, draft), 0)
  assert.equal(isAppearanceDraftDirty(baseSnapshot, draft), false)
})

test("detects theme, accent (case-insensitive), matchHaTheme, and visual appearance changes", () => {
  const draft = cloneAppearanceSnapshot(baseSnapshot)
  draft.theme = "light"
  draft.accent = "#3B82F6"
  draft.appearance.radius = "0"
  draft.appearance.base = "zinc"

  assert.equal(countAppearanceDraftChanges(baseSnapshot, draft), 4)
  assert.equal(isAppearanceDraftDirty(baseSnapshot, draft), true)

  const sameAccentCase = cloneAppearanceSnapshot(draft)
  sameAccentCase.accent = "#3b82f6"
  assert.equal(countAppearanceDraftChanges(draft, sameAccentCase), 0)
})

test("normalizeHexAccent validates 6-digit hex and rejects malformed values", () => {
  assert.equal(normalizeHexAccent(" #69E3B2 "), "#69e3b2")
  assert.equal(normalizeHexAccent(""), null)
  assert.equal(normalizeHexAccent("red"), null)
  assert.equal(normalizeHexAccent(null), null)
})
