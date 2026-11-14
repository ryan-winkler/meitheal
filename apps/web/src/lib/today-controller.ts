/**
 * Today Controller — Client-side logic for the Today page
 *
 * @domain tasks
 * @bounded-context tasks (presentation)
 *
 * Extracted from today.astro inline <script>. Handles:
 * - Task checkbox completion with toast + celebration
 * - Favorite toggle with optimistic UI
 * - Keyboard navigation (j/k/x/e/n)
 * - Filter bar wiring with filter-state persistence
 * - Sort handler with 8 sort options
 * - Snooze/reschedule popover
 * - Duplicate, Ask AI, Delete handlers
 * - Quick-add with NL parser + default due_date = today
 * - Section collapse/expand with localStorage persistence
 * - "Clear completed" action
 * - Focus Today button (suggested section)
 *
 * @kcs This controller uses event delegation on the page container
 * instead of per-element listeners for better memory safety and
 * dynamic content support.
 */

import { isDisabledCharacterShortcut } from "@lib/single-key-shortcuts"
import { taskApi } from "./task-api-client"
import { showToast } from "./toast"
import { confirmDialog } from "./confirm-dialog"
import { onTaskCompleted } from "./gamification-hook"
import { householdDayFromToday, householdToday, parseQuickTask, quickAddPayload } from "./quick-add"
import {
  saveFilterState,
  loadFilterState,
} from "./filter-state"
import { createListenerManager, installPageCleanup } from "./managed-listeners"
import { initPageShellNavigation } from "./page-shell-controller"
import { openTaskDetailHandoff } from "./task-detail-handoff"
import type { TodayTaskCounts } from "./task-queries"
import { TODAY_SECTIONS } from "./today-registry"
import { compareTodayRows, matchesTodayFilters, type TodayFilters } from "./today-list"
import { setupUnscheduledSection } from "./controllers/today-unscheduled"

// ── Extracted controller modules ──────────────────────────────────────────
import { setupHabitsSection, saveTaskAsHabit as _saveTaskAsHabit } from "./controllers/today-habits"
import { setupEveningReview } from "./controllers/today-evening-review"
import { setupCalendarEvents } from "./controllers/today-calendar-events"
import { setupBatchUI } from "./controllers/today-batch-actions"
import { setupFocusStack } from "./controllers/today-focus-stack"
import {
  setupMigrationPrompt,
  setupContextGrouping,
  renderEffortIndicators,
  handleRecurrencePostComplete as _handleRecurrencePostComplete,
  cancelRecurrence as _cancelRecurrence,
} from "./controllers/today-supplemental"

// ── Types ─────────────────────────────────────────────────────────────────

interface TodayControllerOptions {
  /** The page container element */
  container: HTMLElement
}

// ── State ─────────────────────────────────────────────────────────────────

let focusedIndex = -1
const SECTION_COLLAPSE_KEY = "meitheal-today-sections"
const WIP_LIMIT = 6
let lm = createListenerManager()

// Re-export for external consumers
export async function saveTaskAsHabit(taskId: string, container: HTMLElement) {
  return _saveTaskAsHabit(taskId, container, lm)
}
export async function handleRecurrencePostComplete(taskId: string) {
  return _handleRecurrencePostComplete(taskId, lm)
}
export async function cancelRecurrence(taskId: string) {
  return _cancelRecurrence(taskId, lm)
}

// ── Init ──────────────────────────────────────────────────────────────────

