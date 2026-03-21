/**
 * Timeline/GANTT Controller — client-side Frappe Gantt initialization.
 * @domain Task Visualization
 *
 * Initializes an interactive SVG GANTT chart using Frappe Gantt.
 * Reads task data from a JSON blob rendered server-side.
 * Wires drag-and-drop events to PATCH API for inline editing.
 * Persists zoom level preference in localStorage.
 *
 * @usage Called from timeline.astro via pageLifecycle.onPageLoad()
 */

import Gantt from "frappe-gantt"

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

// ── Priority Colour Map ────────────────────────────────────────────────────

const PRIORITY_COLOURS: Record<number, string> = {
  1: "#EF4444", // P1 — urgent red
  2: "#F97316", // P2 — high orange
  3: "#3B82F6", // P3 — normal blue
  4: "#9CA3AF", // P4 — low grey
}

// ── Sanitization ───────────────────────────────────────────────────────────

function sanitize(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// ── Status Helpers ─────────────────────────────────────────────────────────

function isComplete(status: string): boolean {
  return status === "complete" || status === "done"
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

// ── localStorage Keys ──────────────────────────────────────────────────────

const ZOOM_KEY = "meitheal-timeline-zoom"

// ── Task Data Mapping ──────────────────────────────────────────────────────

function mapTasksToGantt(tasks: TimelineTask[]) {
  const today = new Date().toISOString().split("T")[0]!

  return tasks
    .filter((t) => {
      // At minimum need a start or due date to place on timeline
      return t.start_date || t.due_date
    })
    .map((t) => {
      const start = t.start_date || t.due_date || today
      const end = t.end_date || t.due_date || start

      // Parse dependencies from blocked_by (comma-separated task IDs)
      const deps: string[] = []
      if (t.blocked_by) {
        try {
          const parsed = JSON.parse(t.blocked_by)
          if (Array.isArray(parsed)) {
            deps.push(...parsed.filter((d: unknown) => typeof d === "string" && d.length > 0))
          }
        } catch {
          // blocked_by may be a plain comma-separated string
          deps.push(
            ...t.blocked_by
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          )
        }
      }

      // Determine bar colour
      const barColour = t.color || PRIORITY_COLOURS[t.priority] || "#6366F1"

      // Build display name with ticket number
      const ticketPrefix = t.ticket_number ? `MTH-${t.ticket_number} ` : ""
      const name = sanitize(`${ticketPrefix}${t.title}`)

      // Custom class for type-based styling
      const taskType = String(t.task_type || "task")
      const customClass = isComplete(t.status)
        ? `type-${taskType} is-complete`
        : `type-${taskType}`

      return {
        id: t.id,
        name,
        start,
        end,
        progress: Number(t.progress ?? 0),
        dependencies: deps,
        color: barColour,
        custom_class: customClass,
        description: `${statusLabel(t.status)} · Priority ${t.priority}`,
        // Store original data for popup
        _meitheal: t,
      }
    })
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

// ── Format Date ────────────────────────────────────────────────────────────

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-IE", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

function toISODate(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

// ── Controller ─────────────────────────────────────────────────────────────

// Gantt instance reference for potential refresh operations
let _ganttInstance: InstanceType<typeof Gantt> | null = null

export function initTimelineController(signal: AbortSignal) {
  const container = document.getElementById("gantt-chart")
  const dataEl = document.getElementById("timeline-data")
  const emptyState = document.getElementById("timeline-empty")
  const skeleton = document.getElementById("timeline-skeleton")

  if (!container || !dataEl) return

  // Parse task data from SSR JSON blob
  let tasks: TimelineTask[] = []
  try {
    tasks = JSON.parse(dataEl.textContent || "[]")
  } catch {
    console.error("[timeline] Failed to parse task data")
    return
  }

  // Map to Frappe Gantt format
  const ganttTasks = mapTasksToGantt(tasks)

  // Handle empty state
  if (ganttTasks.length === 0) {
    if (skeleton) skeleton.style.display = "none"
    if (emptyState) emptyState.style.display = "flex"
    container.style.display = "none"
    return
  }

  // Hide empty state and skeleton
  if (emptyState) emptyState.style.display = "none"
  if (skeleton) skeleton.style.display = "none"
  container.style.display = "block"

  // Read persisted zoom preference
  const savedZoom = localStorage.getItem(ZOOM_KEY)
  const validZooms = ["Day", "Week", "Month", "Year"]
  const initialZoom = savedZoom && validZooms.includes(savedZoom) ? savedZoom : "Week"

  // Initialize Frappe Gantt
  try {
    _ganttInstance = new Gantt(container, ganttTasks, {
      // View configuration
      view_mode: initialZoom as "Day" | "Week" | "Month" | "Year",
      view_mode_select: true,
      view_modes: ["Day", "Week", "Month", "Year"],

      // Dimensions
      bar_height: 28,
      bar_corner_radius: 4,
      padding: 16,
      column_width: 45,
      container_height: "auto",

      // Behavior
      snap_at: "1d",
      infinite_padding: true,
      move_dependencies: true,
      readonly: false,

      // Dates
      date_format: "YYYY-MM-DD",
      language: document.documentElement.lang || "en",
      scroll_to: "today",

      // Visual features
      lines: "both",
      arrow_curve: 5,
      today_button: true,

      // Holidays — highlight weekends
      holidays: {
        "var(--g-weekend-highlight-color)": "weekend",
      },

      // Custom popup
      popup_on: "click",
      popup: (ctx) => {
        type PopupTask = { id: string; name: string; _start: Date; _end: Date; progress?: number; description?: string; _meitheal?: TimelineTask; [key: string]: unknown }
        const task = ctx.task as PopupTask
        const original = task._meitheal as TimelineTask | undefined
        ctx.set_title(task.name)
        ctx.set_subtitle(task.description || "")

        const startStr = fmtDate(task._start)
        const endStr = fmtDate(task._end)
        const progress = Number(task.progress ?? 0)
        const statusBadge = original ? statusLabel(original.status) : ""
        const progressBar = `<div style="background:var(--bg-secondary);border-radius:4px;height:6px;margin:6px 0;overflow:hidden"><div style="background:var(--accent);height:100%;width:${progress}%;border-radius:4px"></div></div>`

        ctx.set_details(
          `${startStr} → ${endStr}<br/>${statusBadge} · ${progress}% complete${progressBar}<a href="javascript:void(0)" class="gantt-popup-detail-link" data-task-id="${task.id}" style="color:var(--accent);font-size:12px;text-decoration:underline;margin-top:4px;display:inline-block">View Details →</a>`,
        )
      },

      // Event: date changed via drag
      on_date_change: async (
        task: { id: string; _start: Date; _end: Date },
        start: Date,
        end: Date,
      ) => {
        const startStr = toISODate(start)
        const endStr = toISODate(end)

        // Validate: end must be >= start
        if (end < start) {
          showToast("End date cannot be before start date", "error")
          return
        }

        const ok = await patchTask(task.id, {
          start_date: startStr,
          end_date: endStr,
          due_date: endStr,
        })

        if (ok) {
          showToast("Dates updated")
        } else {
          showToast("Failed to update dates", "error")
        }
      },

      // Event: progress changed via drag
      on_progress_change: async (
        task: { id: string },
        progress: number,
      ) => {
        const rounded = Math.round(progress)
        const ok = await patchTask(task.id, { progress: rounded })
        if (ok) {
          showToast(`Progress: ${rounded}%`)
        } else {
          showToast("Failed to update progress", "error")
        }
      },

      // Event: view mode changed
      on_view_change: (viewMode: { name: string }) => {
        localStorage.setItem(ZOOM_KEY, viewMode.name)
      },
    })
  } catch (err) {
    console.error("[timeline] Frappe Gantt initialization failed:", err)
    if (skeleton) skeleton.style.display = "none"
    container.innerHTML =
      '<div style="padding:2rem;text-align:center;color:var(--text-muted)">Failed to load GANTT chart. Please reload the page.</div>'
    return
  }

  // Wire "View Details" popup links to task modal
  container.addEventListener(
    "click",
    (e: Event) => {
      const target = e.target as HTMLElement
      if (target.classList.contains("gantt-popup-detail-link")) {
        const taskId = target.dataset.taskId
        if (taskId) {
          // Dispatch event to open task edit modal (used by existing modal system)
          window.dispatchEvent(
            new CustomEvent("meitheal:open-task", { detail: { taskId } }),
          )
        }
      }
    },
    { signal },
  )

  // Cleanup on abort
  signal.addEventListener("abort", () => {
    _ganttInstance = null
  })
}
