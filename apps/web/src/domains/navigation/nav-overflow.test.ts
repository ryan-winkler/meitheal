import test from "node:test"
import assert from "node:assert/strict"
import { computeNavOverflow, measureNavOverflowWidth, type NavOverflowItem } from "./nav-overflow"

test("computeNavOverflow keeps all items inline and hides More when they fit", () => {
  const items: NavOverflowItem[] = [
    { id: "dashboard", width: 100, groupIndex: 0 },
    { id: "today", width: 80, groupIndex: 0 },
    { id: "upcoming", width: 95, groupIndex: 0 },
    { id: "boards", width: 90, groupIndex: 1 },
    { id: "settings", width: 90, groupIndex: 2, priority: true },
  ]
  const res = computeNavOverflow({
    items,
    groupGaps: [4, 4, 4],
    availableWidth: 600,
    fixedWidth: 0,
    fixedCount: 0,
    moreWidth: 72,
    containerGap: 8,
  })
  assert.equal(res.showMore, false)
  assert.equal(res.overflowIds.length, 0)
  assert.equal(res.visibleIds.size, 5)
  assert.equal(res.overflowHasPriority, false)
})

test("computeNavOverflow fills bar width before overflowing tail and preserves active priority item", () => {
  const items: NavOverflowItem[] = [
    { id: "dashboard", width: 110, groupIndex: 0 },
    { id: "today", width: 90, groupIndex: 0 },
    { id: "upcoming", width: 105, groupIndex: 0 },
    { id: "tasks", width: 90, groupIndex: 0 },
    { id: "boards", width: 95, groupIndex: 1 },
    { id: "settings", width: 95, groupIndex: 2, priority: true },
  ]
  // Available 430px: More(76) + Settings(95) + Dashboard(110) + Today(90) + gaps fit;
  // Upcoming, Tasks, Boards overflow into More.
  const res = computeNavOverflow({
    items,
    groupGaps: [4, 4, 4],
    availableWidth: 430,
    fixedWidth: 0,
    fixedCount: 0,
    moreWidth: 76,
    containerGap: 8,
  })
  assert.equal(res.showMore, true)
  assert.equal(res.visibleIds.has("settings"), true)
  assert.equal(res.visibleIds.has("dashboard"), true)
  assert.equal(res.visibleIds.has("today"), true)
  assert.deepEqual(res.overflowIds, ["upcoming", "tasks", "boards"])
  assert.equal(res.overflowHasPriority, false)
})

test("computeNavOverflow flags overflowHasPriority when container is too narrow even for priority item", () => {
  const items: NavOverflowItem[] = [
    { id: "dashboard", width: 140, groupIndex: 0 },
    { id: "settings", width: 160, groupIndex: 1, priority: true },
  ]
  const res = computeNavOverflow({
    items,
    groupGaps: [4, 4],
    availableWidth: 100,
    fixedWidth: 0,
    fixedCount: 0,
    moreWidth: 70,
    containerGap: 8,
  })
  assert.equal(res.showMore, true)
  assert.equal(res.visibleIds.size, 0)
  assert.deepEqual(res.overflowIds, ["dashboard", "settings"])
  assert.equal(res.overflowHasPriority, true)
})

test("measureNavOverflowWidth accounts for multi-group gaps accurately without double counting", () => {
  const items: NavOverflowItem[] = [
    { id: "a", width: 50, groupIndex: 0 },
    { id: "b", width: 60, groupIndex: 0 },
    { id: "c", width: 70, groupIndex: 1 },
  ]
  const width = measureNavOverflowWidth(
    {
      items,
      groupGaps: [4, 4],
      availableWidth: 500,
      fixedWidth: 20,
      fixedCount: 1,
      moreWidth: 80,
      containerGap: 10,
    },
    new Set(["a", "b", "c"]),
    false,
  )
  // fixed(20) + group0(50+60+4=114) + group1(70) + containerGaps for 3 groups (2 * 10 = 20) = 224
  assert.equal(width, 224)
})
