/**
 * Eisenhower Matrix Controller — Drag-and-drop + P2 interactions
 *
 * @domain tasks
 * @bounded-context tasks (presentation)
 *
 * Handles:
 * - Drag-and-drop between quadrants (updates urgency/importance)
 * - Click to open task detail modal
 * - Count badge updates after drag
 * - WIP limit warnings for Q1
 * - Q1 "Commit to Today" bridge (sets due_date = today)
 * - Q4 batch actions (defer to backlog, complete all)
 * - Quick-capture inline input per quadrant
 *
 * @kcs Quadrant → urgency/importance mapping:
 *   Q1 (do-first)  → urgency 5, importance 5
 *   Q2 (schedule)   → urgency 1, importance 5
 *   Q3 (delegate)   → urgency 5, importance 1
 *   Q4 (not-now)    → urgency 1, importance 1
 */

import { taskApi } from "@lib/task-api-client"
import { showToast } from "@lib/toast"

// =============================================================================
// Quadrant → task field mapping (urgency/importance, NOT priority/due_date)
// =============================================================================

interface QuadrantUpdate {
  urgency: number
  importance: number
  eisenhower_override: boolean
}

const QUADRANT_MAP: Record<string, QuadrantUpdate> = {
  "do-first": { urgency: 5, importance: 5, eisenhower_override: true },
  schedule:   { urgency: 1, importance: 5, eisenhower_override: true },
  delegate:   { urgency: 5, importance: 1, eisenhower_override: true },
  "not-now":  { urgency: 1, importance: 1, eisenhower_override: true },
}

/** Q1 soft WIP limit — shows warning if exceeded */
const Q1_WIP_LIMIT = 5

// =============================================================================
// Main init
// =============================================================================

export function initEisenhowerPage() {
  const page = document.getElementById("eisenhower-page")
  if (!page) return

  setupDragAndDrop(page)
  setupClickToOpen(page)
  setupActionButtons(page)
  setupQuickCapture(page)
  setupFocusMode(page)
  setupMobileTabs(page)
  checkWipLimits(page)
  setupTriageListeners()
}

// =============================================================================
// Drag and drop
// =============================================================================

function setupDragAndDrop(page: HTMLElement) {
  // Make task items draggable
  const taskItems = page.querySelectorAll<HTMLElement>(".tli")
  for (const item of taskItems) {
    item.draggable = true
    item.setAttribute("role", "listitem")
    item.style.cursor = "grab"

    item.addEventListener("dragstart", (e: DragEvent) => {
      // Fix: data-id is on .tli itself, not a child element
      const id = item.dataset.id ?? item.querySelector<HTMLElement>("[data-id]")?.dataset.id
      if (id && e.dataTransfer) {
        e.dataTransfer.setData("text/plain", id)
        e.dataTransfer.effectAllowed = "move"
        item.classList.add("tli--dragging")
        // Subtle visual feedback
        requestAnimationFrame(() => {
          item.style.opacity = "0.5"
        })
      }
    })
    item.addEventListener("dragend", () => {
      item.classList.remove("tli--dragging")
      item.style.opacity = ""
    })
  }

  // Drop zones
  const dropZones = page.querySelectorAll<HTMLElement>("[data-drop-zone]")
  for (const zone of dropZones) {
    const quadrantEl = zone.closest<HTMLElement>(".eisenhower__quadrant")

    zone.addEventListener("dragover", (e: DragEvent) => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
      quadrantEl?.classList.add("quadrant--drag-over")
    })

    zone.addEventListener("dragleave", (e: DragEvent) => {
      // Only remove if actually leaving the zone (not entering a child)
      const related = e.relatedTarget as HTMLElement | null
      if (!zone.contains(related)) {
        quadrantEl?.classList.remove("quadrant--drag-over")
      }
    })

    zone.addEventListener("drop", async (e: DragEvent) => {
      e.preventDefault()
      quadrantEl?.classList.remove("quadrant--drag-over")

      const taskId = e.dataTransfer?.getData("text/plain")
      const targetQuadrant = zone.dataset.dropZone
      if (!taskId || !targetQuadrant || !(targetQuadrant in QUADRANT_MAP)) return

      const update = QUADRANT_MAP[targetQuadrant]!

      // Fix: find by data-id on .tli itself (not nested selector)
      const draggedItem = page.querySelector<HTMLElement>(`.tli[data-id="${taskId}"]`)
        ?? page.querySelector<HTMLElement>(`.tli:has([data-id="${taskId}"])`)
      if (!draggedItem) return

      // Get the wrapper (.eisenhower__task-wrapper) that contains the tli
      const wrapper = draggedItem.closest<HTMLElement>(".eisenhower__task-wrapper") ?? draggedItem

      // Remove "empty" placeholder if present
      const emptyEl = zone.querySelector(".quadrant__empty")
      if (emptyEl) emptyEl.remove()

      zone.appendChild(wrapper)

      // Show manual override indicator
      const metaEl = wrapper.querySelector(".eisenhower__task-meta")
      if (metaEl && !metaEl.querySelector(".tli__pin")) {
        const pinEl = document.createElement("span")
        pinEl.className = "tli__pin"
        pinEl.textContent = "📌"
        pinEl.setAttribute("title", "Manually placed")
        metaEl.appendChild(pinEl)
      }

      // Clear unclassified marker since we just classified it
      wrapper.removeAttribute("data-unclassified")

      updateCounts(page)
      checkWipLimits(page)
      updateTriageBanner(page)

      // Persist — updates urgency/importance, NOT priority/due_date
      try {
        await taskApi.updateTask(taskId, { ...update })
        showToast("common.task_updated")
      } catch {
        showToast("common.failed_update", "error")
      }
    })
  }
}

