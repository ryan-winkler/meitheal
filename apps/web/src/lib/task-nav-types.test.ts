import test from "node:test"
import assert from "node:assert/strict"
import {
  TASK_NAV_TYPES,
  defaultTaskNavPrefs,
  getTaskNavTypeById,
  isTaskNavTypeVisible,
  normalizeTaskNavPrefs,
  setTaskNavMode,
  toggleTaskNavChild,
  toggleTaskNavPin,
} from "./task-nav-types"

test("TASK_NAV_TYPES includes quick_capture with bolt icon and matching kind", () => {
  const quickCapture = getTaskNavTypeById("quick_capture")
  assert.ok(quickCapture, "quick_capture entry must exist in TASK_NAV_TYPES")
  assert.equal(quickCapture.kind, "quick_capture")
  assert.equal(quickCapture.label, "Quick capture")
  assert.equal(quickCapture.icon, "bolt")
  assert.equal(TASK_NAV_TYPES.length, 5)
})

test("defaultTaskNavPrefs enables quick_capture by default", () => {
  const defaults = defaultTaskNavPrefs()
  assert.equal(defaults.mode, "all")
  assert.equal(defaults.visible.quick_capture, true)
  assert.equal(isTaskNavTypeVisible(defaults, "quick_capture"), true)
})

test("normalizeTaskNavPrefs preserves legacy 4-key prefs while defaulting quick_capture to visible", () => {
  const legacy = {
    mode: "custom",
    visible: {
      standard: true,
      shopping_item: false,
      checklist: true,
      calendar_event: false,
    },
    pinned: ["quick_capture", "standard", "unknown_kind", "quick_capture"],
  }
  const normalized = normalizeTaskNavPrefs(legacy)
  assert.equal(normalized.mode, "custom")
  assert.equal(normalized.visible.quick_capture, true)
  assert.equal(normalized.visible.shopping_item, false)
  assert.deepEqual(normalized.pinned, ["quick_capture", "standard"])
})

test("toggleTaskNavChild toggles quick_capture and updates display mode accurately", () => {
  const initial = defaultTaskNavPrefs()
  const hidden = toggleTaskNavChild(initial, "quick_capture")
  assert.equal(hidden.mode, "custom")
  assert.equal(hidden.visible.quick_capture, false)
  assert.equal(isTaskNavTypeVisible(hidden, "quick_capture"), false)

  const restored = toggleTaskNavChild(hidden, "quick_capture")
  assert.equal(restored.mode, "all")
  assert.equal(restored.visible.quick_capture, true)
})

test("setTaskNavMode none/all toggles quick_capture visibility", () => {
  const none = setTaskNavMode(defaultTaskNavPrefs(), "none")
  assert.equal(none.visible.quick_capture, false)
  assert.equal(isTaskNavTypeVisible(none, "quick_capture"), false)

  const all = setTaskNavMode(none, "all")
  assert.equal(all.visible.quick_capture, true)
  assert.equal(isTaskNavTypeVisible(all, "quick_capture"), true)
})

test("toggleTaskNavPin pins and unpins quick_capture", () => {
  const pinned = toggleTaskNavPin(defaultTaskNavPrefs(), "quick_capture")
  assert.deepEqual(pinned.pinned, ["quick_capture"])

  const unpinned = toggleTaskNavPin(pinned, "quick_capture")
  assert.deepEqual(unpinned.pinned, [])
})
