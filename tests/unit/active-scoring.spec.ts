import { expect, test } from "@playwright/test"
import {
  formatEffortMinutes,
  formatEisenhowerShort,
  formatTaskFrameworkScore,
  readTaskStoryPoints,
  resolveActiveScoringFrameworks,
  resolvePrimaryScoringFramework,
} from "../../apps/web/src/lib/active-scoring"

const task = { id: "fixture-task", title: "Schedule the electrician" }

test("unset scoring rules use RICE and the Simple preset has no primary score", () => {
  expect(resolveActiveScoringFrameworks(undefined)).toEqual(["rice"])
  expect(resolveActiveScoringFrameworks([])).toEqual(["rice"])
  const simple = resolveActiveScoringFrameworks([
    { enabled: false, lensIds: ["rice"] },
    { lenses: [{ lensId: "eisenhower", enabled: false }] },
    { lensIds: ["unrecognized"] },
  ])
  expect(simple).toEqual([])
  expect(resolvePrimaryScoringFramework(simple)).toBeNull()
})

test("persisted lens aliases and current rules select scores in canonical display order", () => {
  const active = resolveActiveScoringFrameworks([
    { lensIds: [" Story_Points ", "STORYPOINTS", "WSJF"] },
    { lenses: [{ lensId: "Ice" }, { lensId: " RICE ", enabled: true }, { lensId: "wsjf" }] },
  ])
  expect(active).toEqual(["rice", "ice", "wsjf", "story-points"])
  expect(resolvePrimaryScoringFramework(["story-points", "wsjf", "ice"])).toBe("ice")
})

test("RICE uses canonical percent data and continues displaying a stored score without inputs", () => {
  expect(formatTaskFrameworkScore({
    ...task,
    rice: 20,
    framework_payload: JSON.stringify({ rice: { reach: 10, impact: 3, confidence: 80, effort: 7 } }),
  }, "rice")).toEqual({
    framework: "rice", frameworkLabel: "RICE", display: "3.43", numeric: 3.43, tone: "info", scored: true,
  })

  for (const [rice, tone] of [[8, "danger"], [4, "warning"], [2, "info"], [0, "success"]] as const) {
    expect(formatTaskFrameworkScore({ ...task, rice }, "rice")).toMatchObject({
      display: String(rice), numeric: rice, tone, scored: true,
    })
  }
})

test("RICE suppresses scores for ambiguous legacy confidence and accepts explicitly marked percentages", () => {
  const rice = { reach: 10, impact: 2, confidence: 0.8, effort: 2 }
  expect(formatTaskFrameworkScore({ ...task, rice: 8, framework_payload: { rice } }, "rice")).toEqual({
    framework: "rice", frameworkLabel: "RICE", display: "—", numeric: null, tone: "muted", scored: false,
  })
  expect(formatTaskFrameworkScore({
    ...task, framework_payload: { rice: { ...rice, confidence_unit: "percent" } },
  }, "rice")).toMatchObject({ display: "0.08", numeric: 0.08, tone: "success", scored: true })
})

test("DRICE normalizes fractional confidence, rounds the result, and supplies optional defaults", () => {
  const assessment = { reach: "10", impact: 2, confidence: "0.5", effort: 3, strategic_alignment: 2 }
  expect(formatTaskFrameworkScore({ ...task, framework_payload: assessment }, "drice")).toEqual({
    framework: "drice", frameworkLabel: "DRICE", display: "6.67", numeric: 6.67, tone: "warning", scored: true,
  })
  expect(formatTaskFrameworkScore({
    ...task, framework_payload: { reach: 5, strategic_alignment: 1 },
  }, "drice")).toMatchObject({ display: "2", numeric: 2, tone: "success", scored: true })
  expect(formatTaskFrameworkScore({
    ...task, framework_payload: { reach: 5, strategic_alignment: Infinity },
  }, "drice")).toMatchObject({ numeric: null, scored: false })
})

