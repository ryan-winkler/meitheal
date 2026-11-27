import test from "node:test"
import assert from "node:assert/strict"
import {
  clampSliderTrackValue,
  getScoringSliderConfig,
  sliderFillPercent,
} from "./rice-slider-config"

test("RICE slider config provides Tabler presets for all four fields", () => {
  const reach = getScoringSliderConfig("rice", "reach")
  assert.ok(reach)
  assert.equal(reach.min, 0)
  assert.equal(reach.max, 100)
  assert.equal(reach.softMax, true)

  const impact = getScoringSliderConfig("rice", "impact")
  assert.ok(impact)
  assert.equal(impact.min, 0.25)
  assert.equal(impact.max, 3)
  assert.equal(impact.step, 0.25)

  const confidence = getScoringSliderConfig("rice", "confidence")
  assert.ok(confidence)
  assert.equal(confidence.min, 0)
  assert.equal(confidence.max, 100)
  assert.equal(confidence.suffix, "%")
  assert.equal(confidence.softMax, false)

  const effort = getScoringSliderConfig("rice", "effort")
  assert.ok(effort)
  assert.equal(effort.min, 0.5)
  assert.equal(effort.max, 20)
  assert.equal(effort.step, 0.5)
})

test("Generic bounded numeric framework fields receive a matching slider config", () => {
  const custom = getScoringSliderConfig("wsjf", "business_value", 1, 10)
  assert.ok(custom)
  assert.equal(custom.min, 1)
  assert.equal(custom.max, 10)
  assert.equal(custom.step, 1)

  const unbounded = getScoringSliderConfig("custom", "unbounded_metric")
  assert.equal(unbounded, null)
})

test("clampSliderTrackValue and sliderFillPercent handle soft-max overflow safely", () => {
  assert.equal(clampSliderTrackValue(500, 0, 100), 100)
  assert.equal(clampSliderTrackValue(-5, 0, 100), 0)
  assert.equal(clampSliderTrackValue("75", 0, 100), 75)
  assert.equal(clampSliderTrackValue("not-a-number", 1, 10), 1)
  assert.equal(sliderFillPercent(50, 0, 100), 50)
  assert.equal(sliderFillPercent(250, 0, 100), 100)
})
