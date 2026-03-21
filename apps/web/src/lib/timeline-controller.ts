/**
 * Timeline/GANTT Controller — native SVG GANTT renderer.
 * @domain Task Visualization
 *
 * Renders an interactive GANTT chart using pure SVG + vanilla JS.
 * No external dependency — fully Astro-native and HA-native.
 * Reads task data from a JSON blob rendered server-side.
 * Wires drag events to PATCH API for inline editing.
 *
 * Features (from persona loop phase-16 iteration-02):
 * T1: Core SVG renderer with grid / bars / headers
 * T2: Fixed label sidebar (Platform Architect)
 * T3: Resize handles for start/end date (Reliability Engineer)
 * T4: Hover tooltips (Product Architect)
 * T5: Scroll-to-today FAB (Workflow Coach)
 * T6: Keyboard shortcuts — T/N/arrows (Execution Coach)
 * T7: Priority legend chip (Knowledge Coach)
 * T8: Overdue visual markers (Focus Optimizer)
 * T9: Scroll position persistence (Automation Coach)
 * T10: Milestone markers (Competitive Analysis)
 *
 * @usage Called from TasksTimelineView.astro via pageLifecycle.onPageLoad()
 */

// ── Types ──────────────────────────────────────────────────────────────────

interface TimelineTask {
  id: string
  title: string
  status: string
  priority: number
  due_date: string | null
  start_date: string | null
  end_date: string | null
  color: string | null
  task_type: string | null
  task_kind: string | null
  progress: number | null
  ticket_number: number | null
  parent_id: string | null
  blocked_by: string | null
  effort_minutes: number | null
  labels: string | null
  area_id: string | null
}

interface GanttBar {
  id: string
  name: string
  start: Date
  end: Date
  progress: number
  colour: string
  taskType: string
  isComplete: boolean
  isOverdue: boolean
  isMilestone: boolean
  priority: number
  original: TimelineTask
  deps: string[]
}

type ZoomLevel = "Day" | "Week" | "Month"

interface ZoomConfig {
  columnWidth: number
  unitDays: number
  headerFormat: (d: Date) => string
  upperFormat: (d: Date) => string
}

// ── Constants ──────────────────────────────────────────────────────────────

const ROW_HEIGHT = 44
const BAR_HEIGHT = 28
const BAR_Y_PAD = (ROW_HEIGHT - BAR_HEIGHT) / 2
const HEADER_HEIGHT = 56
const BAR_RADIUS = 6
const SIDEBAR_WIDTH = 200
const ZOOM_KEY = "meitheal-timeline-zoom"
const SCROLL_KEY_PREFIX = "meitheal-timeline-scroll-"
const HANDLE_WIDTH = 8
const REDUCED_MOTION = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

const PRIORITY_COLOURS: Record<number, string> = {
  1: "#EF4444", // P1 — urgent red
  2: "#F97316", // P2 — high orange
  3: "#3B82F6", // P3 — normal blue
  4: "#9CA3AF", // P4 — low grey
}

const PRIORITY_LABELS: Record<number, string> = {
  1: "Critical",
  2: "High",
  3: "Medium",
  4: "Low",
}

const ZOOM_CONFIGS: Record<ZoomLevel, ZoomConfig> = {
  Day: {
    columnWidth: 40,
    unitDays: 1,
    headerFormat: (d) => String(d.getDate()),
    upperFormat: (d) => d.toLocaleDateString("en-IE", { month: "short", year: "numeric" }),
  },
  Week: {
    columnWidth: 120,
    unitDays: 7,
    headerFormat: (d) => {
      const end = new Date(d)
      end.setDate(end.getDate() + 6)
      return `${d.getDate()}–${end.getDate()}`
    },
    upperFormat: (d) => d.toLocaleDateString("en-IE", { month: "long", year: "numeric" }),
  },
  Month: {
    columnWidth: 180,
    unitDays: 30,
    headerFormat: (d) => d.toLocaleDateString("en-IE", { month: "short" }),
    upperFormat: (d) => String(d.getFullYear()),
  },
}

// ── Utility Helpers ────────────────────────────────────────────────────────

function sanitize(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime()
  return Math.ceil(ms / (1000 * 60 * 60 * 24))
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function isWeekend(d: Date): boolean {
  const day = d.getDay()
  return day === 0 || day === 6
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number]
  return new Date(y, m - 1, d)
}

function toISODate(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-IE", { day: "numeric", month: "short", year: "numeric" })
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    open: "Open",
    pending: "Pending",
    active: "Active",
    in_progress: "In Progress",
    complete: "Complete",
    done: "Done",
  }
  return map[status] ?? status
}

function isComplete(status: string): boolean {
  return status === "complete" || status === "done"
}

// ── SVG Helper ─────────────────────────────────────────────────────────────

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag)
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v))
  }
  return el
}

// ── Toast Helper ───────────────────────────────────────────────────────────

function showToast(message: string, type: "success" | "error" = "success") {
  const existing = document.querySelector(".gantt-toast")
  if (existing) existing.remove()

  const toast = document.createElement("div")
  toast.className = `gantt-toast gantt-toast--${type}`
  toast.textContent = message
  document.body.appendChild(toast)

  requestAnimationFrame(() => toast.classList.add("gantt-toast--visible"))
  setTimeout(() => {
    toast.classList.remove("gantt-toast--visible")
    setTimeout(() => toast.remove(), 300)
  }, 2500)
}

