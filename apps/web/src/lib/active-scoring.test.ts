import test from "node:test"
import assert from "node:assert/strict"
import {
  formatEffortMinutes,
  formatEisenhowerShort,
  formatTaskFrameworkScore,
  readTaskStoryPoints,
  resolveActiveScoringFrameworks,
  resolvePrimaryScoringFramework,
} from "./active-scoring"

test("resolveActiveScoringFrameworks respects Simple (empty), ICE/WSJF, and default fallback", () => {
  assert.deepEqual(resolveActiveScoringFrameworks([]), ["rice"])
  assert.deepEqual(resolveActiveScoringFrameworks([{ lenses: [] }]), [])
  assert.equal(resolvePrimaryScoringFramework([]), null)

  const enabled = resolveActiveScoringFrameworks([
    { lenses: [{ lensId: "ice", enabled: true }, { lensId: "rice", enabled: false }] },
    { lenses: [{ lensId: "eisenhower", enabled: true }, { lensId: "story-points", enabled: true }] },
  ])
  assert.deepEqual(enabled, ["ice", "eisenhower", "story-points"])
  assert.equal(resolvePrimaryScoringFramework(enabled), "ice")

  assert.equal(resolvePrimaryScoringFramework(["eisenhower", "story-points"]), "eisenhower")
  assert.equal(resolvePrimaryScoringFramework(["wsjf"]), "wsjf")
})

test("formatTaskFrameworkScore computes dynamic scores across RICE, ICE, WSJF, MoSCoW, Eisenhower, Story Points", () => {
  const ice = formatTaskFrameworkScore(
    { id: "1", title: "A", framework_payload: { ice_impact: 8, ice_confidence: 8, ice_ease: 5 } },
    "ice",
  )
  assert.equal(ice.scored, true)
  assert.equal(ice.numeric, 32)
  assert.equal(ice.display, "32")
  assert.equal(ice.frameworkLabel, "ICE")

  const wsjf = formatTaskFrameworkScore(
    { id: "2", title: "B", framework_payload: { business_value: 8, time_criticality: 6, risk_reduction: 4, job_size: 3 } },
    "wsjf",
  )
  assert.equal(wsjf.scored, true)
  assert.equal(wsjf.numeric, 6)
  assert.equal(wsjf.display, "6")

  const moscow = formatTaskFrameworkScore(
    { id: "3", title: "C", framework_payload: { moscow_tier: 4 } },
    "moscow",
  )
  assert.equal(moscow.display, "Must Have")
  assert.equal(moscow.tone, "danger")

  const unscored = formatTaskFrameworkScore({ id: "4", title: "D", framework_payload: {} }, "wsjf")
  assert.equal(unscored.scored, false)
  assert.equal(unscored.display, "—")
  assert.equal(unscored.numeric, null)
})

test("readTaskStoryPoints, formatEisenhowerShort, and formatEffortMinutes handle valid and empty inputs", () => {
  assert.equal(readTaskStoryPoints({ framework_payload: { story_points: 8 } }), 8)
  assert.equal(readTaskStoryPoints({ framework_payload: JSON.stringify({ story_points: 5 }) }), 5)
  assert.equal(readTaskStoryPoints({ framework_payload: {} }), null)

  assert.deepEqual(formatEisenhowerShort({ urgency: 4, importance: 5 }), { label: "Do First", rank: 4, tone: "danger" })
  assert.deepEqual(formatEisenhowerShort({ urgency: 1, importance: 4 }), { label: "Schedule", rank: 3, tone: "info" })
  assert.deepEqual(formatEisenhowerShort({ urgency: 0, importance: 0 }), { label: "—", rank: 0, tone: "muted" })

  assert.equal(formatEffortMinutes(90), "1h 30m")
  assert.equal(formatEffortMinutes(45), "45m")
  assert.equal(formatEffortMinutes(120), "2h")
  assert.equal(formatEffortMinutes(null), "—")
})
