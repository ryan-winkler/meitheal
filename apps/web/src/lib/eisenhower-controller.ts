/**
 * Eisenhower Matrix Controller — Drag-and-drop quadrant management
 *
 * @domain tasks
 * @bounded-context tasks (presentation)
 *
 * Handles:
 * - Drag-and-drop between quadrants (updates priority/due_date)
 * - Click to open task detail modal
 * - Count badge updates after drag
 *
 * @kcs Quadrant → priority/due_date mapping:
 *   Q1 (do-first)  → priority 5, due_date = today
 *   Q2 (schedule)   → priority 5, due_date cleared (future)
 *   Q3 (delegate)   → priority 2, due_date = today
 *   Q4 (eliminate)   → priority 1, due_date cleared
 */

import { taskApi } from "@lib/task-api-client"
import { showToast } from "@lib/toast"

// =============================================================================
// Quadrant → task field mapping
// =============================================================================

interface QuadrantUpdate {
  priority: number
  due_date: string | null
}

const QUADRANT_MAP: Record<string, QuadrantUpdate> = {
  "do-first": { priority: 5, due_date: new Date().toISOString().slice(0, 10) },
  schedule: { priority: 5, due_date: null },
  delegate: { priority: 2, due_date: new Date().toISOString().slice(0, 10) },
  eliminate: { priority: 1, due_date: null },
}

// =============================================================================
// Main init
// =============================================================================

export function initEisenhowerPage() {
  const page = document.getElementById("eisenhower-page")
  if (!page) return

  setupDragAndDrop(page)
  setupClickToOpen(page)
}

// =============================================================================
// Drag and drop
// =============================================================================

function setupDragAndDrop(page: HTMLElement) {
  // Make task items draggable
  const taskItems = page.querySelectorAll<HTMLElement>(".tli")
  for (const item of taskItems) {
    item.draggable = true
    item.addEventListener("dragstart", (e: DragEvent) => {
      const id = item.querySelector<HTMLElement>("[data-id]")?.dataset.id
      if (id) {
        e.dataTransfer?.setData("text/plain", id)
        item.classList.add("tli--dragging")
      }
    })
    item.addEventListener("dragend", () => {
      item.classList.remove("tli--dragging")
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

    zone.addEventListener("dragleave", () => {
      quadrantEl?.classList.remove("quadrant--drag-over")
    })

    zone.addEventListener("drop", async (e: DragEvent) => {
      e.preventDefault()
      quadrantEl?.classList.remove("quadrant--drag-over")

      const taskId = e.dataTransfer?.getData("text/plain")
      const targetQuadrant = zone.dataset.dropZone
      if (!taskId || !targetQuadrant || !(targetQuadrant in QUADRANT_MAP)) return

      const update = QUADRANT_MAP[targetQuadrant]!

      // Move the DOM element visually
      const draggedItem = page.querySelector<HTMLElement>(`.tli:has([data-id="${taskId}"])`)
      if (!draggedItem) return

      // Remove "empty" placeholder if present
      const emptyEl = zone.querySelector(".quadrant__empty")
      if (emptyEl) emptyEl.remove()

      zone.appendChild(draggedItem)
      updateCounts(page)

      // Persist
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
// Click to open task detail
// =============================================================================

function setupClickToOpen(page: HTMLElement) {
  page.addEventListener("click", (e: Event) => {
    const target = e.target as HTMLElement

    // Don't intercept checkbox clicks or drag handles
    if (
      target.closest("input[type='checkbox']") ||
      target.closest("button") ||
      target.closest("a")
    ) {
      return
    }

    const taskItem = target.closest<HTMLElement>(".tli")
    if (!taskItem) return

    const idEl = taskItem.querySelector<HTMLElement>("[data-id]")
    const taskId = idEl?.dataset.id
    if (taskId) {
      window.dispatchEvent(
        new CustomEvent("meitheal:open-task-detail", { detail: { id: taskId } }),
      )
    }
  })
}