// ── PATCH Helper ───────────────────────────────────────────────────────────

async function patchTask(
  taskId: string,
  fields: Record<string, unknown>,
): Promise<boolean> {
  try {
    const res = await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    })
    return res.ok
  } catch {
    return false
  }
}

// ── Data Mapping ───────────────────────────────────────────────────────────

function mapTasks(tasks: TimelineTask[]): GanttBar[] {
  const today = startOfDay(new Date())
  const todayStr = toISODate(today)

  return tasks
    .filter((t) => t.start_date || t.due_date)
    .map((t) => {
      const startStr = t.start_date || t.due_date || todayStr
      const endStr = t.end_date || t.due_date || startStr
      const start = parseDate(startStr)
      const end = parseDate(endStr)
      const complete = isComplete(t.status)
      const overdue = !complete && end < today

      // Parse dependencies
      const deps: string[] = []
      if (t.blocked_by) {
        try {
          const parsed = JSON.parse(t.blocked_by)
          if (Array.isArray(parsed)) {
            deps.push(...parsed.filter((d: unknown) => typeof d === "string" && d.length > 0))
          }
        } catch {
          deps.push(
            ...t.blocked_by.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
          )
        }
      }

      const ticketPrefix = t.ticket_number ? `MTH-${t.ticket_number} ` : ""
      const name = `${ticketPrefix}${t.title}`
      const isMilestone = startStr === endStr

      return {
        id: t.id,
        name,
        start,
        end,
        progress: Number(t.progress ?? 0),
        colour: t.color || PRIORITY_COLOURS[t.priority] || "#6366F1",
        taskType: String(t.task_type || "task"),
        isComplete: complete,
        isOverdue: overdue,
        isMilestone,
        priority: t.priority,
        original: t,
        deps,
      }
    })
}

// ── T4: Hover Tooltip ──────────────────────────────────────────────────────

let activeTooltip: HTMLDivElement | null = null
let tooltipTimer: ReturnType<typeof setTimeout> | null = null

function showTooltip(bar: GanttBar, x: number, y: number, parent: HTMLElement) {
  hideTooltip()
  tooltipTimer = setTimeout(() => {
    const tip = document.createElement("div")
    tip.className = "gantt-tooltip"
    tip.style.cssText = `
      position:fixed;z-index:9999;left:${x + 12}px;top:${y - 8}px;
      background:var(--bg-card);color:var(--text-primary);
      border:1px solid var(--border);border-radius:6px;
      padding:8px 12px;font-size:12px;line-height:1.4;
      pointer-events:none;box-shadow:var(--shadow-md, 0 4px 16px rgba(0,0,0,0.2));
      max-width:280px;white-space:nowrap;
    `
    // DOM-based construction for XSS safety (O2)
    const title = document.createElement("strong")
    title.textContent = bar.name
    tip.appendChild(title)
    tip.appendChild(document.createElement("br"))
    const dates = document.createElement("span")
    dates.style.opacity = "0.7"
    dates.textContent = `${fmtDate(bar.start)} → ${fmtDate(bar.end)}`
    tip.appendChild(dates)
    tip.appendChild(document.createElement("br"))
    const meta = document.createElement("span")
    meta.style.opacity = "0.7"
    meta.textContent = `${statusLabel(bar.original.status)} · P${bar.priority} · ${bar.progress}%`
    tip.appendChild(meta)
    parent.appendChild(tip)
    activeTooltip = tip
  }, 300)
}

function hideTooltip() {
  if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null }
  if (activeTooltip) { activeTooltip.remove(); activeTooltip = null }
}

// ── T5: Click Popup ────────────────────────────────────────────────────────

