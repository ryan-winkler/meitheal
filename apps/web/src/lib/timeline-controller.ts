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

interface TimelineFilterState {
  search: string
  status: string
  priority: string
  types: string[]
  area: string
}

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
const ZOOM_ORDER: ZoomLevel[] = ["Day", "Week", "Month"]

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
  // Handle ISO datetime strings (e.g., "2024-03-21T00:00:00Z") by stripping time component
  const dateOnly = s.includes("T") ? s.split("T")[0]! : s
  const parts = dateOnly.split("-")
  if (parts.length < 3) return new Date(s) // fallback to native parsing
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (isNaN(y) || isNaN(m) || isNaN(d)) return new Date(s) // fallback
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

// ── M1: Data-Level Bar Filter ──────────────────────────────────────────────

function filterBars(bars: GanttBar[], filter: TimelineFilterState): GanttBar[] {
  return bars.filter((bar) => {
    // Search (title match)
    if (filter.search) {
      if (!bar.name.toLowerCase().includes(filter.search.toLowerCase())) return false
    }
    // Status
    if (filter.status) {
      if (filter.status === "overdue") {
        if (!bar.isOverdue) return false
      } else {
        if (bar.original.status !== filter.status) return false
      }
    }
    // Priority
    if (filter.priority) {
      if (String(bar.priority) !== filter.priority) return false
    }
    // Types (multi-select)
    if (filter.types.length > 0) {
      if (!filter.types.includes(bar.taskType)) return false
    }
    // Area
    if (filter.area) {
      if (bar.original.area_id !== filter.area) return false
    }
    return true
  })
}

// ── M8: Export as PNG ──────────────────────────────────────────────────────