export function initTodayPage(options?: Partial<TodayControllerOptions>) {
  // Cleanup previous instance (prevents listener leaks on page re-init)
  lm.cleanup()
  lm = createListenerManager()
  installPageCleanup(lm)

  const container = options?.container ?? document.body
  focusedIndex = -1
  // Restore the batch selection before restoring filters rewrites history state.
  const addBatchCheckboxes = setupBatchUI(container, lm)

  initPageShellNavigation({
    barId: "today-bar",
    shellId: "today-shell",
    sectionSelector: "[data-today-section]",
    sectionIds: TODAY_SECTIONS.map((section) => section.id),
    defaultSectionId: "today-overview",
    flashClass: "page-shell__section--flash",
    sectionLinkSelectors: ["[data-today-section-link]"],
  })

  setupEventDelegation(container)
  setupQuickAdd(container)
  setupKeyboardNav(container)
  setupSectionCollapse(container)
  const initialSearch = window.location.search
  restoreFilterState()
  setupDragReorder(container)     // G31
  setupWipLimit(container)        // G32
  setupAutoRefresh(container)     // G33
  setupEveningReview(container, lm)   // G34
  renderEffortIndicators(container) // G35
  const refreshUnscheduled = setupUnscheduledSection(container, lm, addBatchCheckboxes)
  setupFilters(container, refreshUnscheduled)
  if (window.location.search !== initialSearch) refreshUnscheduled()
  setupHabitsSection(container, lm)    // G38
  setupCalendarEvents(lm)              // G28
  setupMigrationPrompt(container)  // G27
  setupContextGrouping(container)  // G29
  setupFocusStack(container, lm)       // PRA-02

  // Hash deep-link: #task-{id} scroll into view
  const hash = window.location.hash
  if (hash.startsWith("#task-")) {
    const taskId = hash.slice(6)
    const el = container.querySelector(`.tli[data-id="${taskId}"]`) as HTMLElement | null
    if (el) {
      setTimeout(() => {
        el.scrollIntoView({ behavior: "smooth", block: "center" })
        el.classList.add("tli--focused")
      }, 200)
    }
  }
}

// ── Event Delegation ──────────────────────────────────────────────────────