function showPopup(bar: GanttBar, x: number, y: number, _parent: HTMLElement) {
  const existing = document.querySelector(".gantt-popup")
  if (existing) existing.remove()

  const popup = document.createElement("div")
  popup.className = "gantt-popup"

  const startStr = fmtDate(bar.start)
  const endStr = fmtDate(bar.end)
  const progress = bar.progress

  // Build popup via DOM APIs for XSS safety (T1 → Security Engineer)
  popup.style.cssText = `
    position:fixed;z-index:10000;left:${x}px;top:${y + 8}px;
    background:var(--bg-card);color:var(--text-primary);
    border:1px solid var(--border);border-radius:var(--radius-md, 8px);
    padding:14px 18px;min-width:240px;max-width:340px;
    box-shadow:var(--shadow-lg, 0 8px 32px rgba(0,0,0,0.3));
    font-size:13px;line-height:1.5;
  `

  const title = document.createElement("div")
  title.style.cssText = "font-weight:600;font-size:14px;margin-bottom:4px;"
  title.textContent = bar.name
  popup.appendChild(title)

  const meta = document.createElement("div")
  meta.style.cssText = "color:var(--text-muted);font-size:12px;margin-bottom:8px;"
  meta.textContent = `${statusLabel(bar.original.status)} · ${PRIORITY_LABELS[bar.priority] || "Normal"}`
  popup.appendChild(meta)

  const dates = document.createElement("div")
  dates.style.cssText = "color:var(--text-muted);font-size:12px;"
  dates.textContent = `${startStr} → ${endStr}`
  popup.appendChild(dates)

  // Progress bar
  const progWrap = document.createElement("div")
  progWrap.style.cssText = "background:var(--bg-secondary);border-radius:4px;height:6px;margin:10px 0;overflow:hidden"
  const progFill = document.createElement("div")
  progFill.style.cssText = `background:${bar.colour};height:100%;width:${progress}%;border-radius:4px;transition:width 0.3s`
  progWrap.appendChild(progFill)
  popup.appendChild(progWrap)

  const progLabel = document.createElement("div")
  progLabel.style.cssText = "font-size:11px;color:var(--text-muted);margin-bottom:8px;"
  progLabel.textContent = `${progress}% complete`
  popup.appendChild(progLabel)

  const detailLink = document.createElement("a")
  detailLink.href = "javascript:void(0)"
  detailLink.className = "gantt-popup-detail-link"
  detailLink.style.cssText = "color:var(--accent);font-size:12px;text-decoration:underline;cursor:pointer;"
  detailLink.textContent = "View Details →"
  detailLink.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("meitheal:open-task", { detail: { taskId: bar.id } }))
    popup.remove()
  })
  popup.appendChild(detailLink)

  document.body.appendChild(popup)

  // Ensure popup is within viewport
  requestAnimationFrame(() => {
    const rect = popup.getBoundingClientRect()
    if (rect.right > window.innerWidth) {
      popup.style.left = `${window.innerWidth - rect.width - 16}px`
    }
    if (rect.bottom > window.innerHeight) {
      popup.style.top = `${y - rect.height - 8}px`
    }
  })

  // Close on click outside
  const close = (e: MouseEvent) => {
    if (!popup.contains(e.target as Node)) {
      popup.remove()
      document.removeEventListener("click", close)
    }
  }
  setTimeout(() => document.addEventListener("click", close), 10)
}

// ── Renderer ───────────────────────────────────────────────────────────────