test("ICE and WSJF distinguish valid low scores from missing required data", () => {
  expect(formatTaskFrameworkScore({
    ...task, framework_payload: { ice_impact: 8, ice_confidence: 8, ice_ease: 5 },
  }, "ice")).toEqual({
    framework: "ice", frameworkLabel: "ICE", display: "32", numeric: 32, tone: "warning", scored: true,
  })
  expect(formatTaskFrameworkScore({
    ...task, framework_payload: { ice_impact: 0, ice_confidence: 0, ice_ease: 0 },
  }, "ice")).toMatchObject({ display: "0.1", numeric: 0.1, tone: "muted", scored: true })
  expect(formatTaskFrameworkScore({
    ...task, framework_payload: { ice_impact: 8, ice_confidence: 8, ice_ease: " " },
  }, "ice")).toMatchObject({ display: "—", numeric: null, scored: false })

  expect(formatTaskFrameworkScore({
    ...task, framework_payload: { business_value: 9, job_size: 3 },
  }, "wsjf")).toEqual({
    framework: "wsjf", frameworkLabel: "WSJF", display: "5.67", numeric: 5.67, tone: "warning", scored: true,
  })
  expect(formatTaskFrameworkScore({
    ...task, framework_payload: { business_value: 9, time_criticality: 1, risk_reduction: 1, job_size: 8 },
  }, "wsjf")).toMatchObject({ numeric: 1.38, tone: "success", scored: true })
  expect(formatTaskFrameworkScore({
    ...task, framework_payload: { business_value: 9, job_size: "unestimated" },
  }, "wsjf")).toMatchObject({ display: "—", numeric: null, scored: false })
})

test("MoSCoW tier, label, and tone stay in sync and unknown tiers remain unscored", () => {
  const tiers = [
    [4, "Must Have", "danger"], [3, "Should Have", "warning"], [2, "Could Have", "info"], [1, "Won't Have", "muted"],
  ] as const
  for (const [tier, display, tone] of tiers) {
    expect(formatTaskFrameworkScore({
      ...task, framework_payload: { moscow_tier: String(tier) },
    }, "moscow")).toEqual({ framework: "moscow", frameworkLabel: "MoSCoW", display, numeric: tier, tone, scored: true })
  }
  expect(formatTaskFrameworkScore({
    ...task, framework_payload: { moscow_tier: 5 },
  }, "moscow")).toMatchObject({ display: "—", numeric: null, scored: false })
})

test("Eisenhower scores current criteria first and preserves legacy quadrant labels", () => {
  expect(formatEisenhowerShort({ urgency: 3, importance: 3 })).toEqual({ label: "Do First", rank: 4, tone: "danger" })
  expect(formatEisenhowerShort({ urgency: 2, importance: 3 })).toEqual({ label: "Schedule", rank: 3, tone: "info" })
  expect(formatEisenhowerShort({ urgency: 3, importance: 2 })).toEqual({ label: "Delegate", rank: 2, tone: "warning" })
  expect(formatEisenhowerShort({ urgency: 1, importance: 2 })).toEqual({ label: "Not Now", rank: 1, tone: "muted" })

  const legacy = { ...task, eisenhower_quadrant: "Q2" }
  expect(formatTaskFrameworkScore(legacy, "eisenhower")).toEqual({
    framework: "eisenhower", frameworkLabel: "Eisenhower", display: "Schedule", numeric: 3, tone: "info", scored: true,
  })
  expect(formatTaskFrameworkScore({ ...legacy, urgency: 4, importance: 3 }, "eisenhower"))
    .toMatchObject({ display: "Do First", numeric: 7, tone: "danger", scored: true })
  expect(["do", "q3", "eliminate"].map(eisenhower_quadrant => formatEisenhowerShort({ eisenhower_quadrant }).rank))
    .toEqual([4, 2, 1])
  expect(formatTaskFrameworkScore(task, "eisenhower")).toMatchObject({ display: "—", numeric: null, scored: false })
})

test("Story Points accept only positive finite values in persisted payloads", () => {
  for (const [points, tone] of [[13, "danger"], [8, "warning"], [3, "info"], [1, "success"]] as const) {
    const record = { ...task, framework_payload: JSON.stringify({ story_points: String(points) }) }
    expect(readTaskStoryPoints(record)).toBe(points)
    expect(formatTaskFrameworkScore(record, "story-points")).toEqual({
      framework: "story-points", frameworkLabel: "Story Points", display: `${points} pts`, numeric: points, tone, scored: true,
    })
  }
  for (const framework_payload of [null, "{", "[8]", "8", { story_points: -1 }, { story_points: "Infinity" }]) {
    expect(readTaskStoryPoints({ framework_payload })).toBeNull()
  }
  expect(formatTaskFrameworkScore(task, "story-points")).toMatchObject({ display: "—", numeric: null, scored: false })
})

test("effort formatting keeps omitted estimates distinct from hours and minutes", () => {
  expect([45, 90, 120, 10.6].map(formatEffortMinutes)).toEqual(["45m", "1h 30m", "2h", "11m"])
  expect([undefined, null, 0, -30, Infinity].map(formatEffortMinutes)).toEqual(["—", "—", "—", "—", "—"])
})