function setupEventDelegation(container: HTMLElement) {
  lm.on(container, "click", async (e: Event) => {
    const target = e.target as HTMLElement

    // ── Checkbox completion ──
    if (target.classList.contains("tli__checkbox")) {
      e.stopPropagation()
      const cb = target as HTMLInputElement
      const id = cb.dataset.id
      if (!id) return

      const item = cb.closest(".tli") as HTMLElement | null
      const newStatus = cb.checked ? "complete" : "pending"

      // Optimistic UI
      if (cb.checked) {
        item?.classList.add("tli--done", "tli--celebrate")
        setTimeout(() => item?.classList.remove("tli--celebrate"), 600)
      } else {
        item?.classList.remove("tli--done")
      }

      try {
        const completed = await taskApi.updateTask(id, { status: newStatus })
        showToast(cb.checked ? "common.task_completed" : "common.task_reopened")
        if (cb.checked) onTaskCompleted(completed)
      } catch {
        cb.checked = !cb.checked
        item?.classList.toggle("tli--done", cb.checked)
        showToast("common.failed_update", "error")
      }
      return
    }

    // ── Favorite toggle ──
    if (target.classList.contains("tli__fav")) {
      e.stopPropagation()
      const el = target as HTMLElement
      const id = el.dataset.id
      if (!id) return

      const isFav = el.classList.contains("is-fav")
      const newFav = !isFav

      // Optimistic
      el.classList.toggle("is-fav", newFav)
      el.textContent = newFav ? "★" : "☆"
      el.title = newFav ? "★ Favorited" : "☆ Favorite"

      try {
        await taskApi.updateTask(id, { is_favorite: newFav ? 1 : 0 })
        showToast(newFav ? "common.favorited" : "common.unfavorited")
      } catch {
        el.classList.toggle("is-fav", isFav)
        el.textContent = isFav ? "★" : "☆"
        showToast("common.failed", "error")
      }
      return
    }

    // ── Focus Today button ──
    if (target.classList.contains("tli__focus-btn")) {
      e.stopPropagation()
      const btn = target as HTMLButtonElement
      const id = btn.dataset.id
      if (!id) return

      btn.disabled = true
      btn.textContent = "..."
      try {
        await taskApi.updateTask(id, { due_date: householdToday() })
        showToast("common.task_updated")
        document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "today-focus" } }))
      } catch {
        btn.disabled = false
        btn.textContent = "➕ Today"
        showToast("common.failed", "error")
      }
      return
    }

    // ── Snooze button ──
    if (target.classList.contains("tli__snooze-btn")) {
      e.stopPropagation()
      showSnoozePopover(target as HTMLElement)
      return
    }

    // ── Duplicate ──
    if (target.classList.contains("tli__duplicate")) {
      e.stopPropagation()
      const id = (target as HTMLElement).dataset.id
      if (!id) return
      try {
        await taskApi.duplicateTask(id)
        showToast("common.task_created")
        setTimeout(() => document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "today-duplicate" } })), 500)
      } catch {
        showToast("common.failed", "error")
      }
      return
    }

    // ── Ask AI ──
    if (target.classList.contains("tli__ask-ai")) {
      e.stopPropagation()
      handleAskAi(target as HTMLElement)
      return
    }

    // ── Delete ──
    if (target.classList.contains("tli__delete")) {
      e.stopPropagation()
      const id = (target as HTMLElement).dataset.id
      if (!id) return
      const ok = await confirmDialog({
        title: "Delete Task?",
        message: "This action cannot be undone.",
        variant: "danger",
        confirmText: "Delete",
      })
      if (!ok) return
      try {
        await taskApi.deleteTask(id)
        showToast("common.task_deleted")
        const item = target.closest(".tli") as HTMLElement | null
        if (item) {
          item.style.opacity = "0"
          item.style.transition = "opacity 0.3s"
          setTimeout(() => item.remove(), 300)
        }
      } catch {
        showToast("common.failed_delete", "error")
      }
      return
    }

    // ── Section collapse toggle ──
    if (target.classList.contains("today-section__toggle") || target.closest(".today-section__toggle")) {
      e.stopPropagation()
      const header = target.closest(".today-section__header") as HTMLElement | null
      const section = header?.closest(".today-section") as HTMLElement | null
      if (section && section.id !== "section-unscheduled") {
        setSectionCollapsed(section, !section.classList.contains("today-section--collapsed"))
        saveSectionState()
      }
      return
    }

    // ── Clear completed ──
    if (target.id === "clear-completed-btn" || target.closest("#clear-completed-btn")) {
      e.stopPropagation()
      const ok = await confirmDialog({
        title: "Clear Completed Tasks?",
        message: "This will archive all tasks completed today.",
        variant: "warning",
        confirmText: "Clear",
      })
      if (!ok) return
      try {
        await taskApi.raw("/api/tasks/clear-completed", { method: "POST" })
        showToast("common.tasks_cleared")
        setTimeout(() => document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "today-clear-completed" } })), 500)
      } catch {
        showToast("common.failed", "error")
      }
      return
    }

    // ── Snooze popover actions ──
    if (target.dataset.snooze) {
      e.stopPropagation()
      const id = target.dataset.taskId
      const days = parseInt(target.dataset.snooze, 10)
      if (!id || isNaN(days)) return

      const dateStr = householdDayFromToday(days)

      try {
        await taskApi.updateTask(id, { due_date: dateStr })
        showToast("common.task_updated")
        closeSnoozePopover()
        const item = document.querySelector(`.tli[data-id="${id}"]`) as HTMLElement | null
        if (item) {
          item.style.opacity = "0"
          item.style.transition = "opacity 0.3s"
          setTimeout(() => item.remove(), 300)
        }
      } catch {
        showToast("common.failed", "error")
      }
      return
    }

    // ── Click on task item → open detail ──
    const taskItem = target.closest(".tli") as HTMLElement | null
    if (taskItem && !e.defaultPrevented && !target.closest("a, button, input")) {
      const id = taskItem.dataset.id
      if (id) {
        openTaskDetailHandoff(id)
      }
    }
  })
}