function exportTimelinePNG(outerContainer: HTMLElement) {
  const svg = outerContainer.querySelector<SVGSVGElement>(".gantt-native")
  const sidebar = outerContainer.querySelector<HTMLElement>(".gantt-sidebar")
  if (!svg) { showToast("Nothing to export", "error"); return }

  const svgRect = svg.getBoundingClientRect()
  const sidebarW = sidebar ? SIDEBAR_WIDTH : 0
  const totalW = sidebarW + svgRect.width
  const totalH = svgRect.height

  const canvas = document.createElement("canvas")
  const scale = 2 // retina
  canvas.width = totalW * scale
  canvas.height = totalH * scale
  const ctx = canvas.getContext("2d")
  if (!ctx) { showToast("Export failed", "error"); return }
  ctx.scale(scale, scale)

  // Fill background
  const bgColor = getComputedStyle(document.documentElement).getPropertyValue("--bg-card").trim() || "#1a1a2e"
  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, totalW, totalH)

  // Draw sidebar text
  if (sidebar) {
    const rows = sidebar.querySelectorAll<HTMLElement>(".gantt-sidebar-row")
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--text-primary").trim() || "#e0e0e0"
    ctx.font = "12px sans-serif"
    rows.forEach((row, i) => {
      const name = row.textContent?.trim() ?? ""
      ctx.fillText(name, 12, HEADER_HEIGHT + i * ROW_HEIGHT + ROW_HEIGHT / 2 + 4, sidebarW - 16)
    })
  }

  // Serialize SVG and draw
  const serializer = new XMLSerializer()
  const svgStr = serializer.serializeToString(svg)
  const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const img = new Image()
  img.onload = () => {
    ctx.drawImage(img, sidebarW, 0, svgRect.width, svgRect.height)
    URL.revokeObjectURL(url)
    // Download
    const a = document.createElement("a")
    const now = new Date()
    a.download = `meitheal-timeline-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}.png`
    a.href = canvas.toDataURL("image/png")
    a.click()
    showToast("Timeline exported")
  }
  img.onerror = () => {
    URL.revokeObjectURL(url)
    showToast("Export failed", "error")
  }
  img.src = url
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
  outerContainer.replaceChildren()

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
      transition:background 0.15s;
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

    // M2: Row cross-highlighting — sidebar → chart
    row.addEventListener("mouseenter", () => {
      const chartRow = svg.querySelector<SVGElement>(`[data-row-id="row-${bar.id}"]`)
      if (chartRow) chartRow.setAttribute("opacity", "0.06")
      row.style.background = "var(--bg-secondary, rgba(255,255,255,0.06))"
    })
    row.addEventListener("mouseleave", () => {
      const chartRow = svg.querySelector<SVGElement>(`[data-row-id="row-${bar.id}"]`)
      if (chartRow) chartRow.setAttribute("opacity", "0")
      row.style.background = i % 2 === 0 ? "transparent" : "var(--bg-secondary, rgba(255,255,255,0.02))"
    })

    // M4: Sidebar click → scroll chart to bar + open popup
    row.addEventListener("click", (e) => {
      e.stopPropagation() // Prevent global task-link handler from intercepting
      e.preventDefault()
      const barPos = barPositions.get(bar.id)
      if (barPos) {
        scrollWrapper.scrollTo({
          left: barPos.x - scrollWrapper.clientWidth / 3,
          behavior: REDUCED_MOTION ? "instant" : "smooth",
        })
      }
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
    // M2: Highlight overlay rect (hidden by default, shown on hover)
    const highlightRect = svgEl("rect", {
      x: 0, y, width: totalWidth, height: ROW_HEIGHT,
      fill: "var(--accent, #7c3aed)", opacity: 0,
      "data-row-id": `row-${bars[i]!.id}`,
      class: "gantt-row-highlight",
    })
    highlightRect.style.transition = "opacity 0.15s"
    highlightRect.style.pointerEvents = "none"
    gridGroup.appendChild(highlightRect)
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

  // ── Today Marker + M3: Today Label ───────────────────────────────────

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
    // M3: Today label
    const todayLabel = svgEl("text", {
      x: todayX, y: HEADER_HEIGHT - 2,
      "text-anchor": "middle", fill: "var(--accent, #7c3aed)",
      "font-size": 10, "font-weight": 700, "font-family": "inherit",
      opacity: 0.9,
    })
    todayLabel.textContent = "Today"
    todayGroup.appendChild(todayLabel)

    svg.appendChild(todayGroup)
  }

  // ── Dependency Arrows ────────────────────────────────────────────────

  const barPositions = new Map<string, { x: number; y: number; w: number }>()
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!
    let xStart = daysBetween(rangeStart, bar.start) * pxPerDay
    const duration = Math.max(1, daysBetween(bar.start, bar.end) + 1)
    let w = bar.isMilestone ? 16 : duration * pxPerDay
    // Guard against NaN from invalid dates
    if (isNaN(xStart)) xStart = 0
    if (isNaN(w)) w = 16
    barPositions.set(bar.id, {
      x: xStart,
      y: HEADER_HEIGHT + i * ROW_HEIGHT,
      w,
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

    // T4: Hover tooltip + M2: cross-highlight from chart → sidebar
    barGroup.addEventListener("mouseenter", (e) => {
      showTooltip(bar, e.clientX, e.clientY, document.body)
      // M2: Highlight matching sidebar row
      const sidebarRow = sidebar.querySelector<HTMLElement>(`.gantt-sidebar-row[data-task-id="${bar.id}"]`)
      if (sidebarRow) sidebarRow.style.background = "var(--bg-secondary, rgba(255,255,255,0.06))"
      // M2: Highlight chart row
      const chartRow = svg.querySelector<SVGElement>(`[data-row-id="row-${bar.id}"]`)
      if (chartRow) chartRow.setAttribute("opacity", "0.06")
    })
    barGroup.addEventListener("mouseleave", () => {
      hideTooltip()
      const sidebarRow = sidebar.querySelector<HTMLElement>(`.gantt-sidebar-row[data-task-id="${bar.id}"]`)
      if (sidebarRow) {
        const idx = Array.from(sidebar.querySelectorAll(".gantt-sidebar-row")).indexOf(sidebarRow)
        sidebarRow.style.background = idx % 2 === 0 ? "transparent" : "var(--bg-secondary, rgba(255,255,255,0.02))"
      }
      const chartRow = svg.querySelector<SVGElement>(`[data-row-id="row-${bar.id}"]`)
      if (chartRow) chartRow.setAttribute("opacity", "0")
    })

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

    // M7: Touch support — map touch events to bar drag
    barGroup.style.touchAction = "none"
    barGroup.setAttribute("style", barGroup.getAttribute("style") + ";touch-action:none")

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
  // DOM-based SVG construction (avoid innerHTML)
  const fabSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  fabSvg.setAttribute("width", "16")
  fabSvg.setAttribute("height", "16")
  fabSvg.setAttribute("viewBox", "0 0 16 16")
  fabSvg.setAttribute("fill", "none")
  const c1 = document.createElementNS("http://www.w3.org/2000/svg", "circle")
  c1.setAttribute("cx", "8"); c1.setAttribute("cy", "8"); c1.setAttribute("r", "7")
  c1.setAttribute("stroke", "currentColor"); c1.setAttribute("stroke-width", "1.5")
  const c2 = document.createElementNS("http://www.w3.org/2000/svg", "circle")
  c2.setAttribute("cx", "8"); c2.setAttribute("cy", "8"); c2.setAttribute("r", "2.5")
  c2.setAttribute("fill", "currentColor")
  fabSvg.appendChild(c1); fabSvg.appendChild(c2)
  fab.appendChild(fabSvg)
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

  // ── T6 + M5 + M6: Keyboard shortcuts ─────────────────────────────────

  let focusedBarIndex = -1
  const focusableBarEls = Array.from(svg.querySelectorAll<SVGGElement>(".gantt-bar, .gantt-milestone"))

  const keyHandler = (e: KeyboardEvent) => {
    // Only handle when timeline view is visible
    const timelineContainer = document.getElementById("tasks-view-timeline")
    if (!timelineContainer || timelineContainer.style.display === "none") return

    // Don't capture when user is typing in an input
    const tag = (e.target as HTMLElement).tagName
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return

    switch (e.key) {
      case "t":
      case "T":
        e.preventDefault()
        scrollWrapper.scrollTo({ left: todayX - scrollWrapper.clientWidth / 3, behavior: REDUCED_MOTION ? "instant" : "smooth" })
        break

      // M5: Arrow key navigation between bars
      case "ArrowDown":
      case "j":
        if (focusableBarEls.length > 0) {
          e.preventDefault()
          focusedBarIndex = Math.min(focusedBarIndex + 1, focusableBarEls.length - 1)
          focusableBarEls[focusedBarIndex]?.focus()
          // Scroll sidebar to keep in view
          const sidebarEl = sidebar.querySelectorAll(".gantt-sidebar-row")[focusedBarIndex] as HTMLElement | undefined
          sidebarEl?.scrollIntoView({ block: "nearest" })
        }
        break
      case "ArrowUp":
      case "k":
        if (focusableBarEls.length > 0) {
          e.preventDefault()
          focusedBarIndex = Math.max(focusedBarIndex - 1, 0)
          focusableBarEls[focusedBarIndex]?.focus()
          const sidebarEl = sidebar.querySelectorAll(".gantt-sidebar-row")[focusedBarIndex] as HTMLElement | undefined
          sidebarEl?.scrollIntoView({ block: "nearest" })
        }
        break
      case "ArrowLeft":
      case "h":
        e.preventDefault()
        scrollWrapper.scrollBy({ left: -120, behavior: REDUCED_MOTION ? "instant" : "smooth" })
        break
      case "ArrowRight":
      case "l":
        e.preventDefault()
        scrollWrapper.scrollBy({ left: 120, behavior: REDUCED_MOTION ? "instant" : "smooth" })
        break

      // M6: Zoom keyboard shortcuts
      case "+":
      case "=":
        e.preventDefault()
        {
          const idx = ZOOM_ORDER.indexOf(zoom)
          if (idx > 0) {
            const newZoom = ZOOM_ORDER[idx - 1]!
            const zoomSelect = document.getElementById("timeline-zoom") as HTMLSelectElement | null
            if (zoomSelect) zoomSelect.value = newZoom
            window.dispatchEvent(new CustomEvent("meitheal:timeline-zoom", { detail: { zoom: newZoom } }))
          }
        }
        break
      case "-":
      case "_":
        e.preventDefault()
        {
          const idx = ZOOM_ORDER.indexOf(zoom)
          if (idx < ZOOM_ORDER.length - 1) {
            const newZoom = ZOOM_ORDER[idx + 1]!
            const zoomSelect = document.getElementById("timeline-zoom") as HTMLSelectElement | null
            if (zoomSelect) zoomSelect.value = newZoom
            window.dispatchEvent(new CustomEvent("meitheal:timeline-zoom", { detail: { zoom: newZoom } }))
          }
        }
        break
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
  let touchDragActive = false

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

  // M7: Touch support for bar drag
  barGroup.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return
    const touch = e.touches[0]!
    isDragging = true
    touchDragActive = true
    dragOriginX = touch.clientX
    elemOrigPositions.clear()
    barGroup.querySelectorAll("rect").forEach((r) => {
      elemOrigPositions.set(r, Number(r.getAttribute("x") || 0))
    })
    barGroup.querySelectorAll("text").forEach((t) => {
      elemOrigPositions.set(t, Number(t.getAttribute("x") || 0))
    })
    e.preventDefault()
  }, { signal, passive: false })

  const onMove = (e: MouseEvent | TouchEvent) => {
    if (!isDragging) return
    const clientX = "touches" in e ? e.touches[0]!.clientX : (e as MouseEvent).clientX
    const totalDx = clientX - dragOriginX // O4: always relative to origin
    // Apply offset from original positions
    elemOrigPositions.forEach((origPos, el) => {
      el.setAttribute("x", String(origPos + totalDx))
    })
  }

  const onUp = async (e: MouseEvent | TouchEvent) => {
    if (!isDragging) return
    isDragging = false
    const isTouch = touchDragActive
    touchDragActive = false
    const clientX = "changedTouches" in e ? e.changedTouches[0]!.clientX : (e as MouseEvent).clientX
    const totalDx = clientX - dragOriginX
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
  // M7: Touch move/end
  document.addEventListener("touchmove", onMove as unknown as EventListener, { signal, passive: false })
  document.addEventListener("touchend", onUp as unknown as EventListener, { signal })
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

  // M7: Touch resize
  handle.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return
    isDragging = true
    dragOriginX = e.touches[0]!.clientX
    e.preventDefault()
    e.stopPropagation()
  }, { signal, passive: false })

  const onMove = (e: MouseEvent | TouchEvent) => {
    if (!isDragging) return
    document.body.style.cursor = "ew-resize"
    const clientX = "touches" in e ? e.touches[0]!.clientX : (e as MouseEvent).clientX
    // O5: Visual feedback during resize
    if (bgRect) {
      const dx = clientX - dragOriginX
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
        dragOriginX = clientX // frame-relative for end edge is fine
      }
    }
  }

  const onUp = async (e: MouseEvent | TouchEvent) => {
    if (!isDragging) return
    isDragging = false
    document.body.style.cursor = ""

    const clientX = "changedTouches" in e ? e.changedTouches[0]!.clientX : (e as MouseEvent).clientX
    const dx = clientX - dragOriginX
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
  // M7: Touch resize events
  document.addEventListener("touchmove", onMove as unknown as EventListener, { signal, passive: false })
  document.addEventListener("touchend", onUp as unknown as EventListener, { signal })
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

  const allBars = mapTasks(tasks)
  let currentFilter: TimelineFilterState = { search: "", status: "", priority: "", types: [], area: "" }

  function getVisibleBars(): GanttBar[] {
    return filterBars(allBars, currentFilter)
  }

  function doRender(zoom: ZoomLevel) {
    const bars = getVisibleBars()
    if (bars.length === 0) {
      if (skeleton) skeleton.style.display = "none"
      if (emptyState) {
        emptyState.style.display = "flex"
        // Customize message if filtering caused empty
        const hasFilters = currentFilter.search || currentFilter.status || currentFilter.priority || currentFilter.types.length > 0 || currentFilter.area
        const title = emptyState.querySelector(".empty-title")
        const desc = emptyState.querySelector(".empty-desc")
        if (hasFilters) {
          if (title) title.textContent = "No tasks match current filters"
          if (desc) desc.textContent = "Adjust your filters to see tasks on the timeline."
        } else {
          if (title) title.textContent = "No tasks on the timeline yet"
          if (desc) {
            desc.replaceChildren()
            desc.append("Add "); const s1 = document.createElement("strong"); s1.textContent = "start dates"; desc.append(s1)
            desc.append(" and "); const s2 = document.createElement("strong"); s2.textContent = "due dates"; desc.append(s2)
            desc.append(" to your tasks to see them here as interactive GANTT bars.")
          }
        }
      }
      container!.style.display = "none"
      return
    }

    if (emptyState) emptyState.style.display = "none"
    container!.style.display = "block"
    renderGantt(container!, bars, zoom, signal)

    // Update signal bar count
    const countEl = document.querySelector("#tasks-view-timeline .signal-bar span")
    if (countEl) {
      countEl.replaceChildren()
      const strong = document.createElement("strong")
      strong.textContent = String(bars.length)
      countEl.append(strong, ` of ${allBars.length} tasks on timeline`)
    }
  }

  if (allBars.length === 0) {
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
  doRender(currentZoom)

  // Wire zoom select
  const zoomSelect = document.getElementById("timeline-zoom") as HTMLSelectElement | null
  if (zoomSelect) {
    zoomSelect.value = currentZoom
    zoomSelect.addEventListener("change", () => {
      currentZoom = zoomSelect.value as ZoomLevel
      localStorage.setItem(ZOOM_KEY, currentZoom)
      doRender(currentZoom)
    }, { signal })
  }

  // M6: Listen for zoom keyboard shortcut dispatches
  window.addEventListener("meitheal:timeline-zoom", ((e: CustomEvent) => {
    const newZoom = e.detail?.zoom as ZoomLevel
    if (newZoom && validZooms.includes(newZoom)) {
      currentZoom = newZoom
      localStorage.setItem(ZOOM_KEY, currentZoom)
      if (zoomSelect) zoomSelect.value = currentZoom
      doRender(currentZoom)
    }
  }) as EventListener, { signal })

  // M1: Listen for unified filter events from FilterToolbar
  // Timeline accepts events from ALL toolbars (table/kanban) since the filter
  // toolbar is shared on the tasks page — no view restriction
  document.addEventListener("meitheal:filter-change", ((e: CustomEvent) => {
    const detail = e.detail ?? {}

    currentFilter = {
      search: detail.search ?? "",
      status: detail.status ?? "",
      priority: detail.priority ?? "",
      types: detail.types ?? [],
      area: detail.area ?? "",
    }
    doRender(currentZoom)
  }) as EventListener, { signal })

  // M1: Also listen for label filter events
  document.addEventListener("meitheal:label-filter", (() => {
    // Label filtering would need bar.original.labels — future enhancement
    // For now, just re-render to stay consistent
    doRender(currentZoom)
  }) as EventListener, { signal })

  // M8: Wire export button
  const exportBtn = document.getElementById("timeline-export-btn")
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      exportTimelinePNG(container)
    }, { signal })
  }

  // Cleanup on abort
  signal.addEventListener("abort", () => {
    container.replaceChildren()
    hideTooltip()
  })
}
