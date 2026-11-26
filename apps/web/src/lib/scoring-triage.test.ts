import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildTriagePatchPayload,
  computeTriagePreview,
  extractInitialTriageValues,
  extractSprintLabels,
  filterTriageTasks,
  isTaskScoredForFramework,
  type TriageTaskRecord,
} from "./scoring-triage"

const SAMPLE_TASKS: TriageTaskRecord[] = [
  {
    id: "t-1",
    title: "Fix kitchen leak",
    status: "pending",
    urgency: 0,
    importance: 0,
    parent_id: "epic-home",
    project_id: "proj-plumbing",
    area_id: "area-kitchen",
    due_date: "2026-11-26",
    labels: ["sprint-12", "urgent"],
    framework_payload: null,
  },
  {
    id: "t-2",
    title: "Plan solar upgrade",
    status: "active",
    urgency: 2,
    importance: 5,
    parent_id: "epic-energy",
    project_id: "proj-solar",
    area_id: "area-roof",
    due_date: "2026-12-04",
    labels: ["sprint-13"],
    framework_payload: JSON.stringify({ reach: 8, impact: 2, confidence: 80, effort: 4, story_points: 8 }),
  },
  {
    id: "t-3",
    title: "Buy sponges",
    status: "complete",
    urgency: 0,
    importance: 0,
    labels: ["sprint-12"],
  },
  {
    id: "t-4",
    title: "Clean attic",
    status: "backlog",
    urgency: 0,
    importance: 0,
    parent_id: null,
    project_id: null,
    area_id: null,
    due_date: null,
    labels: [],
  },
]

describe("scoring-triage pure domain logic", () => {
  it("computes accurate previews for all 7 frameworks", () => {
    assert.equal(computeTriagePreview("eisenhower", { urgency: 0, importance: 0 }).canSave, false)
    assert.equal(computeTriagePreview("eisenhower", { urgency: 4, importance: 5 }).badgeText, "Do First")
    assert.equal(computeTriagePreview("eisenhower", { urgency: 1, importance: 4 }).badgeText, "Schedule")
    assert.equal(computeTriagePreview("eisenhower", { urgency: 4, importance: 1 }).badgeText, "Delegate")
    assert.equal(computeTriagePreview("eisenhower", { urgency: 1, importance: 1 }).badgeText, "Not Now")

    const rice = computeTriagePreview("rice", { reach: 10, impact: 2, confidence: 80, effort: 4 })
    assert.equal(rice.score, 4)
    assert.equal(rice.badgeText, "RICE 4")

    const drice = computeTriagePreview("drice", { reach: 10, impact: 2, confidence: 80, effort: 4, strategic_alignment: 1.5 })
    assert.equal(drice.score, 6)

    const ice = computeTriagePreview("ice", { ice_impact: 8, ice_confidence: 5, ice_ease: 5 })
    assert.equal(ice.score, 20)

    const wsjf = computeTriagePreview("wsjf", { business_value: 8, time_criticality: 6, risk_reduction: 4, job_size: 3 })
    assert.equal(wsjf.score, 6)

    assert.equal(computeTriagePreview("moscow", { moscow_tier: 0 }).canSave, false)
    assert.equal(computeTriagePreview("moscow", { moscow_tier: 4 }).badgeText, "Must Have")

    assert.equal(computeTriagePreview("story-points", { story_points: 0 }).canSave, false)
    assert.equal(computeTriagePreview("story-points", { story_points: 5 }).badgeText, "5 pts")
  })

  it("filters queues by framework unscored status, epic, project, area, and sprint/cycle", () => {
    const nowMs = Date.parse("2026-11-24T12:00:00Z")

    // Unscored Eisenhower excludes completed (t-3) and already-scored (t-2)
    const eisenhowerQueue = filterTriageTasks(SAMPLE_TASKS, { framework: "eisenhower", unscoredOnly: true, nowMs })
    assert.deepEqual(eisenhowerQueue.map(t => t.id), ["t-1", "t-4"])

    // Unscored Story Points excludes t-2 (has story_points: 8)
    assert.equal(isTaskScoredForFramework(SAMPLE_TASKS[1], "story-points"), true)
    assert.equal(isTaskScoredForFramework(SAMPLE_TASKS[0], "story-points"), false)

    // Filter by Epic
    const epicQueue = filterTriageTasks(SAMPLE_TASKS, { framework: "eisenhower", unscoredOnly: false, epicId: "epic-home", nowMs })
    assert.deepEqual(epicQueue.map(t => t.id), ["t-1"])

    // Filter by Project
    const projectQueue = filterTriageTasks(SAMPLE_TASKS, { framework: "rice", unscoredOnly: false, projectId: "proj-solar", nowMs })
    assert.deepEqual(projectQueue.map(t => t.id), ["t-2"])

    // Filter by Sprint label
    const sprintLabelQueue = filterTriageTasks(SAMPLE_TASKS, { framework: "eisenhower", unscoredOnly: false, sprint: "label:sprint-12", nowMs })
    assert.deepEqual(sprintLabelQueue.map(t => t.id), ["t-1"])

    // Filter by Sprint due window (this-week)
    const thisWeekQueue = filterTriageTasks(SAMPLE_TASKS, { framework: "eisenhower", unscoredOnly: false, sprint: "due:this-week", nowMs })
    assert.deepEqual(thisWeekQueue.map(t => t.id), ["t-1"])

    // Filter by Unscheduled
    const unscheduledQueue = filterTriageTasks(SAMPLE_TASKS, { framework: "eisenhower", unscoredOnly: false, sprint: "due:unscheduled", nowMs })
    assert.deepEqual(unscheduledQueue.map(t => t.id), ["t-4"])
  })

  it("extracts sprint labels prioritizing sprint/cycle tags first", () => {
    const labels = extractSprintLabels(SAMPLE_TASKS)
    assert.deepEqual(labels, ["sprint-12", "sprint-13", "urgent"])
  })

  it("extracts existing values and preserves unrelated framework_payload keys on save", () => {
    const vals = extractInitialTriageValues(SAMPLE_TASKS[1], "rice")
    assert.equal(vals.reach, 8)
    assert.equal(vals.confidence, 80)

    const patch = buildTriagePatchPayload(
      "eisenhower",
      { urgency: 4, importance: 5 },
      { reach: 8, impact: 2, confidence: 80, effort: 4 },
      { storyPoints: 5, effortMinutes: 60, effortType: "deep", delayImpact: "costly", interestTag: "engaging" },
    )
    assert.equal(patch.urgency, 4)
    assert.equal(patch.importance, 5)
    assert.equal(patch.effort_minutes, 60)
    assert.equal(patch.effort_type, "deep")
    const fp = JSON.parse(String(patch.framework_payload))
    assert.equal(fp.reach, 8)
    assert.equal(fp.story_points, 5)
    assert.equal(fp.delay_impact, "costly")
    assert.equal(fp.interest_tag, "engaging")
  })
})