// ── Snooze Popover ────────────────────────────────────────────────────────

let activeSnoozePopover: HTMLElement | null = null

function showSnoozePopover(anchor: HTMLElement) {
  closeSnoozePopover()

  const id = anchor.dataset.id
  if (!id) return

  const popover = document.createElement("div")
  popover.className = "snooze-popover"
  for (const [days, label] of [
    ["1", "+1 Day"],
    ["3", "+3 Days"],
    ["7", "+1 Week"],
    ["14", "+2 Weeks"],
    ["30", "+1 Month"],
  ] as const) {
    const btn = document.createElement("button")
    btn.dataset.snooze = days
    btn.dataset.taskId = id
    btn.className = "snooze-option"
    btn.textContent = label
    popover.appendChild(btn)
  }

  // Position near the anchor
  const rect = anchor.getBoundingClientRect()
  popover.style.cssText = `
    position: fixed;
    top: ${rect.bottom + 4}px;
    right: ${window.innerWidth - rect.right}px;
    z-index: 1000;
    background: var(--bg-card, #1e1e2e);
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 8px);
    padding: 4px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.3);
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 120px;
  `

  document.body.appendChild(popover)
  activeSnoozePopover = popover

  // Close on outside click
  lm.onTimeout(() => {
    lm.on(document, "click", closeSnoozePopover, { once: true })
  }, 0)
}

function closeSnoozePopover() {
  if (activeSnoozePopover) {
    activeSnoozePopover.remove()
    activeSnoozePopover = null
  }
}

// ── Ask AI ────────────────────────────────────────────────────────────────

let activeAiHandoff: AbortController | undefined

async function handleAskAi(el: HTMLElement) {
  if (el.dataset.aiBusy === "true") return
  activeAiHandoff?.abort()
  const request = new AbortController()
  activeAiHandoff = request
  const signal = AbortSignal.any([lm.signal, request.signal])
  const title = el.dataset.title ?? ""
  const desc = el.dataset.description ?? ""
  const status = el.dataset.status ?? "pending"
  const priority = el.dataset.priority ?? "3"

  const prompt = `I have a task in my task manager:\n\nTitle: ${title}\nStatus: ${status}\nPriority: ${priority}/5\n${desc ? `Description: ${desc}` : ""}\n\nCan you help me break this down, suggest next steps, estimate effort, or identify potential blockers?`

  el.dataset.aiBusy = "true"
  el.setAttribute("aria-busy", "true")
  try {
    const { resolveAiHandoffTarget, offerAiHandoff } = await import("@domains/ai/ai-context-service")
    const target = await resolveAiHandoffTarget(signal)
    if (!target || signal.aborted) return
    if (target.provider === "ha_llm") {
      if (!target.canUseAssist) showToast("settings.ai_handoff_ha_denied", "error")
      else if (window.openAskHaModal) window.openAskHaModal(prompt)
      else showToast("settings.ai_handoff_ha_unavailable", "error")
      return
    }
    if (!target.url) {
      showToast("settings.ai_handoff_url_invalid", "error")
      return
    }
    const url = new URL(target.url)
    const sendsTaskDetails = target.provider !== "custom" && target.provider !== "ollama"
    if (sendsTaskDetails) url.searchParams.set("q", prompt)
    await offerAiHandoff(url, sendsTaskDetails, signal)
  } catch {
    if (!signal.aborted) showToast("settings.ai_handoff_provider_unavailable", "error")
  } finally {
    if (activeAiHandoff === request) activeAiHandoff = undefined
    delete el.dataset.aiBusy
    el.removeAttribute("aria-busy")
  }
}

// ── Quick Add ─────────────────────────────────────────────────────────────