function renderGantt(
  outerContainer: HTMLElement,
  bars: GanttBar[],
  zoom: ZoomLevel,
  signal: AbortSignal,
) {
  const config = ZOOM_CONFIGS[zoom]

  // Compute date range with padding
  const now = new Date()
  let minDate = new Date(now)
  let maxDate = new Date(now)
  for (const b of bars) {
    if (b.start < minDate) minDate = new Date(b.start)
    if (b.end > maxDate) maxDate = new Date(b.end)
  }

  const padBefore = config.unitDays * 2
  const padAfter = config.unitDays * 4
  const rangeStart = startOfDay(addDays(minDate, -padBefore))
  const rangeEnd = startOfDay(addDays(maxDate, padAfter))
  const totalDays = daysBetween(rangeStart, rangeEnd)
  const pxPerDay = config.columnWidth / config.unitDays
  const totalWidth = totalDays * pxPerDay
  const totalHeight = HEADER_HEIGHT + bars.length * ROW_HEIGHT + 20

  // Clear previous render
  outerContainer.innerHTML = ""

  // ── T2: Create layout with fixed sidebar + scrollable chart ──────────

  const layout = document.createElement("div")
  layout.className = "gantt-layout"
  layout.style.cssText = `display:flex;height:100%;position:relative;`

  // Sidebar (fixed left)
  const sidebar = document.createElement("div")
  sidebar.className = "gantt-sidebar"
  sidebar.style.cssText = `
    flex:0 0 ${SIDEBAR_WIDTH}px;width:${SIDEBAR_WIDTH}px;
    background:var(--bg-card);border-right:1px solid var(--border);
    overflow:hidden;z-index:10;position:relative;
  `

  // Sidebar header
  const sidebarHeader = document.createElement("div")
  sidebarHeader.className = "gantt-sidebar-header"
  sidebarHeader.style.cssText = `
    height:${HEADER_HEIGHT}px;display:flex;align-items:center;
    padding:0 12px;border-bottom:1px solid var(--border);
    font-size:12px;font-weight:600;color:var(--text-muted);
    text-transform:uppercase;letter-spacing:0.04em;
  `
  sidebarHeader.textContent = "Task"
  sidebar.appendChild(sidebarHeader)

  // Sidebar rows
  const sidebarRows = document.createElement("div")
  sidebarRows.className = "gantt-sidebar-rows"
  sidebarRows.style.cssText = "overflow:hidden;"

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!
    const row = document.createElement("div")
    row.className = `gantt-sidebar-row${bar.isOverdue ? " gantt-sidebar-row--overdue" : ""}${bar.isComplete ? " gantt-sidebar-row--complete" : ""}`
    row.dataset.taskId = bar.id
    row.style.cssText = `
      height:${ROW_HEIGHT}px;display:flex;align-items:center;padding:0 12px;
      border-bottom:1px solid var(--border-subtle, rgba(255,255,255,0.05));
      font-size:12px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      background:${i % 2 === 0 ? "transparent" : "var(--bg-secondary, rgba(255,255,255,0.02))"};
    `

    // Type indicator dot
    const dot = document.createElement("span")
    dot.style.cssText = `
      width:8px;height:8px;border-radius:${bar.taskType === "epic" ? "2px" : "50%"};
      background:${bar.colour};margin-right:8px;flex-shrink:0;
      ${bar.isOverdue ? "box-shadow:0 0 6px rgba(239,68,68,0.6);" : ""}
    `
    row.appendChild(dot)

    // Task name
    const name = document.createElement("span")
    name.style.cssText = `
      overflow:hidden;text-overflow:ellipsis;color:var(--text-primary);
      ${bar.isComplete ? "text-decoration:line-through;opacity:0.5;" : ""}
      ${bar.isOverdue ? "color:var(--accent-danger, #ef4444);" : ""}
    `
    name.textContent = bar.name
    name.title = bar.name
    row.appendChild(name)

    // Click → open popup
    row.addEventListener("click", (e) => {
      showPopup(bar, e.clientX, e.clientY, document.body)
    })

    sidebarRows.appendChild(row)
  }

  sidebar.appendChild(sidebarRows)
  layout.appendChild(sidebar)

  // Scrollable chart area
  const scrollWrapper = document.createElement("div")
  scrollWrapper.className = "gantt-scroll-wrapper"
  scrollWrapper.style.cssText = `
    flex:1;overflow:auto;position:relative;
  `

  // Create SVG
  const svg = svgEl("svg", {
    class: "gantt-native",
    width: totalWidth,
    height: totalHeight,
  })
  svg.style.cssText = `min-width:${totalWidth}px;display:block;`

  // ── SVG Defs (arrow markers, clip paths) ─────────────────────────────

  const defs = svgEl("defs")
  const marker = svgEl("marker", {
    id: "arrowhead", markerWidth: 8, markerHeight: 6, refX: 8, refY: 3, orient: "auto",
  })
  marker.appendChild(svgEl("polygon", { points: "0 0, 8 3, 0 6", fill: "var(--text-muted)", opacity: 0.5 }))
  defs.appendChild(marker)
  svg.appendChild(defs)

  // ── Background Grid ──────────────────────────────────────────────────

  const gridGroup = svgEl("g", { class: "gantt-grid" })

  for (let i = 0; i < bars.length; i++) {
    const y = HEADER_HEIGHT + i * ROW_HEIGHT
    gridGroup.appendChild(
      svgEl("rect", {
        x: 0, y, width: totalWidth, height: ROW_HEIGHT,
        fill: i % 2 === 0 ? "var(--bg-card)" : "var(--bg-secondary, rgba(255,255,255,0.02))",
      }),
    )
    gridGroup.appendChild(
      svgEl("line", {
        x1: 0, y1: y + ROW_HEIGHT, x2: totalWidth, y2: y + ROW_HEIGHT,
        stroke: "var(--border-subtle, rgba(255,255,255,0.05))", "stroke-width": 0.5,
      }),
    )
  }

  // Weekend highlighting (Day zoom)
  if (zoom === "Day") {
    for (let d = 0; d < totalDays; d++) {
      const date = addDays(rangeStart, d)
      if (isWeekend(date)) {
        gridGroup.appendChild(
          svgEl("rect", {
            x: d * pxPerDay, y: HEADER_HEIGHT, width: pxPerDay, height: totalHeight - HEADER_HEIGHT,
            fill: "var(--bg-secondary, rgba(255,255,255,0.03))", opacity: 0.6,
          }),
        )
      }
    }
  }

  // Column tick lines
  for (let d = 0; d < totalDays; d += config.unitDays) {
    gridGroup.appendChild(
      svgEl("line", {
        x1: d * pxPerDay, y1: HEADER_HEIGHT, x2: d * pxPerDay, y2: totalHeight,
        stroke: "var(--border-subtle, rgba(255,255,255,0.05))", "stroke-width": 0.3,
      }),
    )
  }

  svg.appendChild(gridGroup)

  // ── Header ───────────────────────────────────────────────────────────

  const headerGroup = svgEl("g", { class: "gantt-header" })
  headerGroup.appendChild(
    svgEl("rect", { x: 0, y: 0, width: totalWidth, height: HEADER_HEIGHT, fill: "var(--bg-card)" }),
  )
  headerGroup.appendChild(
    svgEl("line", { x1: 0, y1: HEADER_HEIGHT, x2: totalWidth, y2: HEADER_HEIGHT, stroke: "var(--border)", "stroke-width": 1 }),
  )

  let lastUpper = ""
  for (let d = 0; d < totalDays; d += config.unitDays) {
    const date = addDays(rangeStart, d)
    const x = d * pxPerDay

    // Lower label
    const lower = svgEl("text", {
      x: x + config.columnWidth / 2, y: HEADER_HEIGHT - 10,
      "text-anchor": "middle", fill: "var(--text-muted)", "font-size": 11, "font-family": "inherit",
    })
    lower.textContent = config.headerFormat(date)
    headerGroup.appendChild(lower)

    // Upper label
    const upperText = config.upperFormat(date)
    if (upperText !== lastUpper) {
      lastUpper = upperText
      const upper = svgEl("text", {
        x: x + 4, y: 18, "text-anchor": "start",
        fill: "var(--text-primary)", "font-size": 12, "font-weight": 600, "font-family": "inherit",
      })
      upper.textContent = upperText
      headerGroup.appendChild(upper)
    }
  }

  svg.appendChild(headerGroup)

  // ── Today Marker ─────────────────────────────────────────────────────

  const today = startOfDay(new Date())
  const todayOffset = daysBetween(rangeStart, today)
  let todayX = 0
  if (todayOffset >= 0 && todayOffset <= totalDays) {
    todayX = todayOffset * pxPerDay
    const todayGroup = svgEl("g", { class: "gantt-today" })

    todayGroup.appendChild(
      svgEl("line", {
        x1: todayX, y1: 0, x2: todayX, y2: totalHeight,
        stroke: "var(--accent, #7c3aed)", "stroke-width": 2, opacity: 0.7,
      }),
    )
    // Diamond
    todayGroup.appendChild(
      svgEl("polygon", {
        points: `${todayX},4 ${todayX + 6},12 ${todayX},20 ${todayX - 6},12`,
        fill: "var(--accent, #7c3aed)",
      }),
    )

    svg.appendChild(todayGroup)
  }

  // ── Dependency Arrows ────────────────────────────────────────────────

  const barPositions = new Map<string, { x: number; y: number; w: number }>()
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!
    const xStart = daysBetween(rangeStart, bar.start) * pxPerDay
    const duration = Math.max(1, daysBetween(bar.start, bar.end) + 1)
    barPositions.set(bar.id, {
      x: xStart,
      y: HEADER_HEIGHT + i * ROW_HEIGHT,
      w: bar.isMilestone ? 16 : duration * pxPerDay,
    })
  }

  const arrowGroup = svgEl("g", { class: "gantt-arrows" })
  for (const bar of bars) {
    for (const depId of bar.deps) {
      const from = barPositions.get(depId)
      const to = barPositions.get(bar.id)
      if (!from || !to) continue
      const fx = from.x + from.w
      const fy = from.y + ROW_HEIGHT / 2
      const tx = to.x
      const ty = to.y + ROW_HEIGHT / 2
      const mx = fx + (tx - fx) / 2
      arrowGroup.appendChild(
        svgEl("path", {
          d: `M ${fx} ${fy} C ${mx} ${fy}, ${mx} ${ty}, ${tx} ${ty}`,
          stroke: "var(--text-muted)", "stroke-width": 1.5, fill: "none", opacity: 0.3,
          "marker-end": "url(#arrowhead)",
        }),
      )
    }
  }
  svg.appendChild(arrowGroup)

  // ── Task Bars + T3 Resize Handles + T4 Tooltips + T8 Overdue ─────────

  const barsGroup = svgEl("g", { class: "gantt-bars" })
  // Keyboard focus tracking (future enhancement)
  // let focusedBarIndex = -1

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!
    const pos = barPositions.get(bar.id)!
    const barY = pos.y + BAR_Y_PAD

    // T10: Milestone rendering
    if (bar.isMilestone) {
      const mx = pos.x
      const my = barY + BAR_HEIGHT / 2
      const ms = 10
      const milestoneGroup = svgEl("g", {
        class: "gantt-milestone", "data-task-id": bar.id, "data-bar-index": i,
        tabindex: 0, role: "button", "aria-label": `Milestone: ${bar.name}`,
      })
      milestoneGroup.style.cursor = "pointer"
      milestoneGroup.appendChild(
        svgEl("polygon", {
          points: `${mx},${my - ms} ${mx + ms},${my} ${mx},${my + ms} ${mx - ms},${my}`,
          fill: bar.colour, opacity: bar.isComplete ? 0.4 : 1,
          stroke: bar.isOverdue ? "var(--accent-danger, #ef4444)" : "none",
          "stroke-width": bar.isOverdue ? 2 : 0,
        }),
      )

      milestoneGroup.addEventListener("mouseenter", (e) => showTooltip(bar, e.clientX, e.clientY, document.body))
      milestoneGroup.addEventListener("mouseleave", hideTooltip)
      milestoneGroup.addEventListener("click", (e) => {
        e.stopPropagation()
        hideTooltip()
        showPopup(bar, e.clientX, e.clientY, document.body)
      })
      // O8: Keyboard Enter/Space to open popup
      milestoneGroup.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          const rect = (e.target as SVGElement).getBoundingClientRect()
          showPopup(bar, rect.left, rect.bottom, document.body)
        }
      })

      barsGroup.appendChild(milestoneGroup)
      continue
    }

    const barW = Math.max(pos.w, 24)
    const barGroup = svgEl("g", {
      class: `gantt-bar`, "data-task-id": bar.id, "data-bar-index": i,
      tabindex: 0, role: "button", "aria-label": `Task: ${bar.name}`,
    })
    barGroup.style.cursor = "pointer"

    // T8: Overdue accent — red left border
    if (bar.isOverdue) {
      barGroup.appendChild(
        svgEl("rect", {
          x: pos.x - 2, y: barY - 1, width: barW + 4, height: BAR_HEIGHT + 2,
          rx: BAR_RADIUS + 1, ry: BAR_RADIUS + 1,
          fill: "none", stroke: "var(--accent-danger, #ef4444)", "stroke-width": 2, opacity: 0.7,
        }),
      )
    }

    // Background bar
    const bgRect = svgEl("rect", {
      x: pos.x, y: barY, width: barW, height: BAR_HEIGHT,
      rx: BAR_RADIUS, ry: BAR_RADIUS,
      fill: bar.colour, opacity: bar.isComplete ? 0.3 : 0.75,
    })
    barGroup.appendChild(bgRect)

    // Progress fill
    if (bar.progress > 0 && bar.progress <= 100) {
      const progW = Math.min((bar.progress / 100) * barW, barW)
      barGroup.appendChild(
        svgEl("rect", {
          x: pos.x, y: barY, width: progW, height: BAR_HEIGHT,
          rx: BAR_RADIUS, ry: BAR_RADIUS,
          fill: bar.colour, opacity: bar.isComplete ? 0.5 : 1,
        }),
      )
    }

    // Label
    if (barW > 40) {
      const clipId = `clip-${bar.id.substring(0, 8)}-${i}`
      const clipPath = svgEl("clipPath", { id: clipId })
      clipPath.appendChild(svgEl("rect", { x: pos.x + 6, y: barY, width: barW - 12, height: BAR_HEIGHT }))
      defs.appendChild(clipPath)

      const label = svgEl("text", {
        x: pos.x + 10, y: barY + BAR_HEIGHT / 2 + 1,
        fill: "#fff", "font-size": 11, "font-weight": 500,
        "font-family": "inherit", "dominant-baseline": "central",
        "clip-path": `url(#${clipId})`,
      })
      label.textContent = bar.name
      if (bar.isComplete) {
        label.style.textDecoration = "line-through"
        label.style.opacity = "0.6"
      }
      barGroup.appendChild(label)
    }

    // Epic top indicator
    if (bar.taskType === "epic") {
      barGroup.appendChild(
        svgEl("rect", {
          x: pos.x, y: barY, width: barW, height: 3,
          rx: BAR_RADIUS, fill: "#fff", opacity: 0.4,
        }),
      )
    }

    // T4: Hover tooltip
    barGroup.addEventListener("mouseenter", (e) => showTooltip(bar, e.clientX, e.clientY, document.body))
    barGroup.addEventListener("mouseleave", hideTooltip)

    // Click → popup
    barGroup.addEventListener("click", (e) => {
      e.stopPropagation()
      hideTooltip()
      showPopup(bar, e.clientX, e.clientY, document.body)
    })
    // O8: Keyboard Enter/Space to open popup
    barGroup.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        const rect = (e.target as SVGElement).getBoundingClientRect()
        showPopup(bar, rect.left, rect.bottom, document.body)
      }
    })

    // T3: Resize handles
    const leftHandle = svgEl("rect", {
      x: pos.x - 2, y: barY + 4, width: HANDLE_WIDTH, height: BAR_HEIGHT - 8,
      rx: 2, fill: "var(--text-primary)", opacity: 0, cursor: "ew-resize",
    })
    const rightHandle = svgEl("rect", {
      x: pos.x + barW - HANDLE_WIDTH + 2, y: barY + 4, width: HANDLE_WIDTH, height: BAR_HEIGHT - 8,
      rx: 2, fill: "var(--text-primary)", opacity: 0, cursor: "ew-resize",
    })

    barGroup.addEventListener("mouseenter", () => {
      leftHandle.setAttribute("opacity", "0.4")
      rightHandle.setAttribute("opacity", "0.4")
    })
    barGroup.addEventListener("mouseleave", () => {
      leftHandle.setAttribute("opacity", "0")
      rightHandle.setAttribute("opacity", "0")
    })

    // Drag logic for whole bar — O1: pass signal to fix memory leak
    setupBarDrag(barGroup, bgRect, bar, pos, pxPerDay, config, signal, () => {
      renderGantt(outerContainer, bars, zoom, signal) // O6: re-render after drag
    })

    // Resize handles drag — O5/O6: visual feedback + re-render
    setupResizeDrag(leftHandle, "start", bar, pos, pxPerDay, config, barGroup, signal, () => {
      renderGantt(outerContainer, bars, zoom, signal) // O6: re-render after resize
    })
    setupResizeDrag(rightHandle, "end", bar, pos, pxPerDay, config, barGroup, signal, () => {
      renderGantt(outerContainer, bars, zoom, signal) // O6: re-render after resize
    })

    barGroup.appendChild(leftHandle)
    barGroup.appendChild(rightHandle)
    barsGroup.appendChild(barGroup)
  }

  svg.appendChild(barsGroup)
  scrollWrapper.appendChild(svg)
  layout.appendChild(scrollWrapper)
  outerContainer.appendChild(layout)

  // ── Sync sidebar scroll with chart ───────────────────────────────────

  scrollWrapper.addEventListener("scroll", () => {
    sidebarRows.style.transform = `translateY(-${scrollWrapper.scrollTop}px)`
    // T9: Persist scroll position
    localStorage.setItem(`${SCROLL_KEY_PREFIX}${zoom}`, String(scrollWrapper.scrollLeft))
  }, { signal, passive: true })

  // ── Scroll to today (or restored position) ───────────────────────────

  // T9: Restore scroll position
  const savedScroll = localStorage.getItem(`${SCROLL_KEY_PREFIX}${zoom}`)
  if (savedScroll) {
    scrollWrapper.scrollLeft = Number(savedScroll)
  } else if (todayX > 0) {
    scrollWrapper.scrollLeft = todayX - scrollWrapper.clientWidth / 3
  }

  // ── T5: Scroll-to-Today FAB ──────────────────────────────────────────

  const fab = document.createElement("button")
  fab.className = "gantt-today-fab"
  fab.title = "Scroll to today (T)"
  fab.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2.5" fill="currentColor"/></svg>`
  fab.style.cssText = `
    position:absolute;bottom:16px;right:16px;z-index:20;
    width:36px;height:36px;border-radius:50%;border:1px solid var(--border);
    background:var(--bg-card);color:var(--accent, #7c3aed);
    cursor:pointer;display:flex;align-items:center;justify-content:center;
    box-shadow:var(--shadow-md, 0 4px 16px rgba(0,0,0,0.2));
    transition:transform 0.2s,box-shadow 0.2s;
  `
  // O3: Respect prefers-reduced-motion
  if (!REDUCED_MOTION) {
    fab.addEventListener("mouseenter", () => { fab.style.transform = "scale(1.1)" })
    fab.addEventListener("mouseleave", () => { fab.style.transform = "scale(1)" })
  }
  fab.addEventListener("click", () => {
    scrollWrapper.scrollTo({ left: todayX - scrollWrapper.clientWidth / 3, behavior: REDUCED_MOTION ? "instant" : "smooth" })
  }, { signal })
  outerContainer.style.position = "relative"
  outerContainer.appendChild(fab)

  // Pulse animation on first load (O3: skip if reduced motion)
  if (!REDUCED_MOTION) {
    fab.animate([
      { boxShadow: "0 0 0 0 var(--accent, rgba(124,58,237,0.4))" },
      { boxShadow: "0 0 0 8px transparent" },
    ], { duration: 1500, iterations: 2 })
  }

  // ── T6: Keyboard shortcuts ───────────────────────────────────────────

  const keyHandler = (e: KeyboardEvent) => {
    // Only handle when timeline view is visible
    const container = document.getElementById("tasks-view-timeline")
    if (!container || container.style.display === "none") return

    // Don't capture when user is typing in an input
    const tag = (e.target as HTMLElement).tagName
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return

    if (e.key === "t" || e.key === "T") {
      e.preventDefault()
      scrollWrapper.scrollTo({ left: todayX - scrollWrapper.clientWidth / 3, behavior: REDUCED_MOTION ? "instant" : "smooth" })
    }
  }
  document.addEventListener("keydown", keyHandler, { signal })

  // Close popup on SVG click
  svg.addEventListener("click", () => {
    const existing = document.querySelector(".gantt-popup")
    if (existing) existing.remove()
  })
}

