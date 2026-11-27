/**
 * Pure date-navigation and optimistic bar-update utilities for the native SVG GANTT view.
 * Decoupled from DOM/SVG so behavior is deterministic and unit-tested.
 *
 * @domain Task Visualization
 */

export type GanttZoomLevel = "Day" | "Week" | "Month"

export interface GanttBarDateTarget {
  id: string
  start: Date
  end: Date
  isComplete: boolean
  isOverdue: boolean
  isMilestone: boolean
  priority: number
  colour: string
  original: {
    start_date?: string | null
    end_date?: string | null
    due_date?: string | null
    color?: string | null
  }
}

export interface BarDateSnapshot {
  start: Date
  end: Date
  isOverdue: boolean
  isMilestone: boolean
  colour: string
  origStartDate: string | null | undefined
  origEndDate: string | null | undefined
  origDueDate: string | null | undefined
}

const PRIORITY_FALLBACK_COLOURS: Record<number, string> = {
  1: "#EF4444",
  2: "#F97316",
  3: "#3B82F6",
  4: "#9CA3AF",
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export function toIsoLocalDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

export function startOfLocalDay(d: Date): Date {
  const c = new Date(d)
  c.setHours(0, 0, 0, 0)
  return c
}

/**
 * Optimistically apply new start/end dates to BOTH the cloned hierarchy bar (if passed)
 * AND the canonical bar inside the master `bars` collection + `bar.original`.
 * Returns a snapshot for instant rollback if the server rejects the write.
 */
export function applyOptimisticBarDates<T extends GanttBarDateTarget>(
  bars: T[],
  barId: string,
  nextStart: Date,
  nextEnd: Date,
  today: Date = startOfLocalDay(new Date()),
  clonedBar?: T,
  fields?: Partial<Pick<GanttBarDateTarget["original"], "start_date" | "end_date" | "due_date">>,
): BarDateSnapshot | null {
  const canonical = bars.find(b => b.id === barId)
  const target = canonical ?? clonedBar
  if (!target) return null

  const snapshot: BarDateSnapshot = {
    start: new Date(target.start),
    end: new Date(target.end),
    isOverdue: target.isOverdue,
    isMilestone: target.isMilestone,
    colour: target.colour,
    origStartDate: target.original.start_date,
    origEndDate: target.original.end_date,
    origDueDate: target.original.due_date,
  }

  const startIso = toIsoLocalDate(nextStart)
  const endIso = toIsoLocalDate(nextEnd)
  const isOverdue = !target.isComplete && startOfLocalDay(nextEnd) < startOfLocalDay(today)
  const isMilestone = startIso === endIso
  const colour = isOverdue
    ? "#EF4444"
    : (target.original.color || PRIORITY_FALLBACK_COLOURS[target.priority] || "var(--accent)")

  const applyTo = (b: T) => {
    b.start = new Date(nextStart)
    b.end = new Date(nextEnd)
    b.isOverdue = isOverdue
    b.isMilestone = isMilestone
    b.colour = colour
    Object.assign(b.original, fields ?? { start_date: startIso, end_date: endIso, due_date: endIso })
  }

  if (canonical) applyTo(canonical)
  if (clonedBar && clonedBar !== canonical) applyTo(clonedBar)
  return snapshot
}

/** Restore a previously captured snapshot if server persistence fails. */
export function rollbackBarDates<T extends GanttBarDateTarget>(
  bars: T[],
  barId: string,
  snapshot: BarDateSnapshot,
  clonedBar?: T,
): void {
  const canonical = bars.find(b => b.id === barId)
  const restore = (b: T) => {
    b.start = new Date(snapshot.start)
    b.end = new Date(snapshot.end)
    b.isOverdue = snapshot.isOverdue
    b.isMilestone = snapshot.isMilestone
    b.colour = snapshot.colour
    b.original.start_date = snapshot.origStartDate ?? null
    b.original.end_date = snapshot.origEndDate ?? null
    b.original.due_date = snapshot.origDueDate ?? null
  }
  if (canonical) restore(canonical)
  if (clonedBar && clonedBar !== canonical) restore(clonedBar)
}

/** Step size in days for Prev/Next toolbar navigation buttons. */
export function getStepDaysForZoom(zoom: GanttZoomLevel): number {
  if (zoom === "Day") return 7
  if (zoom === "Week") return 28
  return 90
}

/** Expansion increment in days when panning near or past the current timeline edges. */
export function getEdgeExpansionDays(zoom: GanttZoomLevel): number {
  if (zoom === "Day") return 30
  if (zoom === "Week") return 60
  return 180
}

/** Generous base padding (days) before earliest and after latest bar so scrolling feels spacious. */
export function getBasePaddingDays(zoom: GanttZoomLevel): { before: number; after: number } {
  if (zoom === "Day") return { before: 21, after: 45 }
  if (zoom === "Week") return { before: 42, after: 84 }
  return { before: 120, after: 240 }
}

/** Format a crisp, compact visible date range label for the Gantt toolbar. */
export function formatVisibleTimelineRange(start: Date, end: Date): string {
  const sy = start.getFullYear()
  const ey = end.getFullYear()
  const sm = SHORT_MONTHS[start.getMonth()] ?? ""
  const em = SHORT_MONTHS[end.getMonth()] ?? ""
  const sd = start.getDate()
  const ed = end.getDate()

  if (sy === ey && start.getMonth() === end.getMonth()) {
    return `${sm} ${sd}–${ed}, ${sy}`
  }
  if (sy === ey) {
    return `${sm} ${sd} – ${em} ${ed}, ${sy}`
  }
  return `${sm} ${sd}, ${sy} – ${em} ${ed}, ${ey}`
}
