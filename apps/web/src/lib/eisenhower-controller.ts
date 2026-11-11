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

import { STATUS } from "@lib/status-config"
import { taskApi } from "@lib/task-api-client"
import { initPageShellNavigation } from "@lib/page-shell-controller"
import { EISENHOWER_SECTIONS } from "@lib/eisenhower-registry"
import { promptDialog } from "@lib/prompt-dialog"
import { showToast } from "@lib/toast"
import {
  startTriage,
  closeTriage,
  triageNext,
  triageSave,
  setupTriageListeners,
} from "@lib/controllers/eisenhower-triage"
import {
  startReview,
  closeReview,
  reviewNext,
  reviewAction,
  setupReviewListeners,
} from "@lib/controllers/eisenhower-review"

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

export function initEisenhowerPage({ signal }: { signal: AbortSignal }) {
  const page = document.getElementById("eisenhower-shell")
  if (!page || signal.aborted) return

  const host = window as Window & {
    __meithealEisenhowerController?: { page: HTMLElement; signal: AbortSignal; controller: AbortController }
  }
  const previous = host.__meithealEisenhowerController
  if (previous?.page === page && previous.signal === signal && !previous.controller.signal.aborted) return
  previous?.controller.abort()
  const controller = new AbortController()
  const owner = { page, signal, controller }
  host.__meithealEisenhowerController = owner
  signal.addEventListener("abort", () => controller.abort(), { once: true, signal: controller.signal })
  controller.signal.addEventListener("abort", () => {
    if (host.__meithealEisenhowerController === owner) delete host.__meithealEisenhowerController
  }, { once: true })
  const lifecycle = controller.signal

  initPageShellNavigation({
    barId: "eisenhower-bar",
    shellId: "eisenhower-shell",
    sectionSelector: "[data-eisenhower-section]",
    sectionIds: EISENHOWER_SECTIONS.map((s) => s.id),
    defaultSectionId: "eisenhower-overview",
  })

  setupDragAndDrop(page, lifecycle)
  setupClickToOpen(page, lifecycle)
  setupActionButtons(page, lifecycle)
  setupQuickCapture(page, lifecycle)
  setupFocusMode(page, lifecycle)
  setupMobileTabs(page, lifecycle)
  checkWipLimits(page)
  setupTriageListeners(lifecycle)
  setupReviewListeners(lifecycle)
}

// =============================================================================
// Drag and drop
// =============================================================================

function setupDragAndDrop(page: HTMLElement, signal: AbortSignal) {
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
    }, { signal })
    item.addEventListener("dragend", () => {
      item.classList.remove("tli--dragging")
      item.style.opacity = ""
    }, { signal })
  }

  // Drop zones
  const dropZones = page.querySelectorAll<HTMLElement>("[data-drop-zone]")
  for (const zone of dropZones) {
    const quadrantEl = zone.closest<HTMLElement>(".eisenhower__quadrant")

    zone.addEventListener("dragover", (e: DragEvent) => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
      quadrantEl?.classList.add("quadrant--drag-over")
    }, { signal })

    zone.addEventListener("dragleave", (e: DragEvent) => {
      // Only remove if actually leaving the zone (not entering a child)
      const related = e.relatedTarget as HTMLElement | null
      if (!zone.contains(related)) {
        quadrantEl?.classList.remove("quadrant--drag-over")
      }
    }, { signal })

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
    }, { signal })
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
      textEl.textContent = ""
      const strong = document.createElement("strong")
      strong.textContent = String(unclassifiedCount)
      textEl.appendChild(strong)
      textEl.appendChild(document.createTextNode(` ${unclassifiedCount === 1 ? "task needs" : "tasks need"} classification`))
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

function setupActionButtons(page: HTMLElement, signal: AbortSignal) {
  const onAction = async (e: Event) => {
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
        case "start-review":
          await startReview()
          return
        case "close-review":
          closeReview()
          return
        case "review-promote":
          await reviewAction("promote")
          return
        case "review-archive":
          await reviewAction("archive")
          return
        case "review-delete":
          await reviewAction("delete")
          return
        case "review-skip":
          reviewNext()
          return
      }
    } finally {
      btn.removeAttribute("disabled")
      btn.style.opacity = ""
    }
  }
  page.addEventListener("click", onAction, { signal })
  const bar = document.getElementById("eisenhower-bar")
  if (bar && !page.contains(bar)) bar.addEventListener("click", onAction, { signal })
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
      await taskApi.updateTask(id, { status: STATUS.COMPLETE })
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

function setupQuickCapture(page: HTMLElement, signal: AbortSignal) {
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
    }, { signal })
  }
}

// =============================================================================
// Click to open task detail
// =============================================================================

function setupClickToOpen(page: HTMLElement, signal: AbortSignal) {
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
  }, { signal })
}

// =============================================================================
// Focus mode (desktop: expand one quadrant full-width)
// =============================================================================

function setupFocusMode(page: HTMLElement, signal: AbortSignal) {
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
  }, { signal })
}

// =============================================================================
// Mobile tab switching
// =============================================================================

function setupMobileTabs(page: HTMLElement, signal: AbortSignal) {
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
    }, { signal })
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

  const assignee = await promptDialog({ title: "Assign Delegate Tasks", placeholder: "Assignee name", required: true })
  if (!assignee) return

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