function setupQuickAdd(container: HTMLElement) {
  const quickForm = container.querySelector("#quick-add-form") as HTMLFormElement | null
  const quickInput = container.querySelector("#quick-add-input") as HTMLInputElement | null
  const quickFeedback = container.querySelector("#quick-add-feedback") as HTMLElement | null

  if (!quickForm || !quickInput) return

  lm.on(quickForm, "submit", async (e: Event) => {
    e.preventDefault()
    const text = quickInput.value.trim()
    if (!text) return

    const { payload } = quickAddPayload(text, householdToday())

    try {
      const result = await taskApi.createTask(payload)
      if (result) {
        quickInput.value = ""
        if (quickFeedback) quickFeedback.style.display = "none"
        showToast("common.task_created")
        document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "today-quick-add" } }))
      }
    } catch {
      showToast("common.failed", "error")
    }
  })

  // Live NL feedback
  let feedbackTimer: ReturnType<typeof setTimeout> | null = null
  lm.on(quickInput, "input", () => {
    if (feedbackTimer) clearTimeout(feedbackTimer)

    feedbackTimer = setTimeout(() => {
      const val = quickInput.value.trim()
      if (!val) {
        if (quickFeedback) quickFeedback.style.display = "none"
        return
      }

      const parsed = parseQuickTask(val)
      const parts: string[] = []

      if (parsed.dueDate) parts.push(`📅 Due: ${parsed.dueDate}`)
      if (parsed.priority) parts.push(`🔴 Priority: P${parsed.priority}`)
      if (parsed.labels.length > 0) parts.push(`🏷️ ${parsed.labels.join(", ")}`)
      if (parsed.assignee) parts.push(`👤 ${parsed.assignee}`)

      // Shopping / errand detection
      if (/^shopping:/i.test(val)) {
        const count = val.replace(/^shopping:\s*/i, "").split(",").filter(s => s.trim()).length
        parts.push(`🛒 Shopping list (${count} items)`)
      }
      if (/^errand:/i.test(val)) {
        const count = val.replace(/^errand:\s*/i, "").split(",").filter(s => s.trim()).length
        parts.push(`📌 Errand list (${count} items)`)
      }

      if (!parsed.dueDate && !parts.length) {
        parts.push("📅 Due: Today (default)")
      }

      if (quickFeedback) {
        quickFeedback.textContent = parts.join(" · ")
        quickFeedback.style.display = parts.length > 0 ? "block" : "none"
      }
    }, 150)
  })
}

// ── Filters ───────────────────────────────────────────────────────────────

function setupFilters(container: HTMLElement, refreshUnscheduled: () => void) {
  const update = () => {
    applyFilters(container)
    refreshUnscheduled()
  }
  const filterIds = ["today-search", "today-filter-status", "today-filter-priority", "today-filter-rice", "today-sort"]

  filterIds.forEach(id => {
    const el = container.querySelector(`#${id}`) as HTMLElement | null
    if (!el) return
    lm.on(el, id === "today-search" ? "input" : "change", update)
  })

  // Clear filters
  const clearBtn = container.querySelector("#today-clear-filters")
  if (clearBtn) lm.on(clearBtn, "click", () => {
    const search = container.querySelector("#today-search") as HTMLInputElement | null
    const status = container.querySelector("#today-filter-status") as HTMLSelectElement | null
    const priority = container.querySelector("#today-filter-priority") as HTMLSelectElement | null
    const rice = container.querySelector("#today-filter-rice") as HTMLSelectElement | null
    const sort = container.querySelector("#today-sort") as HTMLSelectElement | null

    if (search) search.value = ""
    if (status) status.value = ""
    if (priority) priority.value = ""
    if (rice) rice.value = ""
    if (sort) sort.value = "priority-asc"
    update()
  })
}

