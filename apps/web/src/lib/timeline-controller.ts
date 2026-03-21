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
const SIDEBAR_WIDTH = 320
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

function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime()
  return Math.round(ms / (1000 * 60 * 60 * 24))
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

// M3: Track toast timers for cleanup on abort
let toastTimers: ReturnType<typeof setTimeout>[] = []

function showToast(message: string, type: "success" | "error" = "success") {
  const existing = document.querySelector(".gantt-toast")
  if (existing) existing.remove()

  const toast = document.createElement("div")
  toast.className = `gantt-toast gantt-toast--${type}`
  toast.textContent = message
  document.body.appendChild(toast)

  requestAnimationFrame(() => toast.classList.add("gantt-toast--visible"))
  const hideTimer = setTimeout(() => {
    toast.classList.remove("gantt-toast--visible")
    const removeTimer = setTimeout(() => toast.remove(), 300)
    toastTimers.push(removeTimer)
  }, 2500)
  toastTimers.push(hideTimer)
}

function clearToastTimers() {
  toastTimers.forEach(t => clearTimeout(t))
  toastTimers = []
  document.querySelectorAll(".gantt-toast").forEach(t => t.remove())
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
    if (!res.ok) console.warn(`[gantt] PATCH /api/tasks/${taskId} → ${res.status}`)
    return res.ok
  } catch (e) {
    console.warn("[gantt] PATCH failed:", e)
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
        colour: overdue
          ? "#EF4444"
          : (t.color || PRIORITY_COLOURS[t.priority] || "#6366F1"),
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
    // U2: Clamp to viewport
    const clampedX = Math.min(x + 12, window.innerWidth - 300)
    const clampedY = Math.max(y - 8, 8)
    tip.style.cssText = `
      position:fixed;z-index:9999;left:${clampedX}px;top:${clampedY}px;
      background:var(--bg-card);color:var(--text-primary);
      border:1px solid var(--border);border-radius:6px;
      padding:8px 12px;font-size:12px;line-height:1.4;
      pointer-events:none;box-shadow:var(--shadow-md, 0 4px 16px rgba(0,0,0,0.2));
      max-width:min(280px, calc(100vw - 32px));white-space:nowrap;
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

function showPopup(bar: GanttBar, x: number, y: number, _parent: HTMLElement, renderSignal?: AbortSignal) {
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

  // U5: Use button instead of javascript:void(0) link
  const detailLink = document.createElement("button")
  detailLink.type = "button"
  detailLink.className = "gantt-popup-detail-link"
  detailLink.style.cssText = "color:var(--accent);font-size:12px;text-decoration:underline;cursor:pointer;background:none;border:none;padding:0;font-family:inherit;"
  detailLink.textContent = "View Details →"
  detailLink.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("meitheal:open-task", { detail: { taskId: bar.id } }))
    popup.remove()
    cleanupClose()
  })
  popup.appendChild(detailLink)

  document.body.appendChild(popup)

  // Ensure popup is within viewport
  requestAnimationFrame(() => {
    if (!popup.isConnected) return // Guard: popup may have been removed
    const rect = popup.getBoundingClientRect()
    if (rect.right > window.innerWidth) {
      popup.style.left = `${window.innerWidth - rect.width - 16}px`
    }
    if (rect.left < 0) {
      popup.style.left = "16px" // P8: Left-edge clamp
    }
    if (rect.bottom > window.innerHeight) {
      popup.style.top = `${y - rect.height - 8}px`
    }
  })

  // M1: Close on click outside — properly cleaned up
  const cleanupClose = () => {
    document.removeEventListener("click", close)
    document.removeEventListener("keydown", escClose)
  }
  const close = (e: MouseEvent) => {
    if (!popup.contains(e.target as Node)) {
      popup.remove()
      cleanupClose()
    }
  }
  // P8: Escape key also closes popup
  const escClose = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      popup.remove()
      cleanupClose()
    }
  }
  setTimeout(() => {
    document.addEventListener("click", close)
    document.addEventListener("keydown", escClose)
  }, 10)

  // P8: Auto-close popup on re-render (signal aborted)
  renderSignal?.addEventListener("abort", () => {
    popup.remove()
    cleanupClose()
  })
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

// ── Hierarchy: Parent → Child grouping ─────────────────────────────────────

interface HierarchyBar extends GanttBar {
  depth: number
  hasChildren: boolean
  isCollapsed: boolean
}

/** Collapsed parent IDs — persisted in module scope across re-renders */
const collapsedParents = new Set<string>()

/**
 * Build a flat list sorted parent→children with depth levels.
 * Parents appear before their children. Orphan tasks stay at depth 0.
 */
function buildHierarchy(bars: GanttBar[]): HierarchyBar[] {
  // Index: parent_id → children
  const childMap = new Map<string, GanttBar[]>()
  const parentIds = new Set<string>()

  for (const bar of bars) {
    const pid = bar.original.parent_id
    if (pid) {
      if (!childMap.has(pid)) childMap.set(pid, [])
      childMap.get(pid)!.push(bar)
      parentIds.add(pid)
    }
  }

  const result: HierarchyBar[] = []
  const placed = new Set<string>()

  // First pass: place parents then their children
  for (const bar of bars) {
    if (placed.has(bar.id)) continue

    const isParent = parentIds.has(bar.id)
    const isChild = !!bar.original.parent_id

    if (isParent && !isChild) {
      // Top-level parent
      const collapsed = collapsedParents.has(bar.id)
      result.push({ ...bar, depth: 0, hasChildren: true, isCollapsed: collapsed })
      placed.add(bar.id)

      if (!collapsed) {
        const children = childMap.get(bar.id) || []
        for (const child of children) {
          if (placed.has(child.id)) continue
          // Check if child is also a parent (nested hierarchy)
          const childIsParent = parentIds.has(child.id)
          const childCollapsed = collapsedParents.has(child.id)
          result.push({ ...child, depth: 1, hasChildren: childIsParent, isCollapsed: childCollapsed })
          placed.add(child.id)

          // Depth-2 grandchildren
          if (childIsParent && !childCollapsed) {
            const grandchildren = childMap.get(child.id) || []
            for (const gc of grandchildren) {
              if (placed.has(gc.id)) continue
              result.push({ ...gc, depth: 2, hasChildren: false, isCollapsed: false })
              placed.add(gc.id)
            }
          }
        }
      }
    }
  }

  // Second pass: any bars not yet placed (orphans / no parent_id)
  for (const bar of bars) {
    if (placed.has(bar.id)) continue
    result.push({ ...bar, depth: 0, hasChildren: false, isCollapsed: false })
    placed.add(bar.id)
  }

  return result
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

  // C4: Guard against 0-size export (e.g. display:none)
  if (totalW < 1 || totalH < 1) { showToast("Chart not visible — cannot export", "error"); return }

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

// M4: Track per-render AbortController to prevent listener accumulation
let renderAbort: AbortController | null = null

function renderGantt(
  outerContainer: HTMLElement,
  bars: GanttBar[],
  zoom: ZoomLevel,
  _parentSignal: AbortSignal,
) {
  // M4: Abort previous render's listeners before creating new ones
  renderAbort?.abort()
  renderAbort = new AbortController()
  const signal = renderAbort.signal

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

  // Due Date column visibility state
  const DUEDATE_VIS_KEY = "meitheal-gantt-show-duedate"
  let showDueDateCol = true
  try {
    const stored = localStorage.getItem(DUEDATE_VIS_KEY)
    if (stored === "false") showDueDateCol = false
  } catch { /* ignore */ }

  // Sidebar (fixed left)
  const sidebar = document.createElement("div")
  sidebar.className = "gantt-sidebar"
  sidebar.style.cssText = `
    flex:0 0 auto;width:${showDueDateCol ? 320 : 200}px;
    background:var(--bg-card);border-right:1px solid var(--border);
    overflow:hidden;z-index:10;position:relative;
  `

  // Sidebar header — multi-column (Name + Due Date + add-column)
  const sidebarHeader = document.createElement("div")
  sidebarHeader.className = "gantt-sidebar-header"
  sidebarHeader.style.cssText = `
    height:${HEADER_HEIGHT}px;display:flex;align-items:center;
    padding:0 8px;border-bottom:1px solid var(--border);
    font-size:11px;font-weight:600;color:var(--text-muted);
    text-transform:uppercase;letter-spacing:0.04em;
  `

  const nameCol = document.createElement("span")
  nameCol.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
  nameCol.textContent = "Task"
  sidebarHeader.appendChild(nameCol)

  const dueDateCol = document.createElement("span")
  dueDateCol.style.cssText = `flex:0 0 80px;text-align:right;padding-right:4px;cursor:pointer;display:${showDueDateCol ? "" : "none"};`
  dueDateCol.textContent = "Due Date"
  dueDateCol.title = "Click to toggle column"
  dueDateCol.addEventListener("click", (e) => {
    e.stopPropagation()
    showDueDateCol = !showDueDateCol
    try { localStorage.setItem(DUEDATE_VIS_KEY, String(showDueDateCol)) } catch { /* ignore */ }
    renderGantt(outerContainer, bars, zoom, _parentSignal)
  })
  sidebarHeader.appendChild(dueDateCol)

  // Show/hide toggle button when column is hidden
  if (!showDueDateCol) {
    const showBtn = document.createElement("button")
    showBtn.textContent = "⊕"
    showBtn.title = "Show Due Date column"
    showBtn.style.cssText = "background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:0 4px;flex-shrink:0;"
    showBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      showDueDateCol = true
      try { localStorage.setItem(DUEDATE_VIS_KEY, "true") } catch { /* ignore */ }
      renderGantt(outerContainer, bars, zoom, _parentSignal)
    })
    sidebarHeader.appendChild(showBtn)
  }
  sidebar.appendChild(sidebarHeader)

  // Sidebar rows
  const sidebarRows = document.createElement("div")
  sidebarRows.className = "gantt-sidebar-rows"
  sidebarRows.style.cssText = "overflow:hidden;"

  // Build hierarchy for sidebar (parent→child grouping with indentation)
  const hBars = buildHierarchy(bars)

  for (let i = 0; i < hBars.length; i++) {
    const bar = hBars[i]!
    const indentPx = bar.depth * 20
    const row = document.createElement("div")
    row.className = `gantt-sidebar-row${bar.isOverdue ? " gantt-sidebar-row--overdue" : ""}${bar.isComplete ? " gantt-sidebar-row--complete" : ""}${bar.hasChildren ? " gantt-sidebar-row--parent" : ""}`
    row.setAttribute("role", "button")
    row.setAttribute("tabindex", "0")
    row.setAttribute("aria-label", `Navigate to ${bar.name}`)
    row.dataset.taskId = bar.id
    row.style.cssText = `
      height:${ROW_HEIGHT}px;display:flex;align-items:center;padding:0 8px 0 ${8 + indentPx}px;
      border-bottom:1px solid var(--border-subtle, rgba(255,255,255,0.05));
      font-size:12px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      background:${i % 2 === 0 ? "transparent" : "var(--bg-secondary, rgba(255,255,255,0.02))"};
      transition:background 0.15s;
    `

    // Collapse/expand toggle for parent rows
    if (bar.hasChildren) {
      const toggle = document.createElement("button")
      toggle.className = "gantt-sidebar-toggle"
      toggle.setAttribute("aria-label", bar.isCollapsed ? "Expand children" : "Collapse children")
      toggle.setAttribute("tabindex", "-1")
      toggle.style.cssText = `
        width:16px;height:16px;display:flex;align-items:center;justify-content:center;
        background:none;border:none;cursor:pointer;color:var(--text-muted);
        margin-right:4px;flex-shrink:0;padding:0;border-radius:3px;
        transition:transform 0.15s, background 0.15s;
        transform:rotate(${bar.isCollapsed ? "0deg" : "90deg"});
      `
      toggle.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 1.5L7 5L3 8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      toggle.addEventListener("click", (e) => {
        e.stopPropagation()
        e.preventDefault()
        if (collapsedParents.has(bar.id)) {
          collapsedParents.delete(bar.id)
        } else {
          collapsedParents.add(bar.id)
        }
        // Re-render
        renderGantt(outerContainer, bars, zoom, _parentSignal)
      })
      toggle.addEventListener("mouseenter", () => {
        toggle.style.background = "var(--bg-secondary, rgba(255,255,255,0.08))"
      })
      toggle.addEventListener("mouseleave", () => {
        toggle.style.background = "none"
      })
      row.appendChild(toggle)
    } else if (bar.depth > 0) {
      // Spacer for leaf children to align with toggle icons
      const spacer = document.createElement("span")
      spacer.style.cssText = "width:20px;flex-shrink:0;"
      row.appendChild(spacer)
    }

    // Type indicator dot
    const dot = document.createElement("span")
    dot.style.cssText = `
      width:8px;height:8px;border-radius:${bar.taskType === "epic" ? "2px" : "50%"};
      background:${bar.colour};margin-right:8px;flex-shrink:0;
      ${bar.isOverdue ? "box-shadow:0 0 6px rgba(239,68,68,0.6);" : ""}
    `
    row.appendChild(dot)

    // Task name (flex:1 to push due date to the right)
    const name = document.createElement("span")
    name.style.cssText = `
      flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--text-primary);
      ${bar.isComplete ? "text-decoration:line-through;opacity:0.5;" : ""}
      ${bar.isOverdue ? "color:var(--accent-danger, #ef4444);" : ""}
      ${bar.hasChildren ? "font-weight:600;" : ""}
    `
    name.textContent = bar.name
    name.title = bar.name
    row.appendChild(name)

    // Due date column (hidden when column toggled off)
    if (showDueDateCol) {
      const dueCell = document.createElement("span")
      dueCell.style.cssText = `
        flex:0 0 80px;text-align:right;padding-right:4px;
        font-size:11px;white-space:nowrap;
      `
      const dueStr = bar.original.due_date
      if (dueStr) {
        const d = new Date(dueStr)
        const mon = d.toLocaleString("en-US", { month: "short" })
        const day = d.getDate()
        dueCell.textContent = `${mon} ${day}`
        dueCell.style.color = bar.isOverdue ? "var(--accent-danger, #ef4444)" : "var(--text-muted)"
      } else {
        dueCell.textContent = "Schedule"
        dueCell.style.color = "var(--text-muted)"
        dueCell.style.opacity = "0.5"
        dueCell.style.fontStyle = "italic"
        dueCell.style.cursor = "pointer"
        dueCell.title = "Click to schedule this task"
        dueCell.addEventListener("click", (e) => {
          e.stopPropagation()
          import("./task-detail-handoff.js").then((m) => m.openTaskDetailHandoff(bar.id)).catch(() => {})
        })
      }
      row.appendChild(dueCell)
    }

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
      if (barPos && !isNaN(barPos.x)) { // P8: Guard NaN on invalid bar position
        scrollWrapper.scrollTo({
          left: barPos.x - scrollWrapper.clientWidth / 3,
          behavior: REDUCED_MOTION ? "instant" : "smooth",
        })
      }
      showPopup(bar, e.clientX, e.clientY, document.body, signal)
    })

    // P10: Keyboard Enter/Space on sidebar row
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        row.click()
      }
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
    highlightRect.style.pointerEvents = "none"
    gridGroup.appendChild(highlightRect)
    gridGroup.appendChild(
      svgEl("line", {
        x1: 0, y1: y + ROW_HEIGHT, x2: totalWidth, y2: y + ROW_HEIGHT,
        stroke: "var(--border-subtle, rgba(255,255,255,0.05))", "stroke-width": 0.5,
      }),
    )
  }

  // Weekend highlighting (Day + Week zoom)
  if (zoom === "Day" || zoom === "Week") {
    for (let d = 0; d < totalDays; d++) {
      const date = addDays(rangeStart, d)
      if (isWeekend(date)) {
        gridGroup.appendChild(
          svgEl("rect", {
            x: d * pxPerDay, y: HEADER_HEIGHT, width: pxPerDay, height: totalHeight - HEADER_HEIGHT,
            fill: "var(--bg-secondary, rgba(255,255,255,0.06))", opacity: 0.7,
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
  // B3: Center the Today line within its day column (half-day offset)
  const todayX = todayOffset * pxPerDay + pxPerDay / 2
  if (todayOffset >= 0 && todayOffset <= totalDays) {
    const todayGroup = svgEl("g", { class: "gantt-today" })

    todayGroup.appendChild(
      svgEl("line", {
        x1: todayX, y1: 0, x2: todayX, y2: totalHeight,
        stroke: "#EF4444", "stroke-width": 2.5, opacity: 0.85,
      }),
    )
    // Diamond
    todayGroup.appendChild(
      svgEl("polygon", {
        points: `${todayX},4 ${todayX + 6},12 ${todayX},20 ${todayX - 6},12`,
        fill: "#EF4444",
      }),
    )
    // M3: Today label
    const todayLabel = svgEl("text", {
      x: todayX, y: HEADER_HEIGHT - 2,
      "text-anchor": "middle", fill: "#EF4444",
      "font-size": 10, "font-weight": 700, "font-family": "inherit",
      opacity: 0.95,
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
        showPopup(bar, e.clientX, e.clientY, document.body, signal)
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
        fill: "var(--text-on-accent, #fff)", "font-size": 11, "font-weight": 500, // U4: contrast-safe label
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
          rx: BAR_RADIUS, fill: "var(--text-on-accent, #fff)", opacity: 0.4, // P8: contrast-safe
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
      showPopup(bar, e.clientX, e.clientY, document.body, signal)
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

    // M7: Touch support — set touch-action once
    barGroup.style.touchAction = "none"

    barGroup.appendChild(leftHandle)
    barGroup.appendChild(rightHandle)
    barsGroup.appendChild(barGroup)
  }

  svg.appendChild(barsGroup)
  scrollWrapper.appendChild(svg)
  layout.appendChild(scrollWrapper)
  outerContainer.appendChild(layout)

  // ── Sync sidebar scroll with chart ───────────────────────────────────

  // P8: Debounce localStorage writes to avoid performance hit during fast scroll
  let scrollSaveTimer: ReturnType<typeof setTimeout> | null = null
  scrollWrapper.addEventListener("scroll", () => {
    sidebarRows.style.transform = `translateY(-${scrollWrapper.scrollTop}px)`
    // T9: Persist scroll position (debounced)
    if (scrollSaveTimer) clearTimeout(scrollSaveTimer)
    scrollSaveTimer = setTimeout(() => {
      localStorage.setItem(`${SCROLL_KEY_PREFIX}${zoom}`, String(scrollWrapper.scrollLeft))
    }, 150)
  }, { signal, passive: true })

  // P8: Cancel scroll timer on render abort
  signal.addEventListener("abort", () => {
    if (scrollSaveTimer) { clearTimeout(scrollSaveTimer); scrollSaveTimer = null }
  })

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

  // B7: Wire up toolbar "Scroll to Today" button
  const scrollTodayBtn = document.getElementById("timeline-scroll-today")
  if (scrollTodayBtn) {
    scrollTodayBtn.addEventListener("click", () => {
      scrollWrapper.scrollTo({ left: todayX - scrollWrapper.clientWidth / 3, behavior: REDUCED_MOTION ? "instant" : "smooth" })
    }, { signal })
  }

  // Pulse animation on first load (O3: skip if reduced motion)
  if (!REDUCED_MOTION) {
    fab.animate([
      { boxShadow: "0 0 0 0 var(--accent, rgba(124,58,237,0.4))" },
      { boxShadow: "0 0 0 8px transparent" },
    ], { duration: 1500, iterations: 2 })
  }

  // ── T6 + M5 + M6: Keyboard shortcuts ─────────────────────────────────

  let focusedBarIndex = -1 // P8: Reset per render cycle
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

  // Close popup on SVG click — also cleanup close listeners
  svg.addEventListener("click", () => {
    document.querySelectorAll(".gantt-popup").forEach(p => p.remove())
  })
}

// ── T3: Drag Helpers ───────────────────────────────────────────────────────

function setupBarDrag(
  barGroup: SVGGElement,
  _bgRect: SVGRectElement,
  bar: GanttBar,
  _pos: { x: number; y: number; w: number },
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

  // M7: Touch support for bar drag
  barGroup.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return
    const touch = e.touches[0]!
    isDragging = true
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
    // C2: Guard against empty touches (e.g. touchend fires with empty touches array)
    if ("touches" in e && (!e.touches || e.touches.length === 0)) return
    const clientX = "touches" in e ? e.touches[0]!.clientX : (e as MouseEvent).clientX
    const totalDx = clientX - dragOriginX // O4: always relative to origin
    // U1: Show grab cursor during drag
    document.body.style.cursor = "grabbing"
    // Apply offset from original positions
    elemOrigPositions.forEach((origPos, el) => {
      el.setAttribute("x", String(origPos + totalDx))
    })
  }

  const onUp = async (e: MouseEvent | TouchEvent) => {
    if (!isDragging) return
    isDragging = false
    document.body.style.cursor = "" // U1: Reset cursor
    // C1: Guard against empty changedTouches (multi-touch cancel)
    if ("changedTouches" in e && (!e.changedTouches || e.changedTouches.length === 0)) {
      onComplete(); return
    }
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
  let origBarW = 0 // C3: captured at drag start for origin-relative calc

  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return
    isDragging = true
    dragOriginX = e.clientX
    origBarW = Number(bgRect?.getAttribute("width") || 0) // C3: snapshot width at start
    e.preventDefault()
    e.stopPropagation()
  })

  // M7: Touch resize
  handle.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return
    isDragging = true
    dragOriginX = e.touches[0]!.clientX
    origBarW = Number(bgRect?.getAttribute("width") || 0) // C3: snapshot width at start
    e.preventDefault()
    e.stopPropagation()
  }, { signal, passive: false })

  const onMove = (e: MouseEvent | TouchEvent) => {
    if (!isDragging) return
    // C2: Guard against empty touches
    if ("touches" in e && (!e.touches || e.touches.length === 0)) return
    document.body.style.cursor = "ew-resize"
    const clientX = "touches" in e ? e.touches[0]!.clientX : (e as MouseEvent).clientX
    // O5/C3: Visual feedback during resize — origin-relative calc
    if (bgRect) {
      const dx = clientX - dragOriginX
      if (edge === "start") {
        const newX = origBarX + dx
        const newW = origBarW - dx // C3: use snapshotted width, not stale DOM
        if (newW > 20) {
          bgRect.setAttribute("x", String(newX))
          bgRect.setAttribute("width", String(newW))
        }
      } else {
        const newW = origBarW + dx // C3: origin-relative for end edge too
        bgRect.setAttribute("width", String(Math.max(20, newW)))
      }
    }
  }

  const onUp = async (e: MouseEvent | TouchEvent) => {
    if (!isDragging) return
    isDragging = false
    document.body.style.cursor = ""

    // C1: Guard against empty changedTouches
    if ("changedTouches" in e && (!e.changedTouches || e.changedTouches.length === 0)) {
      onComplete(); return
    }
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

    // Update signal bar count — P8: aria-live for screen readers
    const countEl = document.querySelector("#tasks-view-timeline .signal-bar span")
    if (countEl) {
      countEl.setAttribute("aria-live", "polite")
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
    renderAbort?.abort() // M4: Clean up per-render listeners
    renderAbort = null
    container.replaceChildren()
    hideTooltip()
    clearToastTimers() // M3: Clean up toast timers
  })
}