// =============================================================================
// Count updates
// =============================================================================

function updateCounts(page: HTMLElement) {
  const quadrants = page.querySelectorAll<HTMLElement>(".eisenhower__quadrant")
  for (const q of quadrants) {
    const count = q.querySelectorAll(".tli").length
    const badge = q.querySelector(".quadrant__count")
    if (badge) badge.textContent = String(count)

    // Show/hide empty placeholder
    const zone = q.querySelector<HTMLElement>("[data-drop-zone]")
    const existing = zone?.querySelector(".quadrant__empty")
    if (count === 0 && !existing && zone) {
      const empty = document.createElement("div")
      empty.className = "quadrant__empty"
      empty.setAttribute("data-i18n", "eisenhower.empty_quadrant")
      empty.textContent = "No tasks in this quadrant"
      zone.appendChild(empty)
    } else if (count > 0 && existing) {
      existing.remove()
    }
  }
}

// =============================================================================
// Triage banner update
// =============================================================================

function updateTriageBanner(page: HTMLElement) {
  const banner = page.querySelector<HTMLElement>(".eisenhower__triage-banner")
  if (!banner) return

  const unclassifiedCount = page.querySelectorAll("[data-unclassified]").length
  if (unclassifiedCount === 0) {
    banner.style.display = "none"
  } else {
    const textEl = banner.querySelector(".triage-banner__text")
    if (textEl) {
      textEl.innerHTML = `<strong>${unclassifiedCount}</strong> ${unclassifiedCount === 1 ? "task needs" : "tasks need"} classification`
    }
  }
}

// =============================================================================
// WIP limit warnings
// =============================================================================

function checkWipLimits(page: HTMLElement) {
  const q1Section = page.querySelector<HTMLElement>('[data-quadrant="do-first"]')
  if (!q1Section) return

  const count = q1Section.querySelectorAll(".tli").length
  const existing = q1Section.querySelector(".quadrant__wip-warning")

  if (count > Q1_WIP_LIMIT && !existing) {
    const warning = document.createElement("div")
    warning.className = "quadrant__wip-warning"
    warning.textContent = `⚠️ ${count} items — consider moving some to Schedule or Delegate`
    const actionBar = q1Section.querySelector(".quadrant__action-bar")
    const header = q1Section.querySelector(".quadrant__header")
    const insertAfter = actionBar ?? header
    insertAfter?.insertAdjacentElement("afterend", warning)
  } else if (count <= Q1_WIP_LIMIT && existing) {
    existing.remove()
  } else if (existing) {
    existing.textContent = `⚠️ ${count} items — consider moving some to Schedule or Delegate`
  }
}