function applyFilters(container: HTMLElement) {
  const filters: TodayFilters = {
    search: container.querySelector<HTMLInputElement>("#today-search")?.value.toLowerCase() ?? "",
    status: container.querySelector<HTMLSelectElement>("#today-filter-status")?.value ?? "",
    priority: container.querySelector<HTMLSelectElement>("#today-filter-priority")?.value ?? "",
    rice: container.querySelector<HTMLSelectElement>("#today-filter-rice")?.value ?? "",
    sort: container.querySelector<HTMLSelectElement>("#today-sort")?.value ?? "priority-asc",
  }

  for (const list of container.querySelectorAll<HTMLElement>(".today-section__list:not(#today-unscheduled-list)")) {
    const items = Array.from(list.querySelectorAll<HTMLElement>(".tli"))
    for (const item of items) item.classList.toggle("filtered-out", !matchesTodayFilters(item, filters))
    items.filter(item => !item.classList.contains("filtered-out"))
      .sort((left, right) => compareTodayRows(left, right, filters.sort))
      .forEach(item => list.appendChild(item))
  }

  saveFilterState(filters)
}

function restoreFilterState() {
  try {
    const state = loadFilterState()
    if (!state || Object.keys(state).length === 0) return

    const container = document.body
    if (state.search) {
      const el = container.querySelector("#today-search") as HTMLInputElement | null
      if (el) el.value = state.search
    }
    if (state.status) {
      const el = container.querySelector("#today-filter-status") as HTMLSelectElement | null
      if (el) el.value = state.status
    }
    if (state.priority) {
      const el = container.querySelector("#today-filter-priority") as HTMLSelectElement | null
      if (el) el.value = state.priority
    }
    if (state.rice) {
      const el = container.querySelector("#today-filter-rice") as HTMLSelectElement | null
      if (el) el.value = state.rice
    }
    if (state.sort) {
      const el = container.querySelector("#today-sort") as HTMLSelectElement | null
      if (el) el.value = state.sort
    }

    if (state.search || state.status || state.priority || state.rice || state.sort) {
      applyFilters(container)
    }
  } catch {
    /* ignore */
  }
}

// ── Keyboard Navigation ───────────────────────────────────────────────────

function setupKeyboardNav(container: HTMLElement) {
  const getVisibleTasks = () =>
    Array.from(container.querySelectorAll<HTMLElement>(".tli:not(.filtered-out)"))
      .filter(task => !task.closest(".today-section--collapsed") && task.getClientRects().length > 0)

  function focusTask(index: number) {
    const items = getVisibleTasks()
    if (items.length === 0) return
    focusedIndex = Math.max(0, Math.min(index, items.length - 1))
    items.forEach((el, i) => el.classList.toggle("tli--focused", i === focusedIndex))
    items[focusedIndex]?.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }

  lm.on(document, "keydown", (evt: Event) => {
    const e = evt as KeyboardEvent
    const target = e.target
    if (!(target instanceof HTMLElement) || target.closest("input, select, textarea, button, a") || target.isContentEditable) return

    if (isDisabledCharacterShortcut(e.key)) return

    const items = getVisibleTasks()
    switch (e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault()
        focusTask(focusedIndex + 1)
        break
      case "k":
      case "ArrowUp":
        e.preventDefault()
        focusTask(focusedIndex - 1)
        break
      case "x":
        if (focusedIndex >= 0 && focusedIndex < items.length) {
          const cb = items[focusedIndex]?.querySelector(".tli__checkbox") as HTMLInputElement
          if (cb) {
            cb.checked = !cb.checked
            cb.dispatchEvent(new Event("change", { bubbles: true }))
            cb.dispatchEvent(new Event("click", { bubbles: true }))
          }
        }
        break
      case "e":
      case "Enter": {
        const task = target.closest<HTMLElement>(".tli") ?? items[focusedIndex]
        if (task?.dataset.id) {
          e.preventDefault()
          openTaskDetailHandoff(task.dataset.id)
        }
        break
      }
      case "n":
        if (!e.ctrlKey && !e.metaKey) {
          document.dispatchEvent(new CustomEvent("meitheal:new-task"))
        }
        break
      case "s":
        if (!e.ctrlKey && !e.metaKey && focusedIndex >= 0 && focusedIndex < items.length) {
          // Snooze shortcut
          const btn = items[focusedIndex]?.querySelector(".tli__snooze-btn") as HTMLElement | null
          if (btn) btn.click()
        }
        break
    }
  })
}

