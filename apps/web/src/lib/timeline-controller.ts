import { InlineDatePicker } from "../components/shared/InlineDatePicker"
import { getSelectedAreaId, initAreaSelector } from "@lib/area-selector-controller"
import { hasPriorityOverlay } from "@lib/layout-shortcuts-controller"
import { isDisabledCharacterShortcut } from "@lib/single-key-shortcuts"
import { createClientLogger } from "@lib/client-logger"
import { FieldPickerPanel, TASK_FIELD_DEFS, loadVisibleFields } from "./field-picker-panel"
import { loadFilterState } from "./filter-state"
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

const ganttLog = createClientLogger("timeline", "gantt")

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
  project_id: string | null
  assigned_to: string | null
  deferred_at: number | null
  is_overdue: boolean
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
  groupBy: string
}

interface ZoomConfig {
  columnWidth: number
  unitDays: number
  headerFormat: (d: Date) => string
  upperFormat: (d: Date) => string
}

// ── Area/Project name lookups (populated from SSR data) ──────────────────
let areaLookup: Record<string, string> = {}
let projectLookup: Record<string, string> = {}

// ── Unscheduled section collapse state ─────────────────────────────────────
const UNSCHEDULED_COLLAPSED_KEY = "meitheal-gantt-unscheduled-collapsed"
let unscheduledCollapsed = false
try { unscheduledCollapsed = localStorage.getItem(UNSCHEDULED_COLLAPSED_KEY) === "true" } catch { /* ignore */ }

// ── Constants ──────────────────────────────────────────────────────────────

const ROW_HEIGHT = 44
const BAR_HEIGHT = 28
const BAR_Y_PAD = (ROW_HEIGHT - BAR_HEIGHT) / 2
const HEADER_HEIGHT = 56
const BAR_RADIUS = 6
const BASE_SIDEBAR_WIDTH = 200
const FIELD_COL_WIDTH = 80
const ZOOM_KEY = "meitheal-timeline-zoom"
const SCROLL_KEY_PREFIX = "meitheal-timeline-scroll-"
const HANDLE_WIDTH = 8
const REDUCED_MOTION = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
const ZOOM_ORDER: ZoomLevel[] = ["Day", "Week", "Month"]

/** Currently visible field IDs — drives sidebar column rendering */
let visibleFields: Set<string> = loadVisibleFields("timeline", TASK_FIELD_DEFS)

/** Compute sidebar width from visible field count */
function sidebarWidth(): number {
  return BASE_SIDEBAR_WIDTH + visibleFields.size * FIELD_COL_WIDTH
}

let showSidebar = true
try {
  const sidebarStored = typeof window !== "undefined" ? localStorage.getItem("meitheal-gantt-show-sidebar") : null
  if (sidebarStored === "false") showSidebar = false
} catch { /* ignore */ }

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

let activeDropdownController: AbortController | null = null

function createDropdown(
  triggerBtn: HTMLElement,
  align: "left" | "right",
  buildMenu: (menu: HTMLElement, closeCb: () => void) => void
) {
  // Clear any existing menu to prevent listeners leaking
  if (activeDropdownController) {
    activeDropdownController.abort()
    activeDropdownController = null
  }
  const existing = document.querySelector(".gantt-col-menu")
  if (existing) {
    const isSameTrigger = existing.getAttribute("data-gantt-trigger") === triggerBtn.dataset.ganttTriggerId
    existing.remove()
    if (isSameTrigger) return // Toggle off
  }

  // Assign a trigger ID so toggle-off detection works with body-appended menus
  if (!triggerBtn.dataset.ganttTriggerId) {
    triggerBtn.dataset.ganttTriggerId = String(Date.now())
  }

  const rect = triggerBtn.getBoundingClientRect()
  const menu = document.createElement("div")
  menu.className = "gantt-col-menu"
  menu.setAttribute("data-gantt-trigger", triggerBtn.dataset.ganttTriggerId)
  menu.style.cssText = `
    position:fixed;top:${rect.bottom + 4}px;
    ${align === "right" ? `right:${window.innerWidth - rect.right}px` : `left:${rect.left}px`};
    background:var(--bg-card);border:1px solid var(--border);border-radius:6px;
    padding:4px 0;box-shadow:0 4px 12px rgba(0,0,0,0.3);z-index:9999;min-width:140px;
  `

  activeDropdownController = new AbortController()

  const closeMenu = () => {
    if (activeDropdownController) {
      activeDropdownController.abort()
      activeDropdownController = null
    }
    menu.remove()
  }

  buildMenu(menu, closeMenu)

  // Close on outside click
  const onBodyClick = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node) && !triggerBtn.contains(ev.target as Node)) {
      closeMenu()
    }
  }
  setTimeout(() => document.addEventListener("click", onBodyClick, { signal: activeDropdownController!.signal }), 0)
  
  document.body.appendChild(menu)
}

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

/** Snap a date backward to the nearest zoom-unit boundary */
function alignToUnit(d: Date, zoom: ZoomLevel): Date {
  const s = startOfDay(d)
  if (zoom === "Week") {
    // Align to Monday (getDay: 0=Sun)
    const day = s.getDay()
    const diff = day === 0 ? 6 : day - 1 // days since Monday
    s.setDate(s.getDate() - diff)
  } else if (zoom === "Month") {
    s.setDate(1)
  }
  return s
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
    if (!res.ok) ganttLog.warn(`PATCH /api/tasks/${taskId} → ${res.status}`)
    return res.ok
  } catch (e) {
    ganttLog.warn("PATCH failed:", e)
    return false
  }
}

// ── Data Mapping ───────────────────────────────────────────────────────────

interface MapTasksResult {
  dated: GanttBar[]
  undated: TimelineTask[]
}

function mapTasks(tasks: TimelineTask[]): MapTasksResult {
  const today = startOfDay(new Date())
  const todayStr = toISODate(today)

  const dated: GanttBar[] = []
  const undated: TimelineTask[] = []

  for (const t of tasks) {
    if (!t.start_date && !t.due_date) {
      // Only include non-complete undated tasks
      if (!isComplete(t.status)) undated.push(t)
      continue
    }

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

    dated.push({
      id: t.id,
      name,
      start,
      end,
      progress: Number(t.progress ?? 0),
      colour: overdue
        ? "#EF4444"
        : (t.color || PRIORITY_COLOURS[t.priority] || "var(--accent)"),
      taskType: String(t.task_type || "task"),
      isComplete: complete,
      isOverdue: overdue,
      isMilestone,
      priority: t.priority,
      original: t,
      deps,
    })
  }

  return { dated, undated }
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
  // Also cleans up click/keydown listeners as a safety net against leaks
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
      const kind = bar.original.task_kind || "standard_action"
      if (!filter.types.includes(kind)) return false
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
  isGroupHeader?: boolean
}

/** Collapsed parent IDs — persisted in module scope across re-renders */
const collapsedParents = new Set<string>()

/**
 * Build a flat list sorted parent→children with depth levels.
 * Parents appear before their children. Orphan tasks stay at depth 0.
 */
function buildHierarchy(bars: GanttBar[], groupByKey: string = "none"): HierarchyBar[] {
  if (["status", "priority", "project", "area", "assignee", "assigned", "type"].includes(groupByKey)) {
    const groupKey = groupByKey
    
    // Group bars
    const grouped = new Map<string, GanttBar[]>()
    for (const bar of bars) {
      let val = "Uncategorized"
      if (groupKey === "status") val = bar.original.status || "Uncategorized"
      else if (groupKey === "priority") {
        const labels = ["None", "Critical", "High", "Medium", "Low"]
        val = labels[bar.priority] || `Priority ${bar.priority}`
      }
      else if (groupKey === "project") {
        const rawId = bar.original.project_id || ""
        val = rawId ? (projectLookup[rawId] || "Unknown Project") : "No Project"
      }
      else if (groupKey === "area") {
        const rawId = bar.original.area_id || "default"
        val = areaLookup[rawId] || "Unknown Area"
      }
      else if (groupKey === "assignee" || groupKey === "assigned") val = bar.original.assigned_to || "Unassigned"
      else if (groupKey === "type") {
        const kind = bar.original.task_kind || bar.original.task_type || "standard_action"
        const kindLabels: Record<string, string> = {
          standard_action: "Task", routine: "Routine", shopping_item: "Shopping",
          calendar_event: "Event",
        }
        val = kindLabels[kind] || kind
      }
      
      if (!grouped.has(val)) grouped.set(val, [])
      grouped.get(val)!.push(bar)
    }

    // Sort group keys
    const sortedKeys = Array.from(grouped.keys()).sort((a,b) => a.localeCompare(b))
    
    const result: HierarchyBar[] = []
    for (const key of sortedKeys) {
      const gBars = grouped.get(key)!
      // Add fake header
      const headerId = `group-${key}`
      const collapsed = collapsedParents.has(headerId)
      
      result.push({
        id: headerId,
        name: key,
        start: new Date(), end: new Date(),
        progress: 0, colour: "transparent", taskType: "group",
        isComplete: false, isOverdue: false, isMilestone: false, priority: 0,
        original: {} as any, deps: [],
        depth: 0, hasChildren: true, isCollapsed: collapsed, isGroupHeader: true
      })
      
      if (!collapsed) {
        gBars.forEach(b => {
          result.push({ ...b, depth: 1, hasChildren: false, isCollapsed: false })
        })
      }
    }
    return result
  }

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
  const scrollWrapper = outerContainer.querySelector<HTMLElement>(".gantt-scroll-wrapper")
  const headerOverlay = outerContainer.querySelector<HTMLElement>(".gantt-header-overlay")
  const headerSvg = outerContainer.querySelector<SVGSVGElement>(".gantt-header-svg")
  if (!svg || !scrollWrapper) { showToast("Nothing to export", "error"); return }

  // Use visible viewport dimensions, not full SVG size
  const visibleW = scrollWrapper.clientWidth
  const visibleH = scrollWrapper.clientHeight
  const scrollLeft = scrollWrapper.scrollLeft
  const scrollTop = scrollWrapper.scrollTop
  const sidebarW = sidebar && sidebar.style.display !== "none" ? sidebarWidth() : 0
  const headerH = headerOverlay ? headerOverlay.clientHeight : 0
  const totalW = sidebarW + visibleW
  const totalH = headerH + visibleH

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

  // Draw sidebar text (visible rows only — rowY computed from virtualized data-row-index)
  if (sidebar && sidebar.style.display !== "none") {
    const rows = sidebar.querySelectorAll<HTMLElement>(".gantt-sidebar-row")
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--text-primary").trim() || "#e0e0e0"
    ctx.font = "12px sans-serif"
    rows.forEach((row, fallbackIdx) => {
      const rowIndex = Number(row.dataset.rowIndex ?? fallbackIdx)
      const rowY = headerH + rowIndex * ROW_HEIGHT - scrollTop
      if (rowY + ROW_HEIGHT < 0 || rowY > totalH) return // skip offscreen rows
      const titleEl = row.querySelector<HTMLElement>(".gantt-sidebar-row-title")
      const name = (titleEl?.textContent ?? row.textContent ?? "").trim()
      ctx.fillText(name, 12, rowY + ROW_HEIGHT / 2 + 4, sidebarW - 16)
    })
  }

  // Clone SVG for export with clipped viewBox matching visible area
  const svgClone = svg.cloneNode(true) as SVGSVGElement
  svgClone.setAttribute("viewBox", `${scrollLeft} ${scrollTop} ${visibleW} ${visibleH}`)
  svgClone.setAttribute("width", String(visibleW))
  svgClone.setAttribute("height", String(visibleH))

  // If we have a frozen header, draw it first
  const serializer = new XMLSerializer()
  let drawChain = Promise.resolve()

  if (headerSvg) {
    const hClone = headerSvg.cloneNode(true) as SVGSVGElement
    // Clip header to visible horizontal range
    hClone.setAttribute("viewBox", `${scrollLeft} 0 ${visibleW} ${headerH}`)
    hClone.setAttribute("width", String(visibleW))
    hClone.setAttribute("height", String(headerH))
    const hStr = serializer.serializeToString(hClone)
    const hBlob = new Blob([hStr], { type: "image/svg+xml;charset=utf-8" })
    const hUrl = URL.createObjectURL(hBlob)
    drawChain = drawChain.then(() => new Promise<void>((resolve) => {
      const hImg = new Image()
      hImg.onload = () => {
        ctx.drawImage(hImg, sidebarW, 0, visibleW, headerH)
        URL.revokeObjectURL(hUrl)
        resolve()
      }
      hImg.onerror = () => { URL.revokeObjectURL(hUrl); resolve() }
      hImg.src = hUrl
    }))
  }

  // Draw the body SVG clipped to visible area
  const svgStr = serializer.serializeToString(svgClone)
  const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  drawChain.then(() => {
    const img = new Image()
    img.onload = () => {
      ctx.drawImage(img, sidebarW, headerH, visibleW, visibleH)
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
  })
}

// ── Renderer ───────────────────────────────────────────────────────────────

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function fastShortDate(d: Date): string {
  return `${d.getDate()} ${SHORT_MONTHS[d.getMonth()] ?? ""}`
}

function fastIsoShortDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) {
    const dt = parseDate(iso)
    return dt ? fastShortDate(dt) : "—"
  }
  const day = Number(m[3])
  const monthIdx = Number(m[2]) - 1
  return `${day} ${SHORT_MONTHS[monthIdx] ?? ""}`
}