// =============================================================================
// Action buttons (Q1 Commit, Q4 Defer/Complete)
// =============================================================================

function setupActionButtons(page: HTMLElement) {
  page.addEventListener("click", async (e: Event) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]")
    if (!btn) return

    const action = btn.dataset.action
    if (!action) return

    // Prevent double-click
    btn.setAttribute("disabled", "true")
    btn.style.opacity = "0.5"

    try {
      switch (action) {
        case "commit-q1":
          await commitQ1ToToday(page)
          break
        case "schedule-q2":
          await scheduleQ2ThisWeek(page)
          break
        case "defer-q4":
          await deferQ4ToBacklog(page)
          break
        case "complete-q4":
          await completeQ4(page)
          break
        case "assign-q3":
          await assignQ3(page)
          break
        case "start-triage":
          await startTriage()
          return // Skip the disable/re-enable flow
        case "close-triage":
          closeTriage()
          return
        case "triage-skip":
          triageNext()
          return
        case "triage-save":
          await triageSave()
          return
      }
    } finally {
      btn.removeAttribute("disabled")
      btn.style.opacity = ""
    }
  })
}

/**
 * Q1 → Today bridge: sets due_date = today on all Q1 tasks
 * so they appear in the Today Focus Stack.
 */
async function commitQ1ToToday(page: HTMLElement) {
  const q1Zone = page.querySelector<HTMLElement>('[data-drop-zone="do-first"]')
  if (!q1Zone) return

  const tasks = q1Zone.querySelectorAll<HTMLElement>(".tli")
  if (tasks.length === 0) return

  const today = new Date().toISOString().split("T")[0] ?? ""
  let successCount = 0

  for (const task of tasks) {
    const id = task.dataset.id ?? task.querySelector<HTMLElement>("[data-id]")?.dataset.id
    if (!id) continue

    try {
      await taskApi.updateTask(id, { due_date: today })
      successCount++
    } catch {
      // Continue with remaining tasks
    }
  }

  if (successCount > 0) {
    showToast("common.task_updated")
  }
}

/**
 * Q2 → Schedule This Week: sets due_date to end of current week (Sunday)
 * for all Q2 tasks that don't already have a due date.
 */
async function scheduleQ2ThisWeek(page: HTMLElement) {
  const q2Zone = page.querySelector<HTMLElement>('[data-drop-zone="schedule"]')
  if (!q2Zone) return

  const tasks = q2Zone.querySelectorAll<HTMLElement>(".tli")
  if (tasks.length === 0) return

  // Calculate next Sunday
  const now = new Date()
  const daysUntilSunday = 7 - now.getDay()
  const endOfWeek = new Date(now)
  endOfWeek.setDate(now.getDate() + (daysUntilSunday === 7 ? 0 : daysUntilSunday))
  const endOfWeekStr = endOfWeek.toISOString().slice(0, 10)

  let successCount = 0

  for (const task of tasks) {
    const id = task.dataset.id ?? task.querySelector<HTMLElement>("[data-id]")?.dataset.id
    if (!id) continue

    try {
      await taskApi.updateTask(id, { due_date: endOfWeekStr })
      successCount++
    } catch {
      // Continue with remaining tasks
    }
  }

  if (successCount > 0) {
    showToast("common.task_updated")
  }
}

/**
 * Q4 Defer: moves all Q4 tasks to backlog status.
 */
