import test from "node:test"
import assert from "node:assert/strict"
import {
  CORE_TOUR_STEPS,
  clampTourIndex,
  filterReachableSteps,
  isTourBannerVisible,
  parseTourState,
  transitionTourState,
} from "./tour-steps"

test("parseTourState defaults safely to available", () => {
  assert.equal(parseTourState(null).status, "available")
  assert.equal(parseTourState("not-json").status, "available")
  assert.equal(parseTourState(JSON.stringify({ status: "dismissed", updatedAt: 42 })).status, "dismissed")
})

test("transitionTourState supports dismiss, complete, and restore", () => {
  const dismissed = transitionTourState("dismiss", 100)
  assert.deepEqual(dismissed, { status: "dismissed", updatedAt: 100 })
  assert.equal(isTourBannerVisible(dismissed), false)

  const completed = transitionTourState("complete", 200)
  assert.deepEqual(completed, { status: "completed", updatedAt: 200 })
  assert.equal(isTourBannerVisible(completed), false)

  const restored = transitionTourState("restore", 300)
  assert.deepEqual(restored, { status: "available", updatedAt: 300 })
  assert.equal(isTourBannerVisible(restored), true)
})

test("filterReachableSteps skips targets not present on the current page", () => {
  const found = filterReachableSteps(CORE_TOUR_STEPS, (selector) =>
    selector.includes("#sidebar-user-trigger") || selector.includes("#topbar-search-trigger")
      ? selector
      : null,
  )
  assert.deepEqual(found.map(({ step }) => step.id), ["global-search"])
})

test("clampTourIndex stays within step bounds", () => {
  assert.equal(clampTourIndex(-2, 4), 0)
  assert.equal(clampTourIndex(2, 4), 2)
  assert.equal(clampTourIndex(99, 4), 3)
  assert.equal(clampTourIndex(1, 0), 0)
})
