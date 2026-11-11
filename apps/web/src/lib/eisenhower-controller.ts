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

import { STATUS, STATUS_LABELS } from "@lib/status-config"
import { taskApi, type TaskPatchPayload } from "@lib/task-api-client"
import { initPageShellNavigation } from "@lib/page-shell-controller"
import { EISENHOWER_SECTIONS } from "@lib/eisenhower-registry"
import { promptDialog } from "@lib/prompt-dialog"
import { showToast } from "@lib/toast"
import { showTaskBatchResult } from "./task-batch-feedback"
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

  const pendingTasks = new Set<string>()
  setupDragAndDrop(page, lifecycle, pendingTasks)
  setupClickToOpen(page, lifecycle)
  setupActionButtons(page, lifecycle, pendingTasks)
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

function setupDragAndDrop(page: HTMLElement, signal: AbortSignal, pendingTasks: Set<string>) {
  // Make task items draggable
  const taskItems = page.querySelectorAll<HTMLElement>(".tli")
  for (const item of taskItems) {
    item.draggable = true
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
      if (!taskId || pendingTasks.has(taskId) || !targetQuadrant || !(targetQuadrant in QUADRANT_MAP)) return

      const update = QUADRANT_MAP[targetQuadrant]!

      // Fix: find by data-id on .tli itself (not nested selector)
      const draggedItem = page.querySelector<HTMLElement>(`.tli[data-id="${taskId}"]`)
        ?? page.querySelector<HTMLElement>(`.tli:has([data-id="${taskId}"])`)
      if (!draggedItem) return

      const wrapper = draggedItem.closest<HTMLElement>(".eisenhower__task-wrapper")
      if (!wrapper) return

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
      pendingTasks.add(taskId)
      try {
        await taskApi.updateTask(taskId, { ...update })
        if (!signal.aborted) showToast("common.task_updated")
      } catch {
        if (!signal.aborted) showToast("common.failed_update", "error")
      } finally {
        pendingTasks.delete(taskId)
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
    const tabCount = page.querySelector(`[aria-controls="${q.id}"] .mobile-tab__count`)
    if (tabCount) tabCount.textContent = String(count)

    const zone = q.querySelector<HTMLElement>("[data-drop-zone]")
    if (!zone) continue
    if (count > 0) zone.setAttribute("role", "list")
    else zone.removeAttribute("role")

    const empty = zone.querySelector<HTMLElement>(".quadrant__empty")
    if (empty) empty.hidden = count > 0
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

function setupActionButtons(page: HTMLElement, signal: AbortSignal, pendingTasks: Set<string>) {
  const onAction = async (e: Event) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]")
    if (!btn) return

    const action = btn.dataset.action
    if (!action) return

    const quadrantBar = btn.closest<HTMLElement>(".quadrant__action-bar")
    if (quadrantBar) {
      await updateQuadrant(page, quadrantBar, action, signal, pendingTasks)
      return
    }

    // Prevent double-click
    btn.setAttribute("disabled", "true")
    btn.style.opacity = "0.5"

    try {
      switch (action) {
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

async function quadrantPatch(action: string, signal: AbortSignal): Promise<TaskPatchPayload | undefined> {
  switch (action) {
    case "commit-q1": return { due_date: new Date().toISOString().slice(0, 10) }
    case "schedule-q2": {
      const sunday = new Date()
      sunday.setDate(sunday.getDate() + (7 - sunday.getDay()) % 7)
      return { due_date: sunday.toISOString().slice(0, 10) }
    }
    case "assign-q3": {
      const assignee = await promptDialog({ title: "Assign Delegate Tasks", placeholder: "Assignee name", required: true, signal })
      return assignee ? { assigned_to: assignee.trim() } : undefined
    }
    case "defer-q4": return { status: STATUS.BACKLOG }
    case "complete-q4": return { status: STATUS.COMPLETE }
  }
}

async function updateQuadrant(page: HTMLElement, bar: HTMLElement, action: string, signal: AbortSignal, pendingTasks: Set<string>) {
  if (bar.hasAttribute("aria-busy")) return
  const tasks = new Map<string, HTMLElement>()
  for (const task of bar.closest("[data-quadrant]")?.querySelectorAll<HTMLElement>("[data-drop-zone] .tli") ?? []) {
    if (action === "defer-q4" && task.dataset.status === STATUS.BACKLOG) continue
    const id = task.dataset.id ?? task.querySelector<HTMLElement>("[data-id]")?.dataset.id
    if (id) tasks.set(id, task)
  }
  if (!tasks.size) return

  const available = [...tasks].filter(([id]) => !pendingTasks.has(id))
  const buttons = bar.querySelectorAll("button[data-action]")
  bar.setAttribute("aria-busy", "true")
  for (const button of buttons) button.setAttribute("aria-disabled", "true")
  for (const [id] of available) pendingTasks.add(id)
  try {
    const patch = await quadrantPatch(action, signal)
    if (!patch) return

    const saved: HTMLElement[] = []
    for (const [id, task] of available) {
      if (signal.aborted) return
      try {
        const updated = await taskApi.updateTask(id, patch)
        if (!patch.status || updated?.status === patch.status) saved.push(task)
      } catch {
        // Keep the task available when the write cannot be confirmed.
      }
    }
    if (signal.aborted) return
    if (patch.status === STATUS.COMPLETE && saved.length) {
      for (const task of saved) task.closest(".eisenhower__task-wrapper")?.remove()
      updateCounts(page)
      updateTriageBanner(page)
    }
    if (patch.status === STATUS.BACKLOG) {
      for (const task of saved) {
        task.dataset.status = STATUS.BACKLOG
        const badge = task.querySelector<HTMLElement>(".status-badge")
        if (!badge) continue
        badge.dataset.badgeStatus = STATUS.BACKLOG
        badge.textContent = STATUS_LABELS.backlog!
      }
    }
    showTaskBatchResult(saved.length, tasks.size, "common.task_updated")
  } finally {
    for (const [id] of available) pendingTasks.delete(id)
    for (const button of buttons) button.removeAttribute("aria-disabled")
    bar.removeAttribute("aria-busy")
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
  const tabs = Array.from(page.querySelectorAll<HTMLButtonElement>(".eisenhower__mobile-tabs [role=tab]"), tab => {
    const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "")
    return panel ? { tab, panel } : null
  })
  if (tabs.length === 0 || !tabs.every(pair => pair !== null)) return

  const mobile = window.matchMedia("(max-width: 768px)")
  const syncPanelRoles = () => {
    tabs.forEach(({ tab, panel }) => {
      if (mobile.matches) {
        panel.setAttribute("role", "tabpanel")
        panel.setAttribute("aria-labelledby", tab.id)
        panel.tabIndex = 0
      } else {
        panel.removeAttribute("role")
        panel.removeAttribute("aria-labelledby")
        panel.removeAttribute("tabindex")
      }
    })
  }
  const select = (index: number) => {
    tabs.forEach(({ tab, panel }, position) => {
      const selected = position === index
      tab.setAttribute("aria-selected", String(selected))
      tab.tabIndex = selected ? 0 : -1
      panel.classList.toggle("quadrant--tab-active", selected)
    })
  }

  tabs.forEach(({ tab }, index) => {
    tab.addEventListener("focus", () => select(index), { signal })
    tab.addEventListener("click", () => select(index), { signal })
    tab.addEventListener("keydown", event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      let next: number
      switch (event.key) {
        case "ArrowLeft":
          next = (index + tabs.length - 1) % tabs.length
          break
        case "ArrowRight":
          next = (index + 1) % tabs.length
          break
        case "Home":
          next = 0
          break
        case "End":
          next = tabs.length - 1
          break
        default:
          return
      }
      event.preventDefault()
      tabs[next]?.tab.focus()
    }, { signal })
  })

  select(Math.max(0, tabs.findIndex(({ tab }) => tab.getAttribute("aria-selected") === "true")))
  syncPanelRoles()
  mobile.addEventListener("change", syncPanelRoles, { signal })
  page.setAttribute("data-quadrant-tabs-ready", "")
}