async function deferQ4ToBacklog(page: HTMLElement) {
  const q4Zone = page.querySelector<HTMLElement>('[data-drop-zone="not-now"]')
  if (!q4Zone) return

  const tasks = q4Zone.querySelectorAll<HTMLElement>(".tli")
  if (tasks.length === 0) return

  let successCount = 0

  for (const task of tasks) {
    const id = task.dataset.id ?? task.querySelector<HTMLElement>("[data-id]")?.dataset.id
    if (!id) continue

    try {
      await taskApi.updateTask(id, { status: "backlog" })
      successCount++
    } catch {
      // Continue with remaining tasks
    }
  }

  if (successCount > 0) {
    showToast("common.task_updated")
    // Remove deferred tasks from the quadrant
    for (const task of tasks) {
      const wrapper = task.closest(".eisenhower__task-wrapper")
      wrapper?.remove()
    }
    updateCounts(page)
  }
}

/**
 * Q4 Complete All: marks all Q4 tasks as done.
 */
async function completeQ4(page: HTMLElement) {
  const q4Zone = page.querySelector<HTMLElement>('[data-drop-zone="not-now"]')
  if (!q4Zone) return

  const tasks = q4Zone.querySelectorAll<HTMLElement>(".tli")
  if (tasks.length === 0) return

  let successCount = 0

  for (const task of tasks) {
    const id = task.dataset.id ?? task.querySelector<HTMLElement>("[data-id]")?.dataset.id
    if (!id) continue

    try {
      await taskApi.updateTask(id, { status: "done" })
      successCount++
    } catch {
      // Continue with remaining tasks
    }
  }

  if (successCount > 0) {
    showToast("common.task_updated")
    // Remove completed tasks from the quadrant
    for (const task of tasks) {
      const wrapper = task.closest(".eisenhower__task-wrapper")
      wrapper?.remove()
    }
    updateCounts(page)
  }
}

// =============================================================================
// Quick-capture inputs
// =============================================================================

function setupQuickCapture(page: HTMLElement) {
  const inputs = page.querySelectorAll<HTMLInputElement>("[data-quadrant-capture]")

  for (const input of inputs) {
    const quadrantId = input.dataset.quadrantCapture
    if (!quadrantId || !(quadrantId in QUADRANT_MAP)) continue

    const mapping = QUADRANT_MAP[quadrantId]!

    input.addEventListener("keydown", async (e: KeyboardEvent) => {
      if (e.key !== "Enter") return
      const title = input.value.trim()
      if (!title) return

      // Disable input while creating
      input.disabled = true
      input.style.opacity = "0.5"

      try {
        const result = await taskApi.createTask({
          title,
          urgency: mapping.urgency,
          importance: mapping.importance,
        })

        if (result?.id) {
          input.value = ""
          showToast("common.task_created")
          // Reload to show the new task in the right quadrant
          window.location.reload()
        }
      } catch {
        showToast("common.failed_create", "error")
      } finally {
        input.disabled = false
        input.style.opacity = ""
        input.focus()
      }
    })
  }
}

// =============================================================================
// Click to open task detail
// =============================================================================

function setupClickToOpen(page: HTMLElement) {
  page.addEventListener("click", (e: Event) => {
    const target = e.target as HTMLElement

    // Don't intercept checkbox clicks, buttons, inputs, or drag handles
    if (
      target.closest("input[type='checkbox']") ||
      target.closest("button") ||
      target.closest("input") ||
      target.closest("a")
    ) {
      return
    }

    const taskItem = target.closest<HTMLElement>(".tli")
    if (!taskItem) return

    // Fix: data-id is on .tli itself
    const taskId = taskItem.dataset.id ?? taskItem.querySelector<HTMLElement>("[data-id]")?.dataset.id
    if (taskId) {
      window.dispatchEvent(
        new CustomEvent("meitheal:open-task-detail", { detail: { id: taskId } }),
      )
    }
  })
}

// =============================================================================
// Focus mode (desktop: expand one quadrant full-width)
// =============================================================================

