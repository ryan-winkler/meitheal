import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  applyOptimisticBarDates,
  formatVisibleTimelineRange,
  getBasePaddingDays,
  getEdgeExpansionDays,
  getStepDaysForZoom,
  rollbackBarDates,
  type GanttBarDateTarget,
} from "./gantt-nav-utils"

function makeBar(overrides: Partial<GanttBarDateTarget> = {}): GanttBarDateTarget {
  return {
    id: "task-1",
    start: new Date(2026, 10, 10),
    end: new Date(2026, 10, 14),
    isComplete: false,
    isOverdue: false,
    isMilestone: false,
    priority: 3,
    colour: "#3B82F6",
    original: {
      start_date: "2026-11-10",
      end_date: "2026-11-14",
      due_date: "2026-11-14",
      color: null,
    },
    ...overrides,
  }
}

describe("gantt-nav-utils", () => {
  it("optimistically updates canonical bar, cloned hierarchy bar, and original dates together", () => {
    const canonical = makeBar()
    const cloned: GanttBarDateTarget = { ...canonical }
    const bars = [canonical]
    const today = new Date(2026, 10, 20)

    const snapshot = applyOptimisticBarDates(
      bars,
      "task-1",
      new Date(2026, 10, 22),
      new Date(2026, 10, 26),
      today,
      cloned,
    )

    assert.ok(snapshot)
    assert.equal(canonical.original.start_date, "2026-11-22")
    assert.equal(canonical.original.end_date, "2026-11-26")
    assert.equal(canonical.original.due_date, "2026-11-26")
    assert.equal(canonical.start.getDate(), 22)
    assert.equal(canonical.end.getDate(), 26)
    assert.equal(cloned.start.getDate(), 22)
    assert.equal(canonical.isOverdue, false)
    assert.equal(canonical.isMilestone, false)
  })

  it("recomputes overdue colour and restores cleanly on rollback", () => {
    const canonical = makeBar()
    const bars = [canonical]
    const today = new Date(2026, 10, 20)

    const snapshot = applyOptimisticBarDates(
      bars,
      "task-1",
      new Date(2026, 10, 1),
      new Date(2026, 10, 3),
      today,
    )
    assert.ok(snapshot)
    assert.equal(canonical.isOverdue, true)
    assert.equal(canonical.colour, "#EF4444")

    rollbackBarDates(bars, "task-1", snapshot)
    assert.equal(canonical.original.start_date, "2026-11-10")
    assert.equal(canonical.original.due_date, "2026-11-14")
    assert.equal(canonical.isOverdue, false)
    assert.equal(canonical.colour, "#3B82F6")
  })

  it("formats visible ranges compactly across same-month, same-year, and cross-year windows", () => {
    assert.equal(
      formatVisibleTimelineRange(new Date(2026, 10, 4), new Date(2026, 10, 18)),
      "Nov 4–18, 2026",
    )
    assert.equal(
      formatVisibleTimelineRange(new Date(2026, 10, 20), new Date(2026, 11, 15)),
      "Nov 20 – Dec 15, 2026",
    )
    assert.equal(
      formatVisibleTimelineRange(new Date(2026, 11, 20), new Date(2027, 0, 10)),
      "Dec 20, 2026 – Jan 10, 2027",
    )
  })

  it("provides monotonic zoom step and padding scales", () => {
    assert.ok(getStepDaysForZoom("Day") < getStepDaysForZoom("Week"))
    assert.ok(getStepDaysForZoom("Week") < getStepDaysForZoom("Month"))
    assert.ok(getEdgeExpansionDays("Day") < getEdgeExpansionDays("Month"))
    assert.ok(getBasePaddingDays("Day").before < getBasePaddingDays("Month").before)
  })
})