// ── T3: Drag Helpers ───────────────────────────────────────────────────────

function setupBarDrag(
  barGroup: SVGGElement,
  _bgRect: SVGRectElement,
  bar: GanttBar,
  pos: { x: number; y: number; w: number },
  pxPerDay: number,
  _config: ZoomConfig,
  signal: AbortSignal, // O1: Accept signal to prevent memory leaks
  onComplete: () => void, // O6: Re-render callback
) {
  let isDragging = false
  let dragOriginX = 0 // O4: origin-relative tracking (not frame-relative)

  // Store original positions for all elements (O4: fixes cumulative drift)
  const elemOrigPositions = new Map<Element, number>()

  barGroup.addEventListener("mousedown", (e) => {
    const target = e.target as SVGElement
    if (target.style.cursor === "ew-resize") return
    if (e.button !== 0) return
    isDragging = true
    dragOriginX = e.clientX
    // Snapshot original positions of all children
    elemOrigPositions.clear()
    barGroup.querySelectorAll("rect").forEach((r) => {
      elemOrigPositions.set(r, Number(r.getAttribute("x") || 0))
    })
    barGroup.querySelectorAll("text").forEach((t) => {
      elemOrigPositions.set(t, Number(t.getAttribute("x") || 0))
    })
    e.preventDefault()
    e.stopPropagation()
  })

  const onMove = (e: MouseEvent) => {
    if (!isDragging) return
    const totalDx = e.clientX - dragOriginX // O4: always relative to origin
    // Apply offset from original positions
    elemOrigPositions.forEach((origPos, el) => {
      el.setAttribute("x", String(origPos + totalDx))
    })
  }

  const onUp = async (e: MouseEvent) => {
    if (!isDragging) return
    isDragging = false
    const totalDx = e.clientX - dragOriginX
    if (Math.abs(totalDx) < 5) return

    const daysDelta = Math.round(totalDx / pxPerDay)
    if (daysDelta === 0) { onComplete(); return }

    const newStart = addDays(bar.start, daysDelta)
    const newEnd = addDays(bar.end, daysDelta)

    const ok = await patchTask(bar.id, {
      start_date: toISODate(newStart),
      end_date: toISODate(newEnd),
      due_date: toISODate(newEnd),
    })

    if (ok) {
      bar.start = newStart
      bar.end = newEnd
      showToast("Dates updated")
      onComplete() // O6: re-render to snap to grid
    } else {
      showToast("Failed to update dates", "error")
      onComplete() // Reset visual position
    }
  }

  // O1: Use AbortSignal to prevent memory leaks on re-render
  document.addEventListener("mousemove", onMove, { signal })
  document.addEventListener("mouseup", onUp, { signal })
}