function setupFocusMode(page: HTMLElement) {
  const grid = page.querySelector<HTMLElement>(".eisenhower__grid")
  if (!grid) return

  page.addEventListener("click", (e: Event) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-focus-quadrant]")
    if (!btn) return

    const quadrantId = btn.dataset.focusQuadrant
    if (!quadrantId) return

    const quadrantEl = page.querySelector<HTMLElement>(`[data-quadrant="${quadrantId}"]`)
    if (!quadrantEl) return

    const isAlreadyFocused = quadrantEl.classList.contains("quadrant--focused")

    // Clear all focus states
    grid.classList.remove("grid--focused")
    for (const q of page.querySelectorAll(".quadrant--focused")) {
      q.classList.remove("quadrant--focused")
    }

    // Toggle: if already focused, go back to grid; otherwise focus this one
    if (!isAlreadyFocused) {
      grid.classList.add("grid--focused")
      quadrantEl.classList.add("quadrant--focused")
    }
  })
}

// =============================================================================
// Mobile tab switching
// =============================================================================

function setupMobileTabs(page: HTMLElement) {
  const tabs = page.querySelectorAll<HTMLElement>("[data-tab-quadrant]")
  const quadrants = page.querySelectorAll<HTMLElement>(".eisenhower__quadrant")

  if (tabs.length === 0) return

  // Activate first quadrant by default on mobile
  const firstQuadrant = quadrants[0]
  if (firstQuadrant) firstQuadrant.classList.add("quadrant--tab-active")

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tabQuadrant
      if (!target) return

      // Switch active tab
      for (const t of tabs) {
        t.classList.remove("mobile-tab--active")
        t.setAttribute("aria-selected", "false")
      }
      tab.classList.add("mobile-tab--active")
      tab.setAttribute("aria-selected", "true")

      // Switch visible quadrant
      for (const q of quadrants) {
        q.classList.remove("quadrant--tab-active")
      }
      const targetQ = page.querySelector<HTMLElement>(`[data-quadrant="${target}"]`)
      targetQ?.classList.add("quadrant--tab-active")
    })
  }
}

// =============================================================================
// Q3 quick-assign
// =============================================================================

/**
 * Q3 Assign: prompts for assignee name and updates all Q3 tasks.
 */
async function assignQ3(page: HTMLElement) {
  const q3Zone = page.querySelector<HTMLElement>('[data-drop-zone="delegate"]')
  if (!q3Zone) return

  const tasks = q3Zone.querySelectorAll<HTMLElement>(".tli")
  if (tasks.length === 0) return

  const assignee = prompt("Assign all Delegate tasks to:")
  if (!assignee || !assignee.trim()) return

  let successCount = 0

  for (const task of tasks) {
    const id = task.dataset.id ?? task.querySelector<HTMLElement>("[data-id]")?.dataset.id
    if (!id) continue

    try {
      await taskApi.updateTask(id, { assigned_to: assignee.trim() })
      successCount++
    } catch {
      // Continue with remaining tasks
    }
  }

  if (successCount > 0) {
    showToast("common.task_updated")
  }
}

// ─── Triage Mode ───────────────────────────────────────────────

interface TriageTask {
  id: string
  title: string
}

let triageTasks: TriageTask[] = []
let triageIndex = 0

/** Derive quadrant label + emoji from urgency × importance values */
function quadrantPreview(urgency: number, importance: number): string {
  if (urgency === 0 && importance === 0) return "🔍 Set values to classify"
  const urgent = urgency >= 3
  const important = importance >= 3
  if (urgent && important) return "🔴 Do First"
  if (!urgent && important) return "🔵 Schedule"
  if (urgent && !important) return "🟡 Delegate"
  return "⚪ Not Now"
}