type TimelineDisplayRow =
  | { kind: "group"; rowIndex: number; bar: HierarchyBar }
  | { kind: "bar"; rowIndex: number; bar: HierarchyBar }
  | { kind: "divider"; rowIndex: number; count: number }
  | { kind: "unscheduled"; rowIndex: number; task: TimelineTask; unscheduledIndex: number }

interface MountedTimelineRow {
  sidebarEl: HTMLElement
  svgEl: SVGGElement | null
  cleanup?: (() => void) | undefined
}

interface DependencyEdge {
  fromId: string
  toId: string
  fromRow: number
  toRow: number
  d: string
}

// M4: Track per-render AbortController to prevent listener accumulation
let renderAbort: AbortController | null = null

function renderGantt(
  outerContainer: HTMLElement,
  bars: GanttBar[],
  zoom: ZoomLevel,
  _parentSignal: AbortSignal,
  undatedTasks: TimelineTask[] = [],
  groupByKey: string = "none",
) {
  // Preserve vertical scroll across re-renders (e.g. inline drag/resize completion or collapse)
  const prevScrollWrapper = outerContainer.querySelector<HTMLElement>(".gantt-scroll-wrapper")
  const preservedScrollTop = prevScrollWrapper ? prevScrollWrapper.scrollTop : 0

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
  const rangeStart = alignToUnit(addDays(minDate, -padBefore), zoom)
  const rangeEnd = startOfDay(addDays(maxDate, padAfter))
  const totalDays = Math.max(1, daysBetween(rangeStart, rangeEnd))
  const pxPerDay = config.columnWidth / config.unitDays
  const totalWidth = totalDays * pxPerDay

  // Build hierarchy for sidebar (parent→child grouping with indentation or groupby)
  const hBars = buildHierarchy(bars, groupByKey)

  // Build unified TimelineDisplayRow[] covering scheduled rows, divider, and visible unscheduled rows
  const displayRows: TimelineDisplayRow[] = []
  const taskRowIndexById = new Map<string, number>()
  const navigableRowIndices: number[] = []

  for (let i = 0; i < hBars.length; i++) {
    const bar = hBars[i]!
    const rowIndex = displayRows.length
    if (bar.isGroupHeader) {
      displayRows.push({ kind: "group", rowIndex, bar })
    } else {
      displayRows.push({ kind: "bar", rowIndex, bar })
      taskRowIndexById.set(bar.id, rowIndex)
      navigableRowIndices.push(rowIndex)
    }
  }

  if (undatedTasks.length > 0) {
    displayRows.push({ kind: "divider", rowIndex: displayRows.length, count: undatedTasks.length })
    if (!unscheduledCollapsed) {
      for (let ui = 0; ui < undatedTasks.length; ui++) {
        const ut = undatedTasks[ui]!
        const rowIndex = displayRows.length
        displayRows.push({ kind: "unscheduled", rowIndex, task: ut, unscheduledIndex: ui })
        taskRowIndexById.set(ut.id, rowIndex)
      }
    }
  }

  const totalRowCount = displayRows.length
  const totalRowsHeight = totalRowCount * ROW_HEIGHT + 20
  const totalHeight = HEADER_HEIGHT + totalRowsHeight
  const totalColumnCount = Math.max(1, Math.ceil(totalDays / config.unitDays))

  outerContainer.setAttribute("role", "grid")
  outerContainer.setAttribute("aria-label", "Task timeline Gantt chart")
  outerContainer.setAttribute("aria-rowcount", String(totalRowCount))
  outerContainer.setAttribute("aria-colcount", String(totalColumnCount))

  // Clear previous render
  outerContainer.replaceChildren()

  // ── T2: Create layout with fixed sidebar + scrollable chart ──────────

  const layout = document.createElement("div")
  layout.className = "gantt-layout"
  layout.style.cssText = "display:flex;flex:1;min-height:0;max-height:calc(100vh - 180px);position:relative;overflow:hidden;"

  // Sidebar (fixed left) — hidden via display:none when toggle is off
  const sidebar = document.createElement("div")
  sidebar.className = "gantt-sidebar"
  sidebar.style.cssText = `
    flex:0 0 auto;width:${sidebarWidth()}px;
    background:var(--bg-card);border-right:1px solid var(--border);
    overflow:hidden;z-index:10;position:relative;display:flex;flex-direction:column;min-height:0;
    ${showSidebar ? "" : "display:none;"}
  `

  // Sidebar header — multi-column (Name + dynamic field cols + add-column)
  const sidebarHeader = document.createElement("div")
  sidebarHeader.className = "gantt-sidebar-header"
  sidebarHeader.style.cssText = `
    height:${HEADER_HEIGHT}px;flex:0 0 ${HEADER_HEIGHT}px;display:flex;align-items:center;
    padding:0 8px;border-bottom:1px solid var(--border);
    font-size:11px;font-weight:600;color:var(--text-muted);
    text-transform:uppercase;letter-spacing:0.04em;
    position:sticky;top:0;z-index:5;background:var(--bg-card);
  `

  const nameCol = document.createElement("span")
  nameCol.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
  nameCol.textContent = "Task"
  sidebarHeader.appendChild(nameCol)

  for (const fieldId of visibleFields) {
    const fieldDef = TASK_FIELD_DEFS.find(f => f.id === fieldId)
    if (!fieldDef) continue

    const colWrap = document.createElement("span")
    colWrap.style.cssText = `flex:0 0 ${FIELD_COL_WIDTH}px;text-align:right;padding-right:4px;display:flex;align-items:center;justify-content:flex-end;gap:2px;position:relative;`

    const colLabel = document.createElement("span")
    colLabel.style.cssText = "font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
    colLabel.textContent = fieldDef.label
    colLabel.title = fieldDef.label
    colWrap.appendChild(colLabel)

    sidebarHeader.appendChild(colWrap)
  }

  const addColBtn = document.createElement("button")
  addColBtn.style.cssText = "position:relative;background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:0 4px;flex-shrink:0;"
  addColBtn.textContent = "+"
  addColBtn.title = "Manage columns"

  const fieldPicker = new FieldPickerPanel({
    viewId: "timeline",
    fields: TASK_FIELD_DEFS,
    triggerEl: addColBtn,
    onChanged: (ids) => {
      visibleFields = new Set(ids)
      try { localStorage.setItem("gantt-visible-fields", JSON.stringify(Array.from(visibleFields))) } catch { /* ignore */ }
      renderGantt(outerContainer, bars, zoom, _parentSignal, undatedTasks, groupByKey)
    },
    signal,
  })

  addColBtn.addEventListener("click", (e) => {
    e.stopPropagation()
    fieldPicker.toggle()
  }, { signal })
  sidebarHeader.appendChild(addColBtn)
  sidebar.appendChild(sidebarHeader)

  // Sidebar rows viewport + unclipped translated track
  const sidebarRows = document.createElement("div")
  sidebarRows.className = "gantt-sidebar-rows"
  sidebarRows.style.cssText = "flex:1;overflow:hidden;min-height:0;position:relative;"

  const sidebarTrack = document.createElement("div")
  sidebarTrack.className = "gantt-sidebar-track"
  sidebarTrack.style.cssText = `position:relative;width:100%;height:${totalRowsHeight}px;transform:translateY(0px);`
  sidebarRows.appendChild(sidebarTrack)
  sidebar.appendChild(sidebarRows)
  layout.appendChild(sidebar)

  // Scrollable chart area
  const scrollWrapper = document.createElement("div")
  scrollWrapper.className = "gantt-scroll-wrapper"
  scrollWrapper.style.cssText = "flex:1;overflow:auto;position:relative;min-height:0;"

  // Create SVG
  const svg = svgEl("svg", {
    class: "gantt-native",
    width: totalWidth,
    height: totalHeight,
  })
  svg.style.cssText = `min-width:${totalWidth}px;display:block;`

  // ── SVG Defs (arrow marker + repeating column/row grid pattern) ──────

  const defs = svgEl("defs")
  const marker = svgEl("marker", {
    id: "arrowhead", markerWidth: 8, markerHeight: 6, refX: 8, refY: 3, orient: "auto",
  })
  marker.appendChild(svgEl("polygon", { points: "0 0, 8 3, 0 6", fill: "var(--text-muted)", opacity: 0.5 }))
  defs.appendChild(marker)

  const gridGroup = svgEl("g", { class: "gantt-grid" })

  if (zoom === "Day" || zoom === "Week") {
    const patternWidth = 7 * pxPerDay
    const patternHeight = ROW_HEIGHT * 2
    const utcDay = new Date(Date.UTC(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate())).getUTCDay()
    const mondayIndex = (utcDay + 6) % 7
    const weekendOffsetPx = -mondayIndex * pxPerDay

    const colPattern = svgEl("pattern", {
      id: "gantt-col-grid",
      width: patternWidth,
      height: patternHeight,
      patternUnits: "userSpaceOnUse",
      patternTransform: `translate(${weekendOffsetPx}, ${HEADER_HEIGHT})`,
    })
    colPattern.appendChild(svgEl("rect", {
      x: 0, y: 0, width: patternWidth, height: ROW_HEIGHT, fill: "var(--bg-card)",
    }))
    colPattern.appendChild(svgEl("rect", {
      x: 0, y: ROW_HEIGHT, width: patternWidth, height: ROW_HEIGHT,
      fill: "var(--bg-secondary, rgba(255,255,255,0.02))",
    }))
    colPattern.appendChild(svgEl("rect", {
      x: 5 * pxPerDay, y: 0, width: 2 * pxPerDay, height: patternHeight,
      fill: "var(--bg-secondary, rgba(255,255,255,0.06))", opacity: 0.7,
    }))
    colPattern.appendChild(svgEl("line", {
      x1: 0, y1: ROW_HEIGHT, x2: patternWidth, y2: ROW_HEIGHT,
      stroke: "var(--border-subtle, rgba(255,255,255,0.05))", "stroke-width": 0.5,
    }))
    colPattern.appendChild(svgEl("line", {
      x1: 0, y1: patternHeight, x2: patternWidth, y2: patternHeight,
      stroke: "var(--border-subtle, rgba(255,255,255,0.05))", "stroke-width": 0.5,
    }))
    if (zoom === "Day") {
      for (let k = 0; k < 7; k++) {
        colPattern.appendChild(svgEl("line", {
          x1: k * pxPerDay, y1: 0, x2: k * pxPerDay, y2: patternHeight,
          stroke: "var(--border-subtle, rgba(255,255,255,0.05))", "stroke-width": 0.3,
        }))
      }
    } else {
      colPattern.appendChild(svgEl("line", {
        x1: 0, y1: 0, x2: 0, y2: patternHeight,
        stroke: "var(--border-subtle, rgba(255,255,255,0.05))", "stroke-width": 0.3,
      }))
    }
    defs.appendChild(colPattern)

    gridGroup.appendChild(svgEl("rect", {
      x: 0, y: HEADER_HEIGHT, width: totalWidth, height: totalRowsHeight,
      fill: "url(#gantt-col-grid)",
    }))
  } else {
    // Month zoom: row stripe pattern + exact 1st-of-month <line> dividers (<= 25 static lines)
    const patternHeight = ROW_HEIGHT * 2
    const rowPattern = svgEl("pattern", {
      id: "gantt-col-grid",
      width: Math.max(1, totalWidth),
      height: patternHeight,
      patternUnits: "userSpaceOnUse",
      patternTransform: `translate(0, ${HEADER_HEIGHT})`,
    })
    rowPattern.appendChild(svgEl("rect", {
      x: 0, y: 0, width: Math.max(1, totalWidth), height: ROW_HEIGHT, fill: "var(--bg-card)",
    }))
    rowPattern.appendChild(svgEl("rect", {
      x: 0, y: ROW_HEIGHT, width: Math.max(1, totalWidth), height: ROW_HEIGHT,
      fill: "var(--bg-secondary, rgba(255,255,255,0.02))",
    }))
    rowPattern.appendChild(svgEl("line", {
      x1: 0, y1: ROW_HEIGHT, x2: Math.max(1, totalWidth), y2: ROW_HEIGHT,
      stroke: "var(--border-subtle, rgba(255,255,255,0.05))", "stroke-width": 0.5,
    }))
    rowPattern.appendChild(svgEl("line", {
      x1: 0, y1: patternHeight, x2: Math.max(1, totalWidth), y2: patternHeight,
      stroke: "var(--border-subtle, rgba(255,255,255,0.05))", "stroke-width": 0.5,
    }))
    defs.appendChild(rowPattern)

    gridGroup.appendChild(svgEl("rect", {
      x: 0, y: HEADER_HEIGHT, width: totalWidth, height: totalRowsHeight,
      fill: "url(#gantt-col-grid)",
    }))

    const monthDates: Date[] = []
    const cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1)
    if (cursor < rangeStart) cursor.setMonth(cursor.getMonth() + 1)
    while (cursor <= rangeEnd) {
      monthDates.push(new Date(cursor))
      cursor.setMonth(cursor.getMonth() + 1)
    }
    const step = Math.max(1, Math.ceil(monthDates.length / 25))
    for (let mi = 0; mi < monthDates.length; mi += step) {
      const mDate = monthDates[mi]!
      const x = daysBetween(rangeStart, mDate) * pxPerDay
      gridGroup.appendChild(svgEl("line", {
        class: "gantt-month-divider",
        "data-month-start": toISODate(mDate),
        x1: x, y1: HEADER_HEIGHT, x2: x, y2: totalHeight,
        stroke: "var(--border-subtle, rgba(255,255,255,0.08))", "stroke-width": 0.6,
      }))
    }
  }

  // Single reusable hover/focus highlight rect (avoids 1 rect per row)
  const sharedHighlightRect = svgEl("rect", {
    x: 0, y: HEADER_HEIGHT, width: totalWidth, height: ROW_HEIGHT,
    fill: "var(--accent)", opacity: 0,
    class: "gantt-row-highlight",
  })
  sharedHighlightRect.style.pointerEvents = "none"
  gridGroup.appendChild(sharedHighlightRect)

  svg.appendChild(defs)
  svg.appendChild(gridGroup)

  function setChartRowHighlight(rowIndex: number | null) {
    if (rowIndex === null) {
      sharedHighlightRect.setAttribute("opacity", "0")
    } else {
      sharedHighlightRect.setAttribute("y", String(HEADER_HEIGHT + rowIndex * ROW_HEIGHT))
      sharedHighlightRect.setAttribute("opacity", "0.06")
    }
  }

  // ── Frozen Header (built directly in headerSvg, never left in svg.gantt-native) ──

  const headerGroup = svgEl("g", { class: "gantt-header" })
  headerGroup.appendChild(
    svgEl("rect", { x: 0, y: 0, width: totalWidth, height: HEADER_HEIGHT, fill: "var(--bg-card)" }),
  )
  headerGroup.appendChild(
    svgEl("line", { x1: 0, y1: HEADER_HEIGHT, x2: totalWidth, y2: HEADER_HEIGHT, stroke: "var(--border)", "stroke-width": 1 }),
  )

  let lastUpper = ""
  if (zoom === "Month") {
    const hCursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1)
    if (hCursor < rangeStart) hCursor.setMonth(hCursor.getMonth() + 1)
    while (hCursor <= rangeEnd) {
      const x = daysBetween(rangeStart, hCursor) * pxPerDay
      const nextMonth = new Date(hCursor.getFullYear(), hCursor.getMonth() + 1, 1)
      const colW = Math.max(40, daysBetween(hCursor, nextMonth) * pxPerDay)
      const lower = svgEl("text", {
        x: x + colW / 2, y: HEADER_HEIGHT - 10,
        "text-anchor": "middle", fill: "var(--text-muted)", "font-size": 11, "font-family": "inherit",
      })
      lower.textContent = SHORT_MONTHS[hCursor.getMonth()] ?? config.headerFormat(hCursor)
      headerGroup.appendChild(lower)

      const upperText = String(hCursor.getFullYear())
      if (upperText !== lastUpper) {
        lastUpper = upperText
        const upper = svgEl("text", {
          x: x + 4, y: 18, "text-anchor": "start",
          fill: "var(--text-primary)", "font-size": 12, "font-weight": 600, "font-family": "inherit",
        })
        upper.textContent = upperText
        headerGroup.appendChild(upper)
      }
      hCursor.setMonth(hCursor.getMonth() + 1)
    }
  } else {
    for (let d = 0; d < totalDays; d += config.unitDays) {
      const date = addDays(rangeStart, d)
      const x = d * pxPerDay
      const lower = svgEl("text", {
        x: x + config.columnWidth / 2, y: HEADER_HEIGHT - 10,
        "text-anchor": "middle", fill: "var(--text-muted)", "font-size": 11, "font-family": "inherit",
      })
      lower.textContent = config.headerFormat(date)
      headerGroup.appendChild(lower)

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
  }

  // ── Today Marker + M3: Today Label ───────────────────────────────────

  const today = startOfDay(new Date())
  const todayOffset = daysBetween(rangeStart, today)
  const todayX = todayOffset * pxPerDay
  let todayHeaderClone: SVGGElement | null = null
  if (todayOffset >= 0 && todayOffset <= totalDays) {
    const todayGroup = svgEl("g", { class: "gantt-today" })
    todayGroup.appendChild(
      svgEl("line", {
        x1: todayX, y1: HEADER_HEIGHT, x2: todayX, y2: totalHeight,
        stroke: "#EF4444", "stroke-width": 2.5, opacity: 0.85,
      }),
    )
    svg.appendChild(todayGroup)

    todayHeaderClone = svgEl("g", { class: "gantt-today" })
    todayHeaderClone.appendChild(
      svgEl("polygon", {
        points: `${todayX},4 ${todayX + 6},12 ${todayX},20 ${todayX - 6},12`,
        fill: "#EF4444",
      }),
    )
    const todayLabel = svgEl("text", {
      x: todayX, y: HEADER_HEIGHT - 2,
      "text-anchor": "middle", fill: "#EF4444",
      "font-size": 10, "font-weight": 700, "font-family": "inherit",
      opacity: 0.95,
    })
    todayLabel.textContent = "Today"
    todayHeaderClone.appendChild(todayLabel)
  }

  // ── Precompute Bar Coordinates & Dependency Edges ────────────────────

  const barPositions = new Map<string, { x: number; y: number; w: number; rowIndex: number }>()
  for (const dRow of displayRows) {
    if (dRow.kind === "group") {
      barPositions.set(dRow.bar.id, { x: 0, y: HEADER_HEIGHT + dRow.rowIndex * ROW_HEIGHT, w: 0, rowIndex: dRow.rowIndex })
    } else if (dRow.kind === "bar") {
      const bar = dRow.bar
      let xStart = daysBetween(rangeStart, bar.start) * pxPerDay
      const duration = Math.max(1, daysBetween(bar.start, bar.end) + 1)
      let w = bar.isMilestone ? 16 : duration * pxPerDay
      if (isNaN(xStart)) xStart = 0
      if (isNaN(w)) w = 16
      barPositions.set(bar.id, {
        x: xStart,
        y: HEADER_HEIGHT + dRow.rowIndex * ROW_HEIGHT,
        w,
        rowIndex: dRow.rowIndex,
      })
    }
  }

  const dependencyEdges: DependencyEdge[] = []
  for (const dRow of displayRows) {
    if (dRow.kind !== "bar") continue
    const bar = dRow.bar
    const to = barPositions.get(bar.id)
    if (!to) continue
    for (const depId of bar.deps) {
      const from = barPositions.get(depId)
      if (!from) continue
      const fx = from.x + from.w
      const fy = HEADER_HEIGHT + from.rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2
      const tx = to.x
      const ty = HEADER_HEIGHT + to.rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2
      const mx = fx + (tx - fx) / 2
      dependencyEdges.push({
        fromId: depId,
        toId: bar.id,
        fromRow: from.rowIndex,
        toRow: to.rowIndex,
        d: `M ${fx} ${fy} C ${mx} ${fy}, ${mx} ${ty}, ${tx} ${ty}`,
      })
    }
  }

  const arrowGroup = svgEl("g", { class: "gantt-arrows" })
  const barsGroup = svgEl("g", { class: "gantt-bars" })
  svg.appendChild(arrowGroup)
  svg.appendChild(barsGroup)
  scrollWrapper.appendChild(svg)

  // ── Split chart: frozen header + scrollable body ─────────────────────

  const chartColumn = document.createElement("div")
  chartColumn.className = "gantt-chart-column"
  chartColumn.style.cssText = "flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;"

  const headerOverlay = document.createElement("div")
  headerOverlay.className = "gantt-header-overlay"
  headerOverlay.style.cssText = `
    flex:0 0 ${HEADER_HEIGHT}px;overflow:hidden;position:relative;
    border-bottom:1px solid var(--border);background:var(--bg-card);z-index:3;
  `

  const headerSvg = svgEl("svg", {
    class: "gantt-header-svg",
    width: totalWidth,
    height: HEADER_HEIGHT,
  })
  headerSvg.style.cssText = `min-width:${totalWidth}px;display:block;`
  headerSvg.appendChild(headerGroup)
  if (todayHeaderClone) headerSvg.appendChild(todayHeaderClone)
  headerOverlay.appendChild(headerSvg)

  svg.style.marginTop = `-${HEADER_HEIGHT}px`

  chartColumn.appendChild(headerOverlay)
  chartColumn.appendChild(scrollWrapper)
  layout.appendChild(chartColumn)
  outerContainer.appendChild(layout)

  // ── Virtualized Row Builder & Windowing State ────────────────────────

  let activeFocusedTaskId: string | null = null
  let activeDragTaskId: string | null = null
  let focusedNavPos = -1
  const mountedRows = new Map<number, MountedTimelineRow>()

  function attachLazyDateCell(
    cell: HTMLElement,
    rawIsoValue: string | null | undefined,
    onSelect: (date: Date) => Promise<void>,
    onClearDate: () => Promise<void>,
    rowCleanupList: Array<() => void>,
  ) {
    cell.classList.add("idp-container")
    cell.tabIndex = 0
    cell.title = rawIsoValue ? "Click to change date" : "Set date"
    cell.textContent = fastIsoShortDate(rawIsoValue)
    cell.style.color = rawIsoValue ? "var(--text-secondary)" : "var(--text-muted)"
    cell.style.cursor = "pointer"

    let picker: InlineDatePicker | null = null
    const upgradeAndOpen = (ev: Event) => {
      ev.stopPropagation()
      if (!picker) {
        cell.removeAttribute("tabindex")
        const initialValue = rawIsoValue ? parseDate(rawIsoValue) : null
        picker = new InlineDatePicker(cell, {
          value: initialValue,
          onChange: (d) => { void onSelect(d) },
          onClear: () => { void onClearDate() },
          signal,
        })
        rowCleanupList.push(() => picker?.destroy())
        const trigger = cell.querySelector<HTMLElement>(".idp-trigger")
        trigger?.click()
      }
    }
    cell.addEventListener("click", upgradeAndOpen, { signal })
    cell.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault()
        upgradeAndOpen(ev)
      }
    }, { signal })
  }

  function mountDisplayRow(
    rowIndex: number,
    sidebarTarget: Node = sidebarTrack,
    svgTarget: Node = barsGroup,
  ): MountedTimelineRow | null {
    const dRow = displayRows[rowIndex]
    if (!dRow) return null
    const rowCleanups: Array<() => void> = []
    const rowSignal = signal
    const rowTop = rowIndex * ROW_HEIGHT
    const svgRowY = HEADER_HEIGHT + rowTop

    if (dRow.kind === "group") {
      const bar = dRow.bar
      const row = document.createElement("div")
      row.className = "gantt-sidebar-row gantt-sidebar-row--parent"
      row.setAttribute("role", "heading")
      row.setAttribute("aria-label", `Group: ${bar.name}`)
      row.setAttribute("aria-rowindex", String(rowIndex + 1))
      row.dataset.rowIndex = String(rowIndex)
      row.dataset.taskId = bar.id
      row.style.cssText = `
        position:absolute;left:0;right:0;top:${rowTop}px;height:${ROW_HEIGHT}px;
        display:flex;align-items:center;padding:0 8px;
        border-bottom:1px solid var(--border-subtle, rgba(255,255,255,0.05));
        ${rowIndex === 0 ? "" : "border-top:1px solid var(--border);"}
        font-size:12px;font-weight:bold;color:var(--text-primary);cursor:pointer;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--bg-card);
      `

      const toggle = document.createElement("button")
      toggle.className = "gantt-sidebar-toggle"
      toggle.type = "button"
      toggle.setAttribute("aria-label", bar.isCollapsed ? "Expand group" : "Collapse group")
      toggle.setAttribute("tabindex", "-1")
      toggle.style.cssText = `
        width:16px;height:16px;display:flex;align-items:center;justify-content:center;
        background:none;border:none;cursor:pointer;color:var(--text-muted);
        margin-right:8px;flex-shrink:0;padding:0;border-radius:3px;
      `
      toggle.textContent = bar.isCollapsed ? "▸" : "▾"
      const onToggle = (e: Event) => {
        e.stopPropagation()
        e.preventDefault()
        if (collapsedParents.has(bar.id)) collapsedParents.delete(bar.id)
        else collapsedParents.add(bar.id)
        renderGantt(outerContainer, bars, zoom, _parentSignal, undatedTasks, groupByKey)
      }
      toggle.addEventListener("click", onToggle, { signal: rowSignal })
      row.addEventListener("click", onToggle, { signal: rowSignal })
      row.appendChild(toggle)

      const name = document.createElement("span")
      name.className = "gantt-sidebar-row-title"
      name.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;"
      name.textContent = bar.name
      row.appendChild(name)

      const groupSvg = svgEl("g", {
        class: "gantt-group-row",
        "data-row-index": rowIndex,
        "aria-rowindex": rowIndex + 1,
      })
      groupSvg.appendChild(svgEl("rect", {
        x: 0, y: svgRowY, width: totalWidth, height: ROW_HEIGHT,
        fill: "var(--bg-secondary, rgba(255,255,255,0.03))",
      }))

      sidebarTarget.appendChild(row)
      svgTarget.appendChild(groupSvg)
      return { sidebarEl: row, svgEl: groupSvg, cleanup: rowCleanups.length ? () => rowCleanups.forEach(fn => fn()) : undefined }
    }

    if (dRow.kind === "divider") {
      const divider = document.createElement("div")
      divider.className = "gantt-unscheduled-divider"
      divider.dataset.rowIndex = String(rowIndex)
      divider.setAttribute("aria-rowindex", String(rowIndex + 1))
      divider.style.cssText = `
        position:absolute;left:0;right:0;top:${rowTop}px;height:${ROW_HEIGHT}px;
        display:flex;align-items:center;padding:0 8px;
        border-bottom:1px solid var(--border-subtle, rgba(255,255,255,0.05));
        font-size:10px;font-weight:600;color:var(--text-muted);
        text-transform:uppercase;letter-spacing:0.06em;
        background:var(--bg-secondary, rgba(255,255,255,0.03));
        cursor:pointer;gap:4px;user-select:none;
      `
      divider.textContent = `${unscheduledCollapsed ? "▸" : "▾"} Unscheduled (${dRow.count})`
      divider.addEventListener("click", () => {
        unscheduledCollapsed = !unscheduledCollapsed
        try { localStorage.setItem(UNSCHEDULED_COLLAPSED_KEY, String(unscheduledCollapsed)) } catch { /* ignore */ }
        renderGantt(outerContainer, bars, zoom, _parentSignal, undatedTasks, groupByKey)
      }, { signal: rowSignal })

      const divSvg = svgEl("g", {
        class: "gantt-divider-row",
        "data-row-index": rowIndex,
        "aria-rowindex": rowIndex + 1,
      })
      divSvg.appendChild(svgEl("rect", {
        x: 0, y: svgRowY, width: totalWidth, height: ROW_HEIGHT,
        fill: "var(--bg-secondary, rgba(255,255,255,0.03))",
      }))

      sidebarTarget.appendChild(divider)
      svgTarget.appendChild(divSvg)
      return { sidebarEl: divider, svgEl: divSvg, cleanup: rowCleanups.length ? () => rowCleanups.forEach(fn => fn()) : undefined }
    }

    if (dRow.kind === "unscheduled") {
      const ut = dRow.task
      const ui = dRow.unscheduledIndex
      const ticketPrefix = ut.ticket_number ? `MTH-${ut.ticket_number} ` : ""
      const utName = `${ticketPrefix}${ut.title}`
      const utRow = document.createElement("div")
      utRow.className = `gantt-sidebar-row gantt-sidebar-row--unscheduled${activeFocusedTaskId === ut.id ? " gantt-sidebar-row--focused" : ""}`
      utRow.setAttribute("role", "button")
      utRow.setAttribute("tabindex", "0")
      utRow.setAttribute("aria-label", `Unscheduled: ${utName}`)
      utRow.setAttribute("aria-rowindex", String(rowIndex + 1))
      utRow.dataset.rowIndex = String(rowIndex)
      utRow.dataset.taskId = ut.id
      const baseBg = ui % 2 === 0 ? "transparent" : "var(--bg-secondary, rgba(255,255,255,0.02))"
      utRow.style.cssText = `
        position:absolute;left:0;right:0;top:${rowTop}px;height:${ROW_HEIGHT}px;
        display:flex;align-items:center;padding:0 8px;
        border-bottom:1px solid var(--border-subtle, rgba(255,255,255,0.05));
        font-size:12px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        background:${baseBg};opacity:0.7;
      `

      const dot = document.createElement("span")
      dot.style.cssText = `
        width:8px;height:8px;border-radius:50%;
        background:${PRIORITY_COLOURS[ut.priority] || "var(--accent)"};margin-right:8px;flex-shrink:0;
      `
      utRow.appendChild(dot)

      const name = document.createElement("span")
      name.className = "gantt-sidebar-row-title"
      name.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--text-primary);"
      name.textContent = utName
      name.title = utName
      utRow.appendChild(name)

      if (visibleFields.has("due_date")) {
        const dueCell = document.createElement("span")
        dueCell.style.cssText = "flex:0 0 80px;text-align:right;padding-right:4px;font-size:11px;white-space:nowrap;"
        attachLazyDateCell(
          dueCell,
          null,
          async (date) => {
            const iso = toISODate(date)
            const ok = await patchTask(ut.id, { due_date: iso, start_date: iso })
            if (ok) {
              ut.due_date = iso
              ut.start_date = iso
              showToast("Date set — task scheduled")
              const idx = undatedTasks.findIndex(t => t.id === ut.id)
              if (idx !== -1) undatedTasks.splice(idx, 1)
              const complete = isComplete(ut.status)
              const overdue = !complete && date < startOfDay(new Date())
              bars.push({
                id: ut.id,
                name: `${ut.ticket_number ? `MTH-${ut.ticket_number} ` : ""}${ut.title}`,
                start: date,
                end: date,
                progress: Number(ut.progress ?? 0),
                colour: ut.color || PRIORITY_COLOURS[ut.priority] || "var(--accent)",
                taskType: String(ut.task_type || "task"),
                isComplete: complete,
                isOverdue: overdue,
                isMilestone: true,
                priority: ut.priority,
                original: ut,
                deps: [],
              })
              const targetX = daysBetween(rangeStart, date) * pxPerDay
              localStorage.setItem(`${SCROLL_KEY_PREFIX}${zoom}`, String(targetX - outerContainer.clientWidth / 2))
              renderGantt(outerContainer, bars, zoom, _parentSignal, undatedTasks, groupByKey)
            }
          },
          async () => {},
          rowCleanups,
        )
        utRow.appendChild(dueCell)
      }

      utRow.addEventListener("focusin", () => { activeFocusedTaskId = ut.id }, { signal: rowSignal })
      utRow.addEventListener("click", (e) => {
        e.stopPropagation()
        window.dispatchEvent(new CustomEvent("meitheal:open-task", { detail: { taskId: ut.id } }))
      }, { signal: rowSignal })
      utRow.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); utRow.click() }
      }, { signal: rowSignal })
      utRow.addEventListener("mouseenter", () => {
        utRow.style.background = "var(--bg-secondary, rgba(255,255,255,0.06))"
        utRow.style.opacity = "1"
        setChartRowHighlight(rowIndex)
      }, { signal: rowSignal })
      utRow.addEventListener("mouseleave", () => {
        utRow.style.background = baseBg
        utRow.style.opacity = "0.7"
        setChartRowHighlight(null)
      }, { signal: rowSignal })

      const utSvg = svgEl("g", {
        class: "gantt-unscheduled-row",
        "data-row-index": rowIndex,
        "aria-rowindex": rowIndex + 1,
      })
      const hintText = svgEl("text", {
        x: totalWidth / 2, y: svgRowY + ROW_HEIGHT / 2 + 1,
        "text-anchor": "middle", fill: "var(--text-muted)",
        "font-size": 11, "font-style": "italic", "font-family": "inherit",
        "dominant-baseline": "central", opacity: 0,
        class: "gantt-schedule-hint",
      })
      hintText.textContent = "Click to schedule"
      const clickRect = svgEl("rect", {
        x: 0, y: svgRowY, width: totalWidth, height: ROW_HEIGHT,
        fill: "transparent", cursor: "crosshair",
      })
      clickRect.addEventListener("mouseenter", () => {
        hintText.setAttribute("opacity", "0.6")
        utRow.style.background = "var(--bg-secondary, rgba(255,255,255,0.06))"
        utRow.style.opacity = "1"
        setChartRowHighlight(rowIndex)
      }, { signal: rowSignal })
      clickRect.addEventListener("mouseleave", () => {
        hintText.setAttribute("opacity", "0")
        utRow.style.background = baseBg
        utRow.style.opacity = "0.7"
        setChartRowHighlight(null)
      }, { signal: rowSignal })
      clickRect.addEventListener("click", async (e) => {
        e.stopPropagation()
        const svgRect = svg.getBoundingClientRect()
        const clickX = e.clientX - svgRect.left
        const dayOffset = Math.floor(clickX / pxPerDay)
        const clickedDate = addDays(rangeStart, dayOffset)
        const iso = toISODate(clickedDate)
        const ok = await patchTask(ut.id, { start_date: iso, due_date: iso })
        if (ok) {
          ut.start_date = iso
          ut.due_date = iso
          showToast(`Scheduled for ${fmtDate(clickedDate)}`)
          const idx = undatedTasks.findIndex(t => t.id === ut.id)
          if (idx !== -1) undatedTasks.splice(idx, 1)
          const complete = isComplete(ut.status)
          const overdue = !complete && clickedDate < startOfDay(new Date())
          bars.push({
            id: ut.id,
            name: `${ut.ticket_number ? `MTH-${ut.ticket_number} ` : ""}${ut.title}`,
            start: clickedDate,
            end: clickedDate,
            progress: Number(ut.progress ?? 0),
            colour: ut.color || PRIORITY_COLOURS[ut.priority] || "var(--accent)",
            taskType: String(ut.task_type || "task"),
            isComplete: complete,
            isOverdue: overdue,
            isMilestone: true,
            priority: ut.priority,
            original: ut,
            deps: [],
          })
          localStorage.setItem(`${SCROLL_KEY_PREFIX}${zoom}`, String(clickX - outerContainer.clientWidth / 2))
          renderGantt(outerContainer, bars, zoom, _parentSignal, undatedTasks, groupByKey)
        } else {
          showToast("Failed to schedule", "error")
        }
      }, { signal: rowSignal })

      utSvg.appendChild(hintText)
      utSvg.appendChild(clickRect)
      sidebarTarget.appendChild(utRow)
      svgTarget.appendChild(utSvg)
      return { sidebarEl: utRow, svgEl: utSvg, cleanup: rowCleanups.length ? () => rowCleanups.forEach(fn => fn()) : undefined }
    }

    // kind === "bar"
    const bar = dRow.bar
    const pos = barPositions.get(bar.id)!
    const indentPx = bar.depth * 20

    const row = document.createElement("div")
    row.className = `gantt-sidebar-row gantt-vrow${rowIndex % 2 !== 0 ? " gantt-vrow--alt" : ""}${bar.isOverdue ? " gantt-sidebar-row--overdue" : ""}${bar.isComplete ? " gantt-sidebar-row--complete" : ""}${bar.hasChildren ? " gantt-sidebar-row--parent" : ""}${activeFocusedTaskId === bar.id ? " gantt-sidebar-row--focused" : ""}`
    row.setAttribute("role", "button")
    row.setAttribute("tabindex", "0")
    row.setAttribute("aria-label", `Navigate to ${bar.name}`)
    row.setAttribute("aria-rowindex", String(rowIndex + 1))
    row.dataset.rowIndex = String(rowIndex)
    row.dataset.taskId = bar.id
    row.style.top = `${rowTop}px`
    if (indentPx > 0) row.style.paddingLeft = `${8 + indentPx}px`

    if (bar.hasChildren) {
      const toggle = document.createElement("button")
      toggle.className = "gantt-sidebar-toggle"
      toggle.type = "button"
      toggle.setAttribute("aria-label", bar.isCollapsed ? "Expand children" : "Collapse children")
      toggle.setAttribute("tabindex", "-1")
      toggle.style.cssText = "width:16px;height:16px;display:flex;align-items:center;justify-content:center;background:none;border:none;cursor:pointer;color:var(--text-muted);margin-right:4px;flex-shrink:0;padding:0;border-radius:3px;"
      toggle.textContent = bar.isCollapsed ? "▸" : "▾"
      toggle.addEventListener("click", (e) => {
        e.stopPropagation()
        e.preventDefault()
        if (collapsedParents.has(bar.id)) collapsedParents.delete(bar.id)
        else collapsedParents.add(bar.id)
        renderGantt(outerContainer, bars, zoom, _parentSignal, undatedTasks, groupByKey)
      }, { signal: rowSignal })
      row.appendChild(toggle)
    }

    const dot = document.createElement("span")
    dot.className = "gantt-vrow-dot"
    dot.style.background = bar.colour
    if (bar.taskType === "epic") dot.style.borderRadius = "2px"
    if (!bar.hasChildren && bar.depth > 0) dot.style.marginLeft = "20px"
    if (bar.isOverdue) dot.style.boxShadow = "0 0 6px rgba(239,68,68,0.6)"
    row.appendChild(dot)

    const name = document.createElement("span")
    name.className = "gantt-sidebar-row-title gantt-vrow-title"
    if (bar.isComplete) {
      name.style.textDecoration = "line-through"
      name.style.color = "var(--text-muted)"
    } else if (bar.isOverdue) {
      name.style.color = "var(--danger-text)"
    }
    if (bar.hasChildren) name.style.fontWeight = "600"
    name.textContent = bar.name
    name.title = bar.name
    row.appendChild(name)

    if (bar.original.deferred_at != null) {
      const badge = document.createElement("span")
      badge.style.cssText = "flex:none;margin-inline:6px;color:var(--text-secondary);font-size:11px"
      badge.textContent = window.mI18n?.get("deferral.title") ?? "Deferred"
      row.appendChild(badge)
    }

    for (const fieldId of visibleFields) {
      const cell = document.createElement("span")
      cell.className = "gantt-vrow-cell"

      if (fieldId === "due_date") {
        attachLazyDateCell(
          cell,
          bar.original.due_date,
          async (date) => {
            const iso = toISODate(date)
            const ok = await patchTask(bar.id, { due_date: iso })
            if (ok) {
              bar.original.due_date = iso
              renderGantt(outerContainer, bars, zoom, _parentSignal, undatedTasks, groupByKey)
            }
          },
          async () => {
            const ok = await patchTask(bar.id, { due_date: null })
            if (ok) {
              bar.original.due_date = null
              renderGantt(outerContainer, bars, zoom, _parentSignal, undatedTasks, groupByKey)
            }
          },
          rowCleanups,
        )
      } else if (fieldId === "start_date") {
        attachLazyDateCell(
          cell,
          bar.original.start_date,
          async (date) => {
            const iso = toISODate(date)
            const ok = await patchTask(bar.id, { start_date: iso })
            if (ok) {
              bar.original.start_date = iso
              renderGantt(outerContainer, bars, zoom, _parentSignal, undatedTasks, groupByKey)
            }
          },
          async () => {
            const ok = await patchTask(bar.id, { start_date: null })
            if (ok) {
              bar.original.start_date = null
              renderGantt(outerContainer, bars, zoom, _parentSignal, undatedTasks, groupByKey)
            }
          },
          rowCleanups,
        )
      } else if (fieldId === "priority") {
        const pLabel = PRIORITY_LABELS[bar.priority] || `P${bar.priority}`
        const pColor = PRIORITY_COLOURS[bar.priority] || "var(--text-muted)"
        cell.style.color = pColor
        cell.textContent = pLabel
        cell.title = `Priority: ${pLabel}`
      } else if (fieldId === "status") {
        cell.textContent = statusLabel(bar.original.status)
        cell.style.color = bar.isComplete ? "var(--accent-success, #10b981)" : "var(--text-muted)"
      } else if (fieldId === "ticket_number") {
        cell.textContent = bar.original.ticket_number ? `MTH-${bar.original.ticket_number}` : "—"
        cell.style.color = "var(--text-muted)"
      } else if (fieldId === "progress") {
        cell.textContent = `${bar.progress}%`
        cell.style.color = bar.progress >= 100 ? "var(--accent-success, #10b981)" : "var(--text-muted)"
      } else if (fieldId === "effort_minutes") {
        const mins = bar.original.effort_minutes
        if (mins && mins > 0) {
          const h = Math.floor(mins / 60)
          const m = mins % 60
          cell.textContent = h > 0 ? `${h}h ${m}m` : `${m}m`
        } else {
          cell.textContent = "—"
        }
        cell.style.color = "var(--text-muted)"
      } else if (fieldId === "task_kind") {
        cell.textContent = bar.original.task_kind || bar.original.task_type || "—"
        cell.style.color = "var(--text-muted)"
      }

      row.appendChild(cell)
    }

    const barY = pos.y + BAR_Y_PAD

    if (bar.isMilestone) {
      const mx = pos.x
      const my = barY + BAR_HEIGHT / 2
      const ms = 10
      const milestoneGroup = svgEl("g", {
        class: "gantt-milestone",
        "data-task-id": bar.id,
        "data-row-index": rowIndex,
        "data-bar-index": rowIndex,
        "aria-rowindex": rowIndex + 1,
        tabindex: 0,
        role: "button",
        "aria-label": `Milestone: ${bar.name}`,
      })
      milestoneGroup.style.cursor = "pointer"
      milestoneGroup.appendChild(
        svgEl("polygon", {
          points: `${mx},${my - ms} ${mx + ms},${my} ${mx},${my + ms} ${mx - ms},${my}`,
          fill: bar.colour,
          opacity: bar.isComplete ? 0.4 : 1,
          stroke: bar.isOverdue ? "var(--accent-danger, #ef4444)" : "none",
          "stroke-width": bar.isOverdue ? 2 : 0,
        }),
      )

      sidebarTarget.appendChild(row)
      svgTarget.appendChild(milestoneGroup)
      return { sidebarEl: row, svgEl: milestoneGroup, cleanup: rowCleanups.length ? () => rowCleanups.forEach(fn => fn()) : undefined }
    }

    const barW = Math.max(pos.w, 24)
    const barGroup = svgEl("g", {
      class: "gantt-bar",
      "data-task-id": bar.id,
      "data-row-index": rowIndex,
      "data-bar-index": rowIndex,
      "aria-rowindex": rowIndex + 1,
      tabindex: 0,
      role: "button",
      "aria-label": `Task: ${bar.name}`,
    })
    barGroup.style.cursor = "pointer"
    barGroup.style.touchAction = "none"

    const bgRect = svgEl("rect", {
      x: pos.x,
      y: barY,
      width: barW,
      height: BAR_HEIGHT,
      rx: BAR_RADIUS,
      ry: BAR_RADIUS,
      fill: bar.colour,
      opacity: bar.isComplete ? 0.3 : 0.75,
      ...(bar.isOverdue ? { stroke: "var(--accent-danger, #ef4444)", "stroke-width": 2 } : {}),
    })
    barGroup.appendChild(bgRect)

    let progRect: SVGRectElement | null = null
    if (bar.progress > 0 && bar.progress <= 100) {
      const progW = Math.min((bar.progress / 100) * barW, barW)
      progRect = svgEl("rect", {
        x: pos.x,
        y: barY,
        width: progW,
        height: BAR_HEIGHT,
        rx: BAR_RADIUS,
        ry: BAR_RADIUS,
        fill: bar.colour,
        opacity: bar.isComplete ? 0.5 : 1,
      })
      barGroup.appendChild(progRect)
    }

    // D2: When bar pixel width < 96px, position label 8px to the right of the bar (fill var(--text-secondary))
    const isExternalLabel = barW < 96
    const labelEl = svgEl("text", {
      x: isExternalLabel ? pos.x + barW + 8 : pos.x + 10,
      y: barY + BAR_HEIGHT / 2 + 1,
      fill: isExternalLabel ? "var(--text-secondary)" : "var(--text-on-accent, #fff)",
      "font-size": 11,
      "font-weight": 500,
      "font-family": "inherit",
      "dominant-baseline": "central",
      "data-label-placement": isExternalLabel ? "outside" : "inside",
    })
    if (isExternalLabel) {
      labelEl.textContent = bar.name
    } else {
      const maxChars = Math.max(6, Math.floor((barW - 20) / 6.6))
      labelEl.textContent = bar.name.length > maxChars ? `${bar.name.slice(0, maxChars - 1)}…` : bar.name
    }
    if (bar.isComplete) {
      labelEl.style.textDecoration = "line-through"
      labelEl.style.opacity = "0.6"
    }
    barGroup.appendChild(labelEl)

    if (bar.taskType === "epic") {
      barGroup.appendChild(
        svgEl("rect", {
          x: pos.x, y: barY, width: barW, height: 3,
          rx: BAR_RADIUS, fill: "var(--text-on-accent, #fff)", opacity: 0.4,
        }),
      )
    }

    const leftHandle = svgEl("rect", {
      class: "gantt-resize-handle gantt-resize-handle--left",
      x: pos.x - 2, y: barY + 4, width: HANDLE_WIDTH, height: BAR_HEIGHT - 8,
      rx: 2, fill: "var(--text-primary)", opacity: 0, cursor: "ew-resize",
    })
    const rightHandle = svgEl("rect", {
      class: "gantt-resize-handle gantt-resize-handle--right",
      x: pos.x + barW - HANDLE_WIDTH + 2, y: barY + 4, width: HANDLE_WIDTH, height: BAR_HEIGHT - 8,
      rx: 2, fill: "var(--text-primary)", opacity: 0, cursor: "ew-resize",
    })

    setupBarDrag(
      barGroup,
      bgRect,
      bar,
      pos,
      pxPerDay,
      config,
      rowSignal,
      (dragging) => { activeDragTaskId = dragging ? bar.id : null },
      () => { renderGantt(outerContainer, bars, zoom, _parentSignal, undatedTasks, groupByKey) },
    )
    setupResizeDrag(
      leftHandle,
      "start",
      bar,
      pos,
      pxPerDay,
      config,
      bgRect,
      progRect,
      labelEl,
      leftHandle,
      rightHandle,
      rowSignal,
      (dragging) => { activeDragTaskId = dragging ? bar.id : null },
      () => { renderGantt(outerContainer, bars, zoom, _parentSignal, undatedTasks, groupByKey) },
    )
    setupResizeDrag(
      rightHandle,
      "end",
      bar,
      pos,
      pxPerDay,
      config,
      bgRect,
      progRect,
      labelEl,
      leftHandle,
      rightHandle,
      rowSignal,
      (dragging) => { activeDragTaskId = dragging ? bar.id : null },
      () => { renderGantt(outerContainer, bars, zoom, _parentSignal, undatedTasks, groupByKey) },
    )

    barGroup.appendChild(leftHandle)
    barGroup.appendChild(rightHandle)
    sidebarTarget.appendChild(row)
    svgTarget.appendChild(barGroup)
    return { sidebarEl: row, svgEl: barGroup, cleanup: rowCleanups.length ? () => rowCleanups.forEach(fn => fn()) : undefined }
  }

  let lastWindowKey = ""

  function syncVirtualWindow(force = false) {
    if (totalRowCount === 0) {
      for (const [, entry] of mountedRows) {
        entry.cleanup?.()
        entry.sidebarEl.remove()
        entry.svgEl?.remove()
      }
      mountedRows.clear()
      arrowGroup.replaceChildren()
      return
    }

    const scrollTop = scrollWrapper.scrollTop
    const viewportH = scrollWrapper.clientHeight > 0 ? scrollWrapper.clientHeight : 600
    const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 8)
    const endRow = Math.min(totalRowCount - 1, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + 8)
    const focusRow = activeFocusedTaskId !== null ? (taskRowIndexById.get(activeFocusedTaskId) ?? -1) : -1
    const dragRow = activeDragTaskId !== null ? (taskRowIndexById.get(activeDragTaskId) ?? -1) : -1
    const windowKey = `${startRow}:${endRow}:${focusRow}:${dragRow}`
    if (!force && windowKey === lastWindowKey) return
    lastWindowKey = windowKey

    const wanted = new Set<number>()
    for (let r = startRow; r <= endRow; r++) wanted.add(r)
    if (focusRow >= 0 && focusRow < totalRowCount) wanted.add(focusRow)
    if (dragRow >= 0 && dragRow < totalRowCount) wanted.add(dragRow)

    for (const [idx, entry] of mountedRows) {
      if (!wanted.has(idx)) {
        entry.cleanup?.()
        entry.sidebarEl.remove()
        entry.svgEl?.remove()
        mountedRows.delete(idx)
      }
    }

    const sidebarFrag = document.createDocumentFragment()
    const svgFrag = document.createDocumentFragment()
    for (const idx of wanted) {
      if (!mountedRows.has(idx)) {
        const mounted = mountDisplayRow(idx, sidebarFrag, svgFrag)
        if (mounted) mountedRows.set(idx, mounted)
      }
    }
    if (sidebarFrag.childNodes.length > 0) sidebarTrack.appendChild(sidebarFrag)
    if (svgFrag.childNodes.length > 0) barsGroup.appendChild(svgFrag)

    // Mount dependency <path> connectors whenever at least one endpoint row is mounted
    if (dependencyEdges.length > 0) {
      arrowGroup.replaceChildren()
      for (const edge of dependencyEdges) {
        if (wanted.has(edge.fromRow) || wanted.has(edge.toRow)) {
          arrowGroup.appendChild(
            svgEl("path", {
              class: "gantt-dep-arrow",
              "data-from-id": edge.fromId,
              "data-to-id": edge.toId,
              d: edge.d,
              stroke: "var(--text-muted)",
              "stroke-width": 1.5,
              fill: "none",
              opacity: 0.35,
              "marker-end": "url(#arrowhead)",
            }),
          )
        }
      }
    }
  }

  // ── Delegated Row & Bar Interaction Handlers (Zero Per-Row Listeners) ─

  sidebarTrack.addEventListener("focusin", (e) => {
    const rowEl = (e.target as Element | null)?.closest<HTMLElement>(".gantt-vrow")
    if (!rowEl) return
    const rIdx = Number(rowEl.dataset.rowIndex ?? -1)
    const dRow = displayRows[rIdx]
    if (dRow?.kind === "bar") {
      activeFocusedTaskId = dRow.bar.id
      const navIdx = navigableRowIndices.indexOf(rIdx)
      if (navIdx !== -1) focusedNavPos = navIdx
    }
  }, { signal })

  sidebarTrack.addEventListener("pointerover", (e) => {
    const rowEl = (e.target as Element | null)?.closest<HTMLElement>(".gantt-vrow")
    if (!rowEl) return
    setChartRowHighlight(Number(rowEl.dataset.rowIndex ?? -1))
  }, { signal })

  sidebarTrack.addEventListener("pointerout", (e) => {
    const rowEl = (e.target as Element | null)?.closest<HTMLElement>(".gantt-vrow")
    if (!rowEl || rowEl.contains(e.relatedTarget as Node | null)) return
    setChartRowHighlight(null)
  }, { signal })

  sidebarTrack.addEventListener("click", (e) => {
    const target = e.target as Element | null
    if (!target || target.closest(".idp-container, .gantt-sidebar-toggle")) return
    const rowEl = target.closest<HTMLElement>(".gantt-vrow")
    if (!rowEl) return
    const rIdx = Number(rowEl.dataset.rowIndex ?? -1)
    const dRow = displayRows[rIdx]
    if (dRow?.kind !== "bar") return
    e.stopPropagation()
    e.preventDefault()
    const pos = barPositions.get(dRow.bar.id)
    if (pos && !isNaN(pos.x)) {
      scrollWrapper.scrollTo({
        left: pos.x - scrollWrapper.clientWidth / 3,
        behavior: REDUCED_MOTION ? "instant" : "smooth",
      })
    }
    showPopup(dRow.bar, e.clientX, e.clientY, document.body, signal)
  }, { signal })

  sidebarTrack.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null
    if (!target || target.closest(".idp-container")) return
    if (e.key === "Enter" || e.key === " ") {
      const rowEl = target.closest<HTMLElement>(".gantt-vrow")
      if (rowEl) {
        e.preventDefault()
        rowEl.click()
      }
    }
  }, { signal })

  barsGroup.addEventListener("focusin", (e) => {
    const groupEl = (e.target as Element | null)?.closest<SVGGElement>(".gantt-bar, .gantt-milestone")
    if (!groupEl) return
    const rIdx = Number(groupEl.getAttribute("data-row-index") ?? -1)
    const dRow = displayRows[rIdx]
    if (dRow?.kind === "bar") {
      activeFocusedTaskId = dRow.bar.id
      const navIdx = navigableRowIndices.indexOf(rIdx)
      if (navIdx !== -1) focusedNavPos = navIdx
    }
  }, { signal })

  barsGroup.addEventListener("pointerover", (e) => {
    const groupEl = (e.target as Element | null)?.closest<SVGGElement>(".gantt-bar, .gantt-milestone")
    if (!groupEl) return
    const rIdx = Number(groupEl.getAttribute("data-row-index") ?? -1)
    const dRow = displayRows[rIdx]
    if (dRow?.kind !== "bar") return
    showTooltip(dRow.bar, e.clientX, e.clientY, document.body)
    setChartRowHighlight(rIdx)
    mountedRows.get(rIdx)?.sidebarEl.classList.add("gantt-vrow--hover")
    groupEl.querySelectorAll(".gantt-resize-handle").forEach((h) => h.setAttribute("opacity", "0.4"))
  }, { signal })

  barsGroup.addEventListener("pointerout", (e) => {
    const groupEl = (e.target as Element | null)?.closest<SVGGElement>(".gantt-bar, .gantt-milestone")
    if (!groupEl || groupEl.contains(e.relatedTarget as Node | null)) return
    const rIdx = Number(groupEl.getAttribute("data-row-index") ?? -1)
    hideTooltip()
    setChartRowHighlight(null)
    mountedRows.get(rIdx)?.sidebarEl.classList.remove("gantt-vrow--hover")
    groupEl.querySelectorAll(".gantt-resize-handle").forEach((h) => h.setAttribute("opacity", "0"))
  }, { signal })

  barsGroup.addEventListener("click", (e) => {
    const groupEl = (e.target as Element | null)?.closest<SVGGElement>(".gantt-bar, .gantt-milestone")
    if (!groupEl) return
    const rIdx = Number(groupEl.getAttribute("data-row-index") ?? -1)
    const dRow = displayRows[rIdx]
    if (dRow?.kind !== "bar") return
    e.stopPropagation()
    hideTooltip()
    showPopup(dRow.bar, e.clientX, e.clientY, document.body, signal)
  }, { signal })

  barsGroup.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return
    const groupEl = (e.target as Element | null)?.closest<SVGGElement>(".gantt-bar, .gantt-milestone")
    if (!groupEl) return
    const rIdx = Number(groupEl.getAttribute("data-row-index") ?? -1)
    const dRow = displayRows[rIdx]
    if (dRow?.kind !== "bar") return
    e.preventDefault()
    const rect = groupEl.getBoundingClientRect()
    showPopup(dRow.bar, rect.left, rect.bottom, document.body, signal)
  }, { signal })

  // ── Sync sidebar + header scroll with chart (rAF-coalesced windowing) ─

  let scrollSaveTimer: ReturnType<typeof setTimeout> | null = null
  let virtualRafId = 0

  function scheduleVirtualSync() {
    if (virtualRafId !== 0) return
    virtualRafId = requestAnimationFrame(() => {
      virtualRafId = 0
      if (!signal.aborted) syncVirtualWindow()
    })
  }

  scrollWrapper.addEventListener("scroll", () => {
    sidebarTrack.style.transform = `translateY(-${scrollWrapper.scrollTop}px)`
    headerSvg.style.transform = `translateX(-${scrollWrapper.scrollLeft}px)`
    scheduleVirtualSync()
    if (scrollSaveTimer) clearTimeout(scrollSaveTimer)
    scrollSaveTimer = setTimeout(() => {
      localStorage.setItem(`${SCROLL_KEY_PREFIX}${zoom}`, String(scrollWrapper.scrollLeft))
    }, 150)
  }, { signal, passive: true })

  let resizeObserver: ResizeObserver | null = null
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
      if (!signal.aborted) scheduleVirtualSync()
    })
    resizeObserver.observe(scrollWrapper)
  }

  signal.addEventListener("abort", () => {
    if (virtualRafId !== 0) { cancelAnimationFrame(virtualRafId); virtualRafId = 0 }
    resizeObserver?.disconnect()
    resizeObserver = null
    if (scrollSaveTimer) { clearTimeout(scrollSaveTimer); scrollSaveTimer = null }
    for (const [, entry] of mountedRows) entry.cleanup?.()
    mountedRows.clear()
  }, { once: true })

  // ── Restore horizontal & vertical scroll before initial window mount ─

  const savedScroll = localStorage.getItem(`${SCROLL_KEY_PREFIX}${zoom}`)
  if (savedScroll) {
    scrollWrapper.scrollLeft = Number(savedScroll)
  } else if (todayX > 0) {
    scrollWrapper.scrollLeft = todayX - scrollWrapper.clientWidth / 3
  }
  if (preservedScrollTop > 0) {
    scrollWrapper.scrollTop = preservedScrollTop
  }
  sidebarTrack.style.transform = `translateY(-${scrollWrapper.scrollTop}px)`
  headerSvg.style.transform = `translateX(-${scrollWrapper.scrollLeft}px)`
  syncVirtualWindow(true)

  // ── T5: Scroll-to-Today FAB ──────────────────────────────────────────

  const fab = document.createElement("button")
  fab.className = "gantt-today-fab"
  fab.title = "Scroll to today (T)"
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
    background:var(--bg-card);color:var(--accent);
    cursor:pointer;display:flex;align-items:center;justify-content:center;
    box-shadow:var(--shadow-md, 0 4px 16px rgba(0,0,0,0.2));
    transition:transform 0.2s,box-shadow 0.2s;
  `
  if (!REDUCED_MOTION) {
    fab.addEventListener("mouseenter", () => { fab.style.transform = "scale(1.1)" }, { signal })
    fab.addEventListener("mouseleave", () => { fab.style.transform = "scale(1)" }, { signal })
  }
  fab.addEventListener("click", () => {
    scrollWrapper.scrollTo({ left: todayX - scrollWrapper.clientWidth / 3, behavior: REDUCED_MOTION ? "instant" : "smooth" })
  }, { signal })
  outerContainer.style.position = "relative"
  outerContainer.appendChild(fab)

  const scrollTodayBtn = document.getElementById("timeline-scroll-today")
  if (scrollTodayBtn) {
    scrollTodayBtn.addEventListener("click", () => {
      scrollWrapper.scrollTo({ left: todayX - scrollWrapper.clientWidth / 3, behavior: REDUCED_MOTION ? "instant" : "smooth" })
    }, { signal })
  }

  if (!REDUCED_MOTION) {
    fab.animate([
      { boxShadow: "0 0 0 0 color-mix(in srgb, var(--accent) 40%, transparent)" },
      { boxShadow: "0 0 0 8px transparent" },
    ], { duration: 1500, iterations: 2 })
  }

  // ── T6 + M5 + M6 + D2: Index-driven Keyboard Navigation ──────────────

  function scrollRowIntoView(rowIndex: number) {
    const rowTop = rowIndex * ROW_HEIGHT
    const rowBottom = rowTop + ROW_HEIGHT
    const viewH = scrollWrapper.clientHeight
    if (viewH > 0) {
      if (rowTop < scrollWrapper.scrollTop) {
        scrollWrapper.scrollTop = rowTop
      } else if (rowBottom > scrollWrapper.scrollTop + viewH) {
        scrollWrapper.scrollTop = rowBottom - viewH
      }
    }
    sidebarTrack.style.transform = `translateY(-${scrollWrapper.scrollTop}px)`
  }

  function focusNavigableRow(nextNavPos: number) {
    if (navigableRowIndices.length === 0) return
    focusedNavPos = Math.max(0, Math.min(nextNavPos, navigableRowIndices.length - 1))
    const targetRowIndex = navigableRowIndices[focusedNavPos]!
    const targetRow = displayRows[targetRowIndex]
    if (targetRow && targetRow.kind === "bar") {
      activeFocusedTaskId = targetRow.bar.id
    }
    scrollRowIntoView(targetRowIndex)
    syncVirtualWindow(true)

    sidebarTrack.querySelectorAll(".gantt-sidebar-row--focused").forEach(el => {
      el.classList.remove("gantt-sidebar-row--focused")
    })
    const sidebarRowEl = sidebarTrack.querySelector<HTMLElement>(`.gantt-sidebar-row[data-row-index="${targetRowIndex}"]`)
    sidebarRowEl?.classList.add("gantt-sidebar-row--focused")
    setChartRowHighlight(targetRowIndex)

    const barEl = barsGroup.querySelector<SVGGElement>(
      `.gantt-bar[data-row-index="${targetRowIndex}"], .gantt-milestone[data-row-index="${targetRowIndex}"]`,
    )
    barEl?.focus({ preventScroll: true })
  }

  const keyHandler = (e: KeyboardEvent) => {
    const timelineContainer = document.getElementById("tasks-view-timeline")
    if (!timelineContainer || timelineContainer.style.display === "none" || timelineContainer.classList.contains("hidden")) return

    const modalTdOpen = (document.getElementById("task-detail-overlay")?.classList.contains("active") ?? false) &&
      !document.body.classList.contains("has-docked-inspector")
    const searchHubOpen = Boolean(document.querySelector("#search-hub-overlay:not(.hidden)"))
    const shortcutHelpOpen = Boolean(document.querySelector("#shortcut-modal:not(.hidden)"))
    if (hasPriorityOverlay() || modalTdOpen || searchHubOpen || shortcutHelpOpen) return

    const tag = (e.target as HTMLElement).tagName
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement)?.isContentEditable) return
    if (isDisabledCharacterShortcut(e.key)) return

    switch (e.key) {
      case "t":
      case "T":
        e.preventDefault()
        scrollWrapper.scrollTo({ left: todayX - scrollWrapper.clientWidth / 3, behavior: REDUCED_MOTION ? "instant" : "smooth" })
        break

      case "ArrowDown":
      case "j":
        if (navigableRowIndices.length > 0) {
          e.preventDefault()
          focusNavigableRow(focusedNavPos + 1)
        }
        break
      case "ArrowUp":
      case "k":
        if (navigableRowIndices.length > 0) {
          e.preventDefault()
          focusNavigableRow(focusedNavPos <= 0 ? 0 : focusedNavPos - 1)
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
      case "+":
      case "=":
        e.preventDefault()
        {
          const idx = ZOOM_ORDER.indexOf(zoom)
          if (idx > 0) {
            const newZoom = ZOOM_ORDER[idx - 1]!
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
            window.dispatchEvent(new CustomEvent("meitheal:timeline-zoom", { detail: { zoom: newZoom } }))
          }
        }
        break
    }
  }
  document.addEventListener("keydown", keyHandler, { signal })

  svg.addEventListener("click", () => {
    document.querySelectorAll(".gantt-popup").forEach(p => p.remove())
  }, { signal })
}

// ── T3: Drag Helpers (In-Place Attribute Mutation on Retained Node) ────────

function setupBarDrag(
  barGroup: SVGGElement,
  _bgRect: SVGRectElement,
  bar: GanttBar,
  _pos: { x: number; y: number; w: number },
  pxPerDay: number,
  _config: ZoomConfig,
  signal: AbortSignal,
  onDragStateChange: (dragging: boolean) => void,
  onComplete: () => void,
) {
  let isDragging = false
  let dragOriginX = 0
  let dragAbort: AbortController | null = null
  const elemOrigPositions = new Map<Element, number>()

  const onMove = (e: MouseEvent | TouchEvent) => {
    if (!isDragging) return
    if ("touches" in e && (!e.touches || e.touches.length === 0)) return
    const clientX = "touches" in e ? e.touches[0]!.clientX : (e as MouseEvent).clientX
    const totalDx = clientX - dragOriginX
    document.body.style.cursor = "grabbing"
    elemOrigPositions.forEach((origPos, el) => {
      el.setAttribute("x", String(origPos + totalDx))
    })
  }

  const onUp = async (e: MouseEvent | TouchEvent) => {
    if (!isDragging) return
    isDragging = false
    dragAbort?.abort()
    dragAbort = null
    onDragStateChange(false)
    document.body.style.cursor = ""
    if ("changedTouches" in e && (!e.changedTouches || e.changedTouches.length === 0)) {
      onComplete()
      return
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
      onComplete()
    } else {
      showToast("Failed to update dates", "error")
      onComplete()
    }
  }

  const attachActiveDragListeners = () => {
    dragAbort?.abort()
    dragAbort = new AbortController()
    const activeSig = AbortSignal.any([signal, dragAbort.signal])
    document.addEventListener("mousemove", onMove, { signal: activeSig })
    document.addEventListener("mouseup", onUp, { signal: activeSig })
    document.addEventListener("touchmove", onMove as unknown as EventListener, { signal: activeSig, passive: false })
    document.addEventListener("touchend", onUp as unknown as EventListener, { signal: activeSig })
  }

  barGroup.addEventListener("mousedown", (e) => {
    const target = e.target as SVGElement
    if (target.style.cursor === "ew-resize") return
    if (e.button !== 0) return
    isDragging = true
    onDragStateChange(true)
    dragOriginX = e.clientX
    elemOrigPositions.clear()
    barGroup.querySelectorAll("rect").forEach((r) => {
      elemOrigPositions.set(r, Number(r.getAttribute("x") || 0))
    })
    barGroup.querySelectorAll("text").forEach((t) => {
      elemOrigPositions.set(t, Number(t.getAttribute("x") || 0))
    })
    attachActiveDragListeners()
    e.preventDefault()
    e.stopPropagation()
  }, { signal })

  barGroup.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return
    const touch = e.touches[0]!
    isDragging = true
    onDragStateChange(true)
    dragOriginX = touch.clientX
    elemOrigPositions.clear()
    barGroup.querySelectorAll("rect").forEach((r) => {
      elemOrigPositions.set(r, Number(r.getAttribute("x") || 0))
    })
    barGroup.querySelectorAll("text").forEach((t) => {
      elemOrigPositions.set(t, Number(t.getAttribute("x") || 0))
    })
    attachActiveDragListeners()
    e.preventDefault()
  }, { signal, passive: false })
}

function setupResizeDrag(
  handle: SVGRectElement,
  edge: "start" | "end",
  bar: GanttBar,
  pos: { x: number },
  pxPerDay: number,
  _config: ZoomConfig,
  bgRect: SVGRectElement,
  progRect: SVGRectElement | null,
  labelEl: SVGTextElement,
  leftHandle: SVGRectElement,
  rightHandle: SVGRectElement,
  signal: AbortSignal,
  onDragStateChange: (dragging: boolean) => void,
  onComplete: () => void,
) {
  let isDragging = false
  let dragOriginX = 0
  let origBarX = pos.x
  let origBarW = 0
  let dragAbort: AbortController | null = null

  const updateBarGeometry = (newX: number, newW: number) => {
    bgRect.setAttribute("x", String(newX))
    bgRect.setAttribute("width", String(newW))
    if (progRect) {
      progRect.setAttribute("x", String(newX))
      progRect.setAttribute("width", String(Math.min((bar.progress / 100) * newW, newW)))
    }
    leftHandle.setAttribute("x", String(newX - 2))
    rightHandle.setAttribute("x", String(newX + newW - HANDLE_WIDTH + 2))
    if (newW < 96) {
      labelEl.setAttribute("x", String(newX + newW + 8))
      labelEl.setAttribute("fill", "var(--text-secondary)")
      labelEl.setAttribute("data-label-placement", "outside")
      labelEl.textContent = bar.name
    } else {
      labelEl.setAttribute("x", String(newX + 10))
      labelEl.setAttribute("fill", "var(--text-on-accent, #fff)")
      labelEl.setAttribute("data-label-placement", "inside")
      const maxChars = Math.max(6, Math.floor((newW - 20) / 6.6))
      labelEl.textContent = bar.name.length > maxChars ? `${bar.name.slice(0, maxChars - 1)}…` : bar.name
    }
  }

  const onMove = (e: MouseEvent | TouchEvent) => {
    if (!isDragging) return
    if ("touches" in e && (!e.touches || e.touches.length === 0)) return
    document.body.style.cursor = "ew-resize"
    const clientX = "touches" in e ? e.touches[0]!.clientX : (e as MouseEvent).clientX
    const dx = clientX - dragOriginX
    if (edge === "start") {
      const newX = origBarX + dx
      const newW = origBarW - dx
      if (newW > 20) updateBarGeometry(newX, newW)
    } else {
      const newW = Math.max(20, origBarW + dx)
      updateBarGeometry(origBarX, newW)
    }
  }

  const onUp = async (e: MouseEvent | TouchEvent) => {
    if (!isDragging) return
    isDragging = false
    dragAbort?.abort()
    dragAbort = null
    onDragStateChange(false)
    document.body.style.cursor = ""

    if ("changedTouches" in e && (!e.changedTouches || e.changedTouches.length === 0)) {
      onComplete()
      return
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
    onComplete()
  }

  const attachActiveResizeListeners = () => {
    dragAbort?.abort()
    dragAbort = new AbortController()
    const activeSig = AbortSignal.any([signal, dragAbort.signal])
    document.addEventListener("mousemove", onMove, { signal: activeSig })
    document.addEventListener("mouseup", onUp, { signal: activeSig })
    document.addEventListener("touchmove", onMove as unknown as EventListener, { signal: activeSig, passive: false })
    document.addEventListener("touchend", onUp as unknown as EventListener, { signal: activeSig })
  }

  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return
    isDragging = true
    onDragStateChange(true)
    dragOriginX = e.clientX
    origBarX = Number(bgRect.getAttribute("x") || pos.x)
    origBarW = Number(bgRect.getAttribute("width") || 0)
    attachActiveResizeListeners()
    e.preventDefault()
    e.stopPropagation()
  }, { signal })

  handle.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return
    isDragging = true
    onDragStateChange(true)
    dragOriginX = e.touches[0]!.clientX
    origBarX = Number(bgRect.getAttribute("x") || pos.x)
    origBarW = Number(bgRect.getAttribute("width") || 0)
    attachActiveResizeListeners()
    e.preventDefault()
    e.stopPropagation()
  }, { signal, passive: false })
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
    ganttLog.error("Failed to parse task data")
    return
  }

  const { dated: allBars, undated: allUndated } = mapTasks(tasks)

  // Load area name lookup from SSR data
  const areasEl = document.getElementById("timeline-areas")
  if (areasEl) {
    try { areaLookup = JSON.parse(areasEl.textContent || "{}") } catch { /* ignore */ }
  }

  // Load project name lookup from SSR data
  const projectsEl = document.getElementById("timeline-projects")
  if (projectsEl) {
    try { projectLookup = JSON.parse(projectsEl.textContent || "{}") } catch { /* ignore */ }
  }

  initAreaSelector(signal)
  const initial = loadFilterState()
  let currentFilter: TimelineFilterState = {
    search: initial.search ?? "",
    status: initial.status ?? "",
    priority: initial.priority ?? "",
    types: initial.types ?? [],
    area: getSelectedAreaId(),
    groupBy: initial.groupBy ?? "none",
  }

  function getVisibleBars(): GanttBar[] {
    return filterBars(allBars, currentFilter)
  }

  /** Filter undated tasks by current active filters */
  function getVisibleUndated(): TimelineTask[] {
    let result = allUndated
    if (currentFilter.search) {
      const q = currentFilter.search.toLowerCase()
      result = result.filter(t => t.title.toLowerCase().includes(q))
    }
    if (currentFilter.status) {
      if (currentFilter.status === "overdue") {
        result = result.filter(t => t.is_overdue)
      } else {
        result = result.filter(t => t.status === currentFilter.status)
      }
    }
    if (currentFilter.priority) {
      result = result.filter(t => String(t.priority) === currentFilter.priority)
    }
    if (currentFilter.types.length > 0) {
      result = result.filter(t => currentFilter.types.includes(t.task_kind || "standard_action"))
    }
    if (currentFilter.area) {
      result = result.filter(t => t.area_id === currentFilter.area)
    }
    return result
  }

  function doRender(zoom: ZoomLevel) {
    const bars = getVisibleBars()
    const undated = getVisibleUndated()
    if (bars.length === 0 && undated.length === 0) {
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
    container!.style.display = "flex"
    renderGantt(container!, bars, zoom, signal, undated, currentFilter.groupBy)

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

  if (skeleton) skeleton.style.display = "none"

  const savedZoom = localStorage.getItem(ZOOM_KEY) as ZoomLevel | null
  const validZooms: ZoomLevel[] = ["Day", "Week", "Month"]
  let currentZoom: ZoomLevel = savedZoom && validZooms.includes(savedZoom) ? savedZoom : "Week"

  // Initial render
  doRender(currentZoom)

  // Wire zoom dropdown (custom <details> dropdown instead of <select>)
  const zoomLabel = document.getElementById("timeline-zoom-label")
  const zoomDropdown = document.getElementById("timeline-zoom-dropdown") as HTMLDetailsElement | null

  /** Update the zoom dropdown label and active state */
  function updateZoomLabel(z: ZoomLevel) {
    if (zoomLabel) {
      zoomLabel.innerHTML = `${z} <svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
    }
    // Update active option styling
    document.querySelectorAll(".timeline-zoom-option").forEach((btn) => {
      const isActive = btn.getAttribute("data-zoom") === z
      btn.classList.toggle("timeline-zoom-option--active", isActive)
      const check = btn.querySelector("svg")
      if (check) (check as SVGElement).style.opacity = isActive ? "1" : "0"
    })
  }

  // Set initial label from saved zoom
  updateZoomLabel(currentZoom)

  // Listen for zoom option clicks
  document.querySelectorAll(".timeline-zoom-option").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation()
      const z = (btn as HTMLElement).getAttribute("data-zoom") as ZoomLevel
      if (z && ["Day", "Week", "Month"].includes(z)) {
        currentZoom = z
        localStorage.setItem(ZOOM_KEY, currentZoom)
        updateZoomLabel(z)
        if (zoomDropdown) zoomDropdown.open = false
        doRender(currentZoom)
      }
    }, { signal })
  })

  // Wire sidebar toggle button (⊞)
  const sidebarToggle = document.getElementById("timeline-sidebar-toggle")
  if (sidebarToggle) {
    sidebarToggle.addEventListener("click", () => {
      showSidebar = !showSidebar
      try { localStorage.setItem("meitheal-gantt-show-sidebar", String(showSidebar)) } catch { /* ignore */ }
      doRender(currentZoom)
    }, { signal })
  }

  // M6: Listen for zoom keyboard shortcut dispatches
  window.addEventListener("meitheal:timeline-zoom", ((e: CustomEvent) => {
    const newZoom = e.detail?.zoom as ZoomLevel
    if (newZoom && validZooms.includes(newZoom)) {
      currentZoom = newZoom
      localStorage.setItem(ZOOM_KEY, currentZoom)
      updateZoomLabel(currentZoom)
      doRender(currentZoom)
    }
  }) as EventListener, { signal })

  function applyFilters(): void {
    const url = new URL(location.href)
    for (const key of ["search", "status", "priority", "groupBy"] as const) {
      const value = currentFilter[key]
      if (value && value !== "none") url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    }
    if (currentFilter.types.length) url.searchParams.set("types", currentFilter.types.join(","))
    else url.searchParams.delete("types")
    url.searchParams.set("area", currentFilter.area)
    history.replaceState(history.state, "", url)
    doRender(currentZoom)
  }

  document.addEventListener("meitheal:filter-change", ((e: CustomEvent) => {
    const detail = e.detail ?? {}
    if (detail.view !== "timeline") return

    currentFilter = {
      ...currentFilter,
      search: detail.search ?? "",
      status: detail.status ?? "",
      priority: detail.priority ?? "",
      types: detail.types ?? [],
      groupBy: detail.groupBy ?? "none",
    }
    applyFilters()
  }) as EventListener, { signal })

  // M1: Listen for area selector changes from the nav bar "All Areas" dropdown
  document.addEventListener("meitheal:area-changed", ((e: CustomEvent) => {
    const areaId = e.detail?.areaId ?? ""
    currentFilter = { ...currentFilter, area: areaId }
    applyFilters()
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