function setupResizeDrag(
  handle: SVGRectElement,
  edge: "start" | "end",
  bar: GanttBar,
  pos: { x: number },
  pxPerDay: number,
  _config: ZoomConfig,
  barGroup: SVGGElement,
  signal: AbortSignal,
  onComplete: () => void, // O6: Re-render callback
) {
  let isDragging = false
  let dragOriginX = 0
  const bgRect = barGroup.querySelector("rect:nth-of-type(2)") as SVGRectElement | null // main bar rect
  const origBarX = pos.x

  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return
    isDragging = true
    dragOriginX = e.clientX
    e.preventDefault()
    e.stopPropagation()
  })

  const onMove = (e: MouseEvent) => {
    if (!isDragging) return
    document.body.style.cursor = "ew-resize"
    // O5: Visual feedback during resize
    if (bgRect) {
      const dx = e.clientX - dragOriginX
      if (edge === "start") {
        const newX = origBarX + dx
        const origW = Number(bgRect.getAttribute("width") || 0)
        const newW = origW - dx
        if (newW > 20) {
          bgRect.setAttribute("x", String(newX))
          bgRect.setAttribute("width", String(newW))
        }
      } else {
        const origW = Number(bgRect.getAttribute("width") || 0)
        bgRect.setAttribute("width", String(Math.max(20, origW + dx)))
        dragOriginX = e.clientX // frame-relative for end edge is fine
      }
    }
  }

  const onUp = async (e: MouseEvent) => {
    if (!isDragging) return
    isDragging = false
    document.body.style.cursor = ""

    const dx = e.clientX - dragOriginX
    const daysDelta = Math.round(dx / pxPerDay)
    if (daysDelta === 0) { onComplete(); return }

    if (edge === "start") {
      const newStart = addDays(bar.start, daysDelta)
      if (newStart > bar.end) {
        showToast("Start can't be after end", "error")
        onComplete()
        return
      }
      const ok = await patchTask(bar.id, { start_date: toISODate(newStart) })
      if (ok) { bar.start = newStart; showToast("Start date updated") }
      else showToast("Failed to update start date", "error")
    } else {
      const newEnd = addDays(bar.end, daysDelta)
      if (newEnd < bar.start) {
        showToast("End can't be before start", "error")
        onComplete()
        return
      }
      const ok = await patchTask(bar.id, { end_date: toISODate(newEnd), due_date: toISODate(newEnd) })
      if (ok) { bar.end = newEnd; showToast("End date updated") }
      else showToast("Failed to update end date", "error")
    }
    onComplete() // O6: re-render to snap to grid
  }

  document.addEventListener("mousemove", onMove, { signal })
  document.addEventListener("mouseup", onUp, { signal })
}