// ── Section Collapse ──────────────────────────────────────────────────────

function setSectionCollapsed(section: HTMLElement, collapsed: boolean) {
  section.classList.toggle("today-section--collapsed", collapsed)
  section.querySelector(".today-section__toggle")?.setAttribute("aria-expanded", String(!collapsed))
  const list = section.querySelector<HTMLElement>(".today-section__list")
  if (list) list.inert = collapsed
}

function setupSectionCollapse(container: HTMLElement) {
  try {
    const saved = localStorage.getItem(SECTION_COLLAPSE_KEY)
    if (!saved) return

    const collapsed = JSON.parse(saved) as string[]
    collapsed.forEach(id => {
      if (id === "section-unscheduled") return
      const section = container.querySelector(`#${id}`) as HTMLElement | null
      if (section) setSectionCollapsed(section, true)
    })
  } catch {
    /* ignore */
  }
}

function saveSectionState() {
  try {
    const collapsed = Array.from(
      document.querySelectorAll<HTMLElement>(".today-section--collapsed")
    ).map(el => el.id).filter(Boolean)
    localStorage.setItem(SECTION_COLLAPSE_KEY, JSON.stringify(collapsed))
  } catch {
    /* ignore */
  }
}



// ── G31: Drag to Reorder ──────────────────────────────────────────────────

function setupDragReorder(container: HTMLElement) {
  let dragSource: HTMLElement | null = null
  let reorderPending = false

  // A page of unscheduled rows cannot safely overwrite board-wide positions.
  container.querySelectorAll<HTMLElement>(".today-section__list:not(#today-unscheduled-list)").forEach(list => {
    list.querySelectorAll<HTMLElement>(".tli").forEach(item => {
      item.setAttribute("draggable", "true")

      lm.on(item, "dragstart", (e: Event) => {
        if (reorderPending) {
          e.preventDefault()
          return
        }
        const de = e as DragEvent
        dragSource = item
        item.classList.add("tli--dragging")
        de.dataTransfer?.setData("text/plain", item.dataset.id ?? "")
        if (de.dataTransfer) de.dataTransfer.effectAllowed = "move"
      })

      lm.on(item, "dragend", () => {
        item.classList.remove("tli--dragging")
        dragSource = null
        // Remove all drop indicators
        container.querySelectorAll(".tli--drag-over").forEach(el =>
          el.classList.remove("tli--drag-over")
        )
      })

      lm.on(item, "dragover", (e: Event) => {
        e.preventDefault()
        const de = e as DragEvent
        if (de.dataTransfer) de.dataTransfer.dropEffect = "move"
        item.classList.add("tli--drag-over")
      })

      lm.on(item, "dragleave", () => {
        item.classList.remove("tli--drag-over")
      })

      lm.on(item, "drop", async (e: Event) => {
        e.preventDefault()
        const de = e as DragEvent
        item.classList.remove("tli--drag-over")
        if (reorderPending || !dragSource || dragSource === item) return

        // Only allow reorder within same section list
        const sourceList = dragSource.closest(".today-section__list")
        const targetList = item.closest(".today-section__list")
        if (!sourceList || sourceList !== targetList) return

        const priorOrder = Array.from(sourceList.children)
        // Move DOM element
        const rect = item.getBoundingClientRect()
        const midY = rect.top + rect.height / 2
        if (de.clientY < midY) {
          item.parentNode?.insertBefore(dragSource, item)
        } else {
          item.parentNode?.insertBefore(dragSource, item.nextSibling)
        }

        // Persist new order via API
        const orderedIds = Array.from(
          (sourceList as HTMLElement).querySelectorAll<HTMLElement>(".tli")
        ).map(el => el.dataset.id).filter(Boolean) as string[]

        reorderPending = true
        try {
          const result = await taskApi.raw("/api/tasks/reorder", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ordered_ids: orderedIds }),
          })
          if (!result.ok) throw new Error("Task order rejected")
        } catch {
          if (sourceList.isConnected) {
            sourceList.append(...priorOrder)
            showToast("common.order_retry", "error")
          }
        } finally {
          reorderPending = false
        }
      })
    })
  })
}