/** Open the triage overlay by fetching unclassified tasks */
async function startTriage() {
  try {
    const res = await fetch(
      (window.__ingress_path || "") + "/api/tasks?status=open"
    )
    if (!res.ok) { showToast("common.failed_update", "error"); return }
    const data = await res.json()
    const raw = Array.isArray(data) ? data : (data.tasks ?? [])
    triageTasks = raw
      .filter((t: Record<string, unknown>) =>
        (t.urgency === 0 || t.urgency == null) &&
        (t.importance === 0 || t.importance == null)
      )
      .map((t: Record<string, unknown>) => ({ id: String(t.id), title: String(t.title ?? "Untitled") }))

    if (triageTasks.length === 0) {
      showToast("common.empty")
      return
    }

    triageIndex = 0
    showTriageTask()

    const overlay = document.getElementById("triage-overlay")
    if (overlay) overlay.style.display = ""
  } catch {
    showToast("common.failed_update", "error")
  }
}

function showTriageTask() {
  const task = triageTasks[triageIndex]
  if (!task) { closeTriage(); return }

  const nameEl = document.getElementById("triage-task-name")
  if (nameEl) nameEl.textContent = task.title

  const progressEl = document.getElementById("triage-progress")
  if (progressEl) progressEl.textContent = `${triageIndex + 1} / ${triageTasks.length}`

  // Reset sliders
  const urgencySlider = document.getElementById("triage-urgency") as HTMLInputElement | null
  const importanceSlider = document.getElementById("triage-importance") as HTMLInputElement | null
  if (urgencySlider) urgencySlider.value = "0"
  if (importanceSlider) importanceSlider.value = "0"

  const urgencyVal = document.getElementById("triage-urgency-val")
  const importanceVal = document.getElementById("triage-importance-val")
  if (urgencyVal) urgencyVal.textContent = "0"
  if (importanceVal) importanceVal.textContent = "0"

  updateTriagePreview()
}

function updateTriagePreview() {
  const u = Number((document.getElementById("triage-urgency") as HTMLInputElement)?.value ?? 0)
  const i = Number((document.getElementById("triage-importance") as HTMLInputElement)?.value ?? 0)
  const preview = document.getElementById("triage-quadrant-preview")
  if (preview) preview.textContent = quadrantPreview(u, i)
}

function closeTriage() {
  const overlay = document.getElementById("triage-overlay")
  if (overlay) overlay.style.display = "none"
  triageTasks = []
  triageIndex = 0
}

function triageNext() {
  triageIndex++
  if (triageIndex >= triageTasks.length) {
    closeTriage()
    showToast("common.task_updated")
    window.location.reload()
  } else {
    showTriageTask()
  }
}

async function triageSave() {
  const task = triageTasks[triageIndex]
  if (!task) return

  const urgency = Number((document.getElementById("triage-urgency") as HTMLInputElement)?.value ?? 0)
  const importance = Number((document.getElementById("triage-importance") as HTMLInputElement)?.value ?? 0)

  if (urgency === 0 && importance === 0) {
    // Don't save if both are unset — same as skip
    triageNext()
    return
  }

  try {
    await taskApi.updateTask(task.id, { urgency, importance })
    triageNext()
  } catch {
    showToast("common.failed_update", "error")
  }
}

/** Setup triage slider input listeners */
function setupTriageListeners() {
  const urgencySlider = document.getElementById("triage-urgency")
  const importanceSlider = document.getElementById("triage-importance")
  const urgencyVal = document.getElementById("triage-urgency-val")
  const importanceVal = document.getElementById("triage-importance-val")

  urgencySlider?.addEventListener("input", () => {
    if (urgencyVal) urgencyVal.textContent = (urgencySlider as HTMLInputElement).value
    updateTriagePreview()
  })

  importanceSlider?.addEventListener("input", () => {
    if (importanceVal) importanceVal.textContent = (importanceSlider as HTMLInputElement).value
    updateTriagePreview()
  })

  // Close on overlay backdrop click
  document.getElementById("triage-overlay")?.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).classList.contains("triage-overlay")) {
      closeTriage()
    }
  })

  // Close on Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.getElementById("triage-overlay")?.style.display !== "none") {
      closeTriage()
    }
  })
}