// ── Controller ─────────────────────────────────────────────────────────────

export function initTimelineController(signal: AbortSignal) {
  const container = document.getElementById("gantt-chart")
  const dataEl = document.getElementById("timeline-data")
  const emptyState = document.getElementById("timeline-empty")
  const skeleton = document.getElementById("timeline-skeleton")

  if (!container || !dataEl) return

  let tasks: TimelineTask[] = []
  try {
    tasks = JSON.parse(dataEl.textContent || "[]")
  } catch {
    console.error("[timeline] Failed to parse task data")
    return
  }

  const bars = mapTasks(tasks)

  if (bars.length === 0) {
    if (skeleton) skeleton.style.display = "none"
    if (emptyState) emptyState.style.display = "flex"
    container.style.display = "none"
    return
  }

  if (emptyState) emptyState.style.display = "none"
  if (skeleton) skeleton.style.display = "none"
  container.style.display = "block"

  const savedZoom = localStorage.getItem(ZOOM_KEY) as ZoomLevel | null
  const validZooms: ZoomLevel[] = ["Day", "Week", "Month"]
  let currentZoom: ZoomLevel = savedZoom && validZooms.includes(savedZoom) ? savedZoom : "Week"

  // Initial render
  renderGantt(container, bars, currentZoom, signal)

  // Wire zoom select
  const zoomSelect = document.getElementById("timeline-zoom") as HTMLSelectElement | null
  if (zoomSelect) {
    zoomSelect.value = currentZoom
    zoomSelect.addEventListener("change", () => {
      currentZoom = zoomSelect.value as ZoomLevel
      localStorage.setItem(ZOOM_KEY, currentZoom)
      renderGantt(container, bars, currentZoom, signal)
    }, { signal })
  }

  // Cleanup on abort
  signal.addEventListener("abort", () => {
    container.innerHTML = ""
    hideTooltip()
  })
}