// ── G32: WIP Limit Warning ────────────────────────────────────────────────

function setupWipLimit(container: HTMLElement) {
  const todaySection = container.querySelector("#section-today")
  if (!todaySection) return

  const todayTasks = todaySection.querySelectorAll(".tli:not(.tli--done)")
  if (todayTasks.length <= WIP_LIMIT) return

  const banner = document.createElement("div")
  banner.className = "wip-warning-banner"
  banner.style.cssText = `
    background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.3);
    border-radius: var(--radius-sm, 6px); padding: 8px 14px; margin-bottom: 12px;
    font-size: 13px; color: var(--warning, #f59e0b); display: flex;
    align-items: center; gap: 8px;
  `
  const iconSpan = document.createElement("span")
  iconSpan.style.fontSize = "16px"
  iconSpan.textContent = "⚠️"
  const textSpan = document.createElement("span")
  const countStrong = document.createElement("strong")
  countStrong.textContent = `${todayTasks.length} tasks`
  textSpan.append(
    countStrong,
    document.createTextNode(` due today — consider triaging or snoozing some to stay focused (recommended: ≤${WIP_LIMIT})`),
  )
  const dismissBtn = document.createElement("button")
  dismissBtn.type = "button"
  dismissBtn.className = "btn btn-sm"
  dismissBtn.style.cssText = "margin-left: auto; font-size: 11px; padding: 2px 8px;"
  dismissBtn.textContent = "Dismiss"
  dismissBtn.addEventListener("click", () => banner.remove(), { signal: pageLifecycle.signal })
  banner.replaceChildren(iconSpan, textSpan, dismissBtn)

  const statsContainer = container.querySelector("#daily-stats-container")
  if (statsContainer) {
    statsContainer.after(banner)
  }
}

// ── G33: Auto-Refresh Polling ─────────────────────────────────────────────

function setupAutoRefresh(container: HTMLElement) {
  const stats = container.querySelector("#daily-stats-container")
  if (!stats) return
  const counters = stats.querySelectorAll<HTMLElement>("[data-today-count]")
  const fill = stats.querySelector<HTMLElement>(".daily-stats-progress-fill")
  const signal = lm.signal
  let pending = false

  lm.onInterval(async () => {
    if (pending) return
    pending = true
    try {
      const resp = await fetch("/api/tasks/today-counts", { signal })
      if (!resp.ok) return
      const counts: TodayTaskCounts = await resp.json()
      if (signal.aborted) return
      for (const counter of counters) {
        const value = counts[counter.dataset.todayCount as keyof TodayTaskCounts]
        if (Number.isFinite(value)) counter.textContent = String(value)
      }
      if (fill && Number.isFinite(counts.completionPercent)) {
        fill.style.width = `${counts.completionPercent}%`
        fill.closest('[role="progressbar"]')?.setAttribute("aria-valuenow", String(counts.completionPercent))
      }
      const summary = container.querySelector("#today-signal-summary")
      if (summary && Number.isFinite(counts.dueToday) && Number.isFinite(counts.carriedForward)) {
        summary.textContent = `${counts.dueToday} due today · ${counts.carriedForward} carried forward`
      }
    } catch {
      /* Keep the last counts if the refresh fails. */
    } finally {
      pending = false
    }
  }, 30_000)
}

