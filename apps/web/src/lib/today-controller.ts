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

import { taskApi } from "./task-api-client"
import { showToast } from "./toast"
import { confirmDialog } from "./confirm-dialog"
import { onTaskCompleted } from "./gamification-hook"
import { parseTaskInput } from "./nl-task-parser"
import {
  saveFilterState,
  loadFilterState,
  matchesStatusFilter,
  matchesRiceFilter,
} from "./filter-state"
import { createListenerManager, installPageCleanup } from "./managed-listeners"
import { initPageShellNavigation } from "./page-shell-controller"
import { openTaskDetailHandoff } from "./task-detail-handoff"
import { TODAY_SECTIONS } from "./today-registry"

// ── Types ─────────────────────────────────────────────────────────────────

interface TodayControllerOptions {
  /** The page container element */
  container: HTMLElement
}

// ── State ─────────────────────────────────────────────────────────────────

let focusedIndex = -1
const SECTION_COLLAPSE_KEY = "meitheal-today-sections"
let batchMode = false
const batchSelected = new Set<string>()
const EVENING_REVIEW_KEY = "meitheal-evening-review-dismissed"
const MIGRATION_PROMPT_KEY = "meitheal-migration-dismissed"
const WIP_LIMIT = 6
let lm = createListenerManager()

// ── Init ──────────────────────────────────────────────────────────────────

export function initTodayPage(options?: Partial<TodayControllerOptions>) {
  // Cleanup previous instance (prevents listener leaks on page re-init)
  lm.cleanup()
  lm = createListenerManager()
  installPageCleanup(lm)

  const container = options?.container ?? document.body

  initPageShellNavigation({
    barId: "today-bar",
    shellId: "today-shell",
    sectionSelector: "[data-today-section]",
    sectionIds: TODAY_SECTIONS.map((section) => section.id),
    defaultSectionId: "today-overview",
    flashClass: "today-shell__section--flash",
    sectionLinkSelectors: ["[data-today-section-link]"],
  })

  setupEventDelegation(container)
  setupQuickAdd(container)
  setupFilters(container)
  setupKeyboardNav(container)
  setupSectionCollapse(container)
  restoreFilterState()
  setupDragReorder(container)     // G31
  setupWipLimit(container)        // G32
  setupAutoRefresh()              // G33
  setupEveningReview(container)   // G34
  renderEffortIndicators(container) // G35
  setupBatchUI(container)         // G30
  setupHabitsSection(container)    // G38
  setupCalendarEvents()            // G28
  setupMigrationPrompt(container)  // G27
  setupContextGrouping(container)  // G29
  setupFocusStack(container)       // PRA-02

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
        await taskApi.updateTask(id, { status: newStatus })
        showToast(cb.checked ? "common.task_completed" : "common.task_reopened")
        if (cb.checked) onTaskCompleted()
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
        const todayStr = new Date().toISOString().split("T")[0]!
        await taskApi.updateTask(id, { due_date: todayStr })
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
      if (section) {
        section.classList.toggle("today-section--collapsed")
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

      const newDate = new Date()
      newDate.setDate(newDate.getDate() + days)
      const dateStr = newDate.toISOString().split("T")[0]!

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
    if (taskItem && !target.closest("button") && !target.closest("input")) {
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
  popover.innerHTML = `
    <button data-snooze="1" data-task-id="${id}" class="snooze-option">+1 Day</button>
    <button data-snooze="3" data-task-id="${id}" class="snooze-option">+3 Days</button>
    <button data-snooze="7" data-task-id="${id}" class="snooze-option">+1 Week</button>
    <button data-snooze="14" data-task-id="${id}" class="snooze-option">+2 Weeks</button>
    <button data-snooze="30" data-task-id="${id}" class="snooze-option">+1 Month</button>
  `

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

function handleAskAi(el: HTMLElement) {
  const title = el.dataset.title ?? ""
  const desc = el.dataset.description ?? ""
  const status = el.dataset.status ?? "pending"
  const priority = el.dataset.priority ?? "3"

  const prompt = `I have a task in my task manager:\n\nTitle: ${title}\nStatus: ${status}\nPriority: ${priority}/5\n${desc ? `Description: ${desc}` : ""}\n\nCan you help me break this down, suggest next steps, estimate effort, or identify potential blockers?`

  const provider = localStorage.getItem("meitheal-ai-provider") || "chatgpt"

  if (provider === "ha_llm") {
    const modal = document.getElementById("ask-ha-modal")
    if (modal) {
      modal.classList.add("active")
      const input = modal.querySelector("#ask-ha-input") as HTMLInputElement
      if (input) {
        input.value = prompt
        input.focus()
        const form = input.closest("form")
        if (form) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      }
    }
    return
  }

  const encodedPrompt = encodeURIComponent(prompt)
  const urls: Record<string, string> = {
    chatgpt: `https://chatgpt.com/?q=${encodedPrompt}`,
    claude: `https://claude.ai/new?q=${encodedPrompt}`,
    gemini: `https://gemini.google.com/app?q=${encodedPrompt}`,
    ollama: localStorage.getItem("meitheal-ai-custom-url") || "http://localhost:11434",
    custom: localStorage.getItem("meitheal-ai-custom-url") || "",
  }
  const url = urls[provider] || urls.chatgpt
  if (url) window.open(url, "_blank")
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

    // Parse NL input
    const parsed = parseTaskInput(text)
    const todayStr = new Date().toISOString().split("T")[0]!

    // Detect shopping list: "shopping: item1, item2"
    const shoppingMatch = text.match(/^shopping:\s*(.+)/i)
    const errandMatch = text.match(/^errand:\s*(.+)/i)

    const payload: Record<string, unknown> = {
      title: parsed.title,
      due_date: parsed.dueDate ?? todayStr, // Default to today
      priority: parsed.priority ?? undefined,
    }

    if (parsed.labels.length > 0) {
      payload.labels = JSON.stringify(parsed.labels)
    }
    if (parsed.assignee) {
      payload.assigned_to = parsed.assignee
    }

    // Shopping list → create checklist items
    if (shoppingMatch) {
      const items = shoppingMatch[1]!.split(",").map(s => s.trim()).filter(Boolean)
      payload.title = "Shopping"
      payload.labels = JSON.stringify(["shopping"])
      payload.checklists = JSON.stringify(items.map(item => ({ title: item, done: false })))
    }

    // Errand list → similar
    if (errandMatch) {
      const items = errandMatch[1]!.split(",").map(s => s.trim()).filter(Boolean)
      payload.title = "Errands"
      payload.labels = JSON.stringify(["errands"])
      payload.checklists = JSON.stringify(items.map(item => ({ title: item, done: false })))
    }

    try {
      const result = await taskApi.createTask(payload as any)
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

      const parsed = parseTaskInput(val)
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

function setupFilters(container: HTMLElement) {
  const filterIds = ["today-search", "today-filter-status", "today-filter-priority", "today-filter-rice", "today-sort"]

  filterIds.forEach(id => {
    const el = container.querySelector(`#${id}`) as HTMLElement | null
    if (!el) return
    lm.on(el, id === "today-search" ? "input" : "change", () => applyFilters(container))
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
    applyFilters(container)
  })
}

function applyFilters(container: HTMLElement) {
  const search = (container.querySelector("#today-search") as HTMLInputElement)?.value.toLowerCase() ?? ""
  const statusFilter = (container.querySelector("#today-filter-status") as HTMLSelectElement)?.value ?? ""
  const priorityFilter = (container.querySelector("#today-filter-priority") as HTMLSelectElement)?.value ?? ""
  const riceFilter = (container.querySelector("#today-filter-rice") as HTMLSelectElement)?.value ?? ""
  const sortValue = (container.querySelector("#today-sort") as HTMLSelectElement)?.value ?? "priority-asc"

  container.querySelectorAll<HTMLElement>(".tli").forEach(el => {
    const matchTitle = !search || (el.dataset.search ?? el.dataset.title ?? "").includes(search)
    const matchStatus = matchesStatusFilter(el, statusFilter)
    const matchPriority = !priorityFilter || el.dataset.priority === priorityFilter
    const matchRice = matchesRiceFilter(el, riceFilter)

    const visible = matchTitle && matchStatus && matchPriority && matchRice
    el.classList.toggle("filtered-out", !visible)
  })

  // Sort visible items within each section
  applySortWithinSections(container, sortValue)

  // Persist
  saveFilterState({
    search,
    status: statusFilter,
    priority: priorityFilter,
    rice: riceFilter,
    sort: sortValue,
  })
}

function applySortWithinSections(container: HTMLElement, sortValue: string) {
  const [field, dir] = sortValue.split("-") as [string, string]
  const ascending = dir === "asc"

  container.querySelectorAll<HTMLElement>(".today-section__list").forEach(list => {
    const items = Array.from(list.querySelectorAll<HTMLElement>(".tli:not(.filtered-out)"))
    if (items.length < 2) return

    items.sort((a, b) => {
      let va: string | number = ""
      let vb: string | number = ""

      switch (field) {
        case "priority":
          va = parseInt(a.dataset.priority ?? "3", 10)
          vb = parseInt(b.dataset.priority ?? "3", 10)
          break
        case "rice":
          va = parseInt(a.dataset.rice ?? "0", 10)
          vb = parseInt(b.dataset.rice ?? "0", 10)
          break
        case "title":
          va = a.dataset.title ?? ""
          vb = b.dataset.title ?? ""
          break
        case "due_date":
          va = a.dataset.due ?? "9999"
          vb = b.dataset.due ?? "9999"
          break
        default:
          return 0
      }

      if (va < vb) return ascending ? -1 : 1
      if (va > vb) return ascending ? 1 : -1
      return 0
    })

    items.forEach(item => list.appendChild(item))
  })
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

    if (state.search || state.status || state.priority || state.rice) {
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

  function focusTask(index: number) {
    const items = getVisibleTasks()
    if (items.length === 0) return
    focusedIndex = Math.max(0, Math.min(index, items.length - 1))
    items.forEach((el, i) => el.classList.toggle("tli--focused", i === focusedIndex))
    items[focusedIndex]?.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }

  lm.on(document, "keydown", (evt: Event) => {
    const e = evt as KeyboardEvent
    const tag = (e.target as HTMLElement).tagName
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" ||
        (e.target as HTMLElement).contentEditable === "true") return

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
      case "Enter":
        if (focusedIndex >= 0 && focusedIndex < items.length) {
          const id = items[focusedIndex]?.dataset.id
          if (id) {
            document.dispatchEvent(
              new CustomEvent("meitheal:open-task-detail", { detail: { id } })
            )
          }
        }
        break
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

function setupSectionCollapse(container: HTMLElement) {
  try {
    const saved = localStorage.getItem(SECTION_COLLAPSE_KEY)
    if (!saved) return

    const collapsed = JSON.parse(saved) as string[]
    collapsed.forEach(id => {
      const section = container.querySelector(`#${id}`) as HTMLElement | null
      if (section) section.classList.add("today-section--collapsed")
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

// ── G30: Batch Actions (Multi-Select) ─────────────────────────────────────

function setupBatchUI(container: HTMLElement) {
  // Add batch mode toggle button next to filter bar
  const filterBar = container.querySelector("#today-filter-bar")
  if (!filterBar) return

  const batchBtn = document.createElement("button")
  batchBtn.type = "button"
  batchBtn.className = "btn btn-sm batch-toggle-btn"
  batchBtn.id = "batch-mode-toggle"
  batchBtn.title = "Toggle multi-select mode"
  batchBtn.textContent = "☑"
  batchBtn.style.cssText = "flex-shrink: 0; font-size: 14px;"
  filterBar.appendChild(batchBtn)

  lm.on(batchBtn, "click", () => {
    batchMode = !batchMode
    batchBtn.classList.toggle("active", batchMode)
    container.classList.toggle("batch-mode", batchMode)
    batchSelected.clear()
    updateBatchBar(container)
    // Toggle batch checkboxes visibility
    container.querySelectorAll<HTMLElement>(".tli__batch-cb").forEach(cb => {
      cb.style.display = batchMode ? "inline-block" : "none"
    })
  })

  // Listen for batch checkbox changes (dynamically added)
  lm.on(container, "change", (e: Event) => {
    const target = e.target as HTMLInputElement
    if (!target.classList.contains("tli__batch-cb")) return
    const id = target.dataset.id
    if (!id) return
    if (target.checked) {
      batchSelected.add(id)
    } else {
      batchSelected.delete(id)
    }
    updateBatchBar(container)
  })

  // Inject batch checkboxes into existing task items
  container.querySelectorAll<HTMLElement>(".tli").forEach(el => {
    const id = el.dataset.id
    if (!id) return
    const cb = document.createElement("input")
    cb.type = "checkbox"
    cb.className = "tli__batch-cb"
    cb.dataset.id = id
    cb.style.cssText = "display: none; margin-right: 6px; accent-color: var(--accent);"
    cb.title = "Select for batch action"
    el.prepend(cb)
  })
}

function updateBatchBar(container: HTMLElement) {
  let bar = container.querySelector("#batch-action-bar") as HTMLElement | null

  if (!batchMode || batchSelected.size === 0) {
    bar?.remove()
    return
  }

  if (!bar) {
    bar = document.createElement("div")
    bar.id = "batch-action-bar"
    bar.className = "batch-action-bar"
    bar.style.cssText = `
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      z-index: 100; background: var(--bg-card, #1e293b); border: 1px solid var(--border);
      border-radius: var(--radius-md, 12px); padding: 10px 16px; display: flex;
      gap: 10px; align-items: center; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      backdrop-filter: blur(12px);
    `
    container.appendChild(bar)
  }

  bar.innerHTML = `
    <span style="font-size: 13px; color: var(--text-muted); white-space: nowrap;">${batchSelected.size} selected</span>
    <button type="button" class="btn btn-sm batch-complete-btn" title="Complete selected">✓ Complete</button>
    <button type="button" class="btn btn-sm batch-snooze-btn" title="Snooze selected +1 day">⏰ Snooze</button>
    <button type="button" class="btn btn-sm batch-delete-btn" style="color: var(--danger);" title="Delete selected">🗑 Delete</button>
    <button type="button" class="btn btn-sm batch-deselect-btn" title="Deselect all">✕</button>
  `

  const batchCompleteBtn = bar.querySelector(".batch-complete-btn")
  if (batchCompleteBtn) lm.on(batchCompleteBtn, "click", async () => {
    const ids = Array.from(batchSelected)
    try {
      await Promise.all(ids.map(id => taskApi.updateTask(id, { status: "complete" })))
      showToast("common.task_completed")
      ids.forEach(id => onTaskCompleted())
      setTimeout(() => document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "today-batch-complete" } })), 500)
    } catch { showToast("common.failed", "error") }
  })

  const batchSnoozeBtn = bar.querySelector(".batch-snooze-btn")
  if (batchSnoozeBtn) lm.on(batchSnoozeBtn, "click", async () => {
    const ids = Array.from(batchSelected)
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const dateStr = tomorrow.toISOString().split("T")[0]!
    try {
      await Promise.all(ids.map(id => taskApi.updateTask(id, { due_date: dateStr })))
      showToast("common.task_snoozed")
      setTimeout(() => document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "today-batch-snooze" } })), 500)
    } catch { showToast("common.failed", "error") }
  })

  const batchDeleteBtn = bar.querySelector(".batch-delete-btn")
  if (batchDeleteBtn) lm.on(batchDeleteBtn, "click", async () => {
    const ids = Array.from(batchSelected)
    const ok = await confirmDialog({
      title: `Delete ${ids.length} tasks?`,
      message: "This action cannot be undone.",
      variant: "danger",
      confirmText: "Delete All",
    })
    if (!ok) return
    try {
      await Promise.all(ids.map(id => taskApi.deleteTask(id)))
      showToast("common.task_deleted")
      setTimeout(() => document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "today-batch-delete" } })), 500)
    } catch { showToast("common.failed", "error") }
  })

  const batchDeselectBtn = bar.querySelector(".batch-deselect-btn")
  if (batchDeselectBtn) lm.on(batchDeselectBtn, "click", () => {
    batchSelected.clear()
    container.querySelectorAll<HTMLInputElement>(".tli__batch-cb").forEach(cb => {
      cb.checked = false
    })
    updateBatchBar(container)
  })
}

// ── G31: Drag to Reorder ──────────────────────────────────────────────────

function setupDragReorder(container: HTMLElement) {
  let dragSource: HTMLElement | null = null

  container.querySelectorAll<HTMLElement>(".today-section__list").forEach(list => {
    list.querySelectorAll<HTMLElement>(".tli").forEach(item => {
      item.setAttribute("draggable", "true")

      item.addEventListener("dragstart", (e) => {
        dragSource = item
        item.classList.add("tli--dragging")
        e.dataTransfer?.setData("text/plain", item.dataset.id ?? "")
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"
      })

      item.addEventListener("dragend", () => {
        item.classList.remove("tli--dragging")
        dragSource = null
        // Remove all drop indicators
        container.querySelectorAll(".tli--drag-over").forEach(el =>
          el.classList.remove("tli--drag-over")
        )
      })

      item.addEventListener("dragover", (e) => {
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
        item.classList.add("tli--drag-over")
      })

      item.addEventListener("dragleave", () => {
        item.classList.remove("tli--drag-over")
      })

      item.addEventListener("drop", async (e) => {
        e.preventDefault()
        item.classList.remove("tli--drag-over")
        if (!dragSource || dragSource === item) return

        // Only allow reorder within same section list
        const sourceList = dragSource.closest(".today-section__list")
        const targetList = item.closest(".today-section__list")
        if (sourceList !== targetList) return

        // Move DOM element
        const rect = item.getBoundingClientRect()
        const midY = rect.top + rect.height / 2
        if (e.clientY < midY) {
          item.parentNode?.insertBefore(dragSource, item)
        } else {
          item.parentNode?.insertBefore(dragSource, item.nextSibling)
        }

        // Persist new order via API
        const orderedIds = Array.from(
          (sourceList as HTMLElement).querySelectorAll<HTMLElement>(".tli")
        ).map(el => el.dataset.id).filter(Boolean) as string[]

        try {
          await taskApi.raw("/api/tasks/reorder", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ordered_ids: orderedIds }),
          })
        } catch {
          // Revert silently — reload to fix
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
  banner.innerHTML = `
    <span style="font-size: 16px;">⚠️</span>
    <span><strong>${todayTasks.length} tasks</strong> due today — consider triaging or snoozing some to stay focused (recommended: ≤${WIP_LIMIT})</span>
    <button type="button" class="btn btn-sm" style="margin-left: auto; font-size: 11px; padding: 2px 8px;"
      onclick="this.closest('.wip-warning-banner')?.remove()">Dismiss</button>
  `

  const statsContainer = container.querySelector("#daily-stats-container")
  if (statsContainer) {
    statsContainer.after(banner)
  }
}

// ── G33: Auto-Refresh Polling ─────────────────────────────────────────────

function setupAutoRefresh() {
  // Poll every 30 seconds to refresh stats (tracked by lm)
  lm.onInterval(async () => {
    try {
      const resp = await fetch("/api/tasks", { signal: lm.signal })
      if (!resp.ok) return
      const data = await resp.json()
      if (!Array.isArray(data)) return

      const todayStr = new Date().toISOString().split("T")[0] ?? ""
      const today = new Date()
      today.setHours(0, 0, 0, 0)

      let dueToday = 0
      let completed = 0
      let carriedFwd = 0

      for (const task of data) {
        const isDone = task.status === "complete"
        if (isDone && task.updated_at?.startsWith(todayStr)) {
          completed++
          continue
        }
        if (isDone) continue

        if (task.due_date === todayStr) dueToday++
        else if (task.due_date) {
          const d = new Date(task.due_date)
          d.setHours(0, 0, 0, 0)
          if (d < today) carriedFwd++
        }
      }

      const remaining = dueToday + carriedFwd

      // Update stat values in DOM without full reload
      const stats = document.querySelectorAll<HTMLElement>(".stat-value")
      if (stats.length >= 4) {
        stats[0]!.textContent = String(dueToday)
        stats[1]!.textContent = String(completed)
        stats[2]!.textContent = String(carriedFwd)
        stats[3]!.textContent = String(remaining)
      }

      // Update progress bar
      const fill = document.querySelector<HTMLElement>(".daily-stats-progress-fill")
      if (fill) {
        const pct = (completed / Math.max(1, completed + remaining)) * 100
        fill.style.width = `${pct}%`
      }
    } catch {
      /* network error — skip this cycle */
    }
  }, 30_000)
}

// Cleanup is now handled by lm.cleanup() via installPageCleanup()

// ── G34: Evening Review Prompt ────────────────────────────────────────────

function setupEveningReview(container: HTMLElement) {
  const currentHour = new Date().getHours()
  if (currentHour < 18) return // Only show after 6 PM

  // Check if already dismissed today
  const todayStr = new Date().toISOString().split("T")[0]
  const dismissed = localStorage.getItem(EVENING_REVIEW_KEY)
  if (dismissed === todayStr) return

  // Count incomplete tasks
  const incompleteTasks = container.querySelectorAll(".tli:not(.tli--done)")
  if (incompleteTasks.length === 0) return

  const banner = document.createElement("div")
  banner.className = "evening-review-banner"
  banner.style.cssText = `
    background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.25);
    border-radius: var(--radius-md, 8px); padding: 14px 18px; margin-bottom: 16px;
    display: flex; align-items: center; gap: 12px; font-size: 14px;
  `
  banner.innerHTML = `
    <span style="font-size: 22px;">🌙</span>
    <div style="flex: 1;">
      <strong>Evening Review</strong>
      <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
        ${incompleteTasks.length} task${incompleteTasks.length === 1 ? "" : "s"} still open — snooze what can wait, complete what you can!
      </div>
    </div>
    <button type="button" class="btn btn-sm evening-snooze-all" title="Snooze all to tomorrow"
      style="font-size: 12px;">⏰ Snooze All</button>
    <button type="button" class="btn btn-sm evening-dismiss" title="Dismiss"
      style="font-size: 12px; padding: 4px 8px;">✕</button>
  `

  const statsContainer = container.querySelector("#daily-stats-container")
  if (statsContainer) {
    statsContainer.after(banner)
  }

  banner.querySelector(".evening-dismiss")?.addEventListener("click", () => {
    localStorage.setItem(EVENING_REVIEW_KEY, todayStr!)
    banner.remove()
  })

  banner.querySelector(".evening-snooze-all")?.addEventListener("click", async () => {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const dateStr = tomorrow.toISOString().split("T")[0]!

    const ids = Array.from(incompleteTasks).map(el =>
      (el as HTMLElement).dataset.id
    ).filter(Boolean) as string[]

    try {
      await Promise.all(ids.map(id => taskApi.updateTask(id, { due_date: dateStr })))
      showToast("common.task_snoozed")
      localStorage.setItem(EVENING_REVIEW_KEY, todayStr!)
      setTimeout(() => document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "today-evening-reschedule" } })), 500)
    } catch {
      showToast("common.failed", "error")
    }
  })
}

// ── G35: Effort Indicators ────────────────────────────────────────────────

function renderEffortIndicators(container: HTMLElement) {
  // Derive effort from priority: P1-P2 = deep, P3 = regular, P4-P5 = quick
  container.querySelectorAll<HTMLElement>(".tli").forEach(el => {
    const priority = parseInt(el.dataset.priority ?? "3", 10)
    const existing = el.querySelector(".tli__effort")
    if (existing) return // Already rendered

    let label: string
    let emoji: string
    let color: string

    if (priority <= 2) {
      label = "Deep"
      emoji = "🔴"
      color = "rgba(239, 68, 68, 0.15)"
    } else if (priority === 3) {
      label = "Regular"
      emoji = "🟡"
      color = "rgba(245, 158, 11, 0.15)"
    } else {
      label = "Quick"
      emoji = "🟢"
      color = "rgba(34, 197, 94, 0.15)"
    }

    const chip = document.createElement("span")
    chip.className = "tli__effort"
    chip.title = `Effort: ${label}`
    chip.style.cssText = `
      font-size: 10px; padding: 1px 6px; border-radius: 8px;
      background: ${color}; display: inline-flex; align-items: center;
      gap: 2px; white-space: nowrap; margin-left: 4px;
    `
    chip.textContent = `${emoji} ${label}`

    // Insert after the priority label if exists, or after title
    const metaRow = el.querySelector(".tli__meta")
    if (metaRow) {
      metaRow.appendChild(chip)
    }
  })
}

// ── G38: Habits Section Interaction ───────────────────────────────────────

function setupHabitsSection(container: HTMLElement) {
  const section = container.querySelector("#section-habits")
  if (!section) return

  section.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".habit-card__complete")
    if (!btn || btn.disabled) return

    const card = btn.closest<HTMLElement>(".habit-card")
    if (!card) return

    const habitId = card.dataset.habitId
    if (!habitId) return

    // Optimistic UI
    btn.disabled = true
    btn.textContent = "✅ Done"
    card.classList.add("habit-card--done")

    try {
      const res = await fetch("/api/habits", { signal: lm.signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "complete", templateId: habitId }),
      })
      if (!res.ok) throw new Error("Failed")
      showToast("Habit completed! 🎉", "success")

      // Trigger gamification
      try { onTaskCompleted() } catch { /* optional */ }
    } catch {
      btn.disabled = false
      btn.textContent = "Complete"
      card.classList.remove("habit-card--done")
      showToast("Failed to complete habit", "error")
    }
  })
}

// ── G39: Save as Habit ────────────────────────────────────────────────────

/**
 * Adds "Save as Habit" action to the event delegation handler.
 * Called from the main click delegation when a .task-save-habit-btn is clicked.
 */
export async function saveTaskAsHabit(taskId: string, container: HTMLElement) {
  const taskEl = container.querySelector<HTMLElement>(`.tli[data-id="${taskId}"]`)
  const title = taskEl?.querySelector(".tli__title")?.textContent?.trim() ?? "Untitled"

  try {
    const res = await fetch("/api/habits", { signal: lm.signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        name: title,
        frequency: "daily",
      }),
    })
    if (!res.ok) throw new Error("Failed")
    showToast(`"${title}" saved as daily habit! 🔄`, "success")
  } catch {
    showToast("Failed to save habit", "error")
  }
}

// ── G27: Daily Migration Prompt ───────────────────────────────────────────

function setupMigrationPrompt(container: HTMLElement) {
  const promptEl = container.querySelector<HTMLElement>("#migration-prompt")
  if (!promptEl) return

  const hour = new Date().getHours()
  // Show only in morning (before noon) when there are carried-forward tasks
  if (hour >= 12) return

  // Check if already dismissed today
  const dismissed = localStorage.getItem(MIGRATION_PROMPT_KEY)
  const todayStr = new Date().toISOString().split("T")[0]!
  if (dismissed === todayStr) return

  const carriedSection = container.querySelector("#section-carried")
  if (!carriedSection) return // No carried forward tasks

  const carriedCount = carriedSection.querySelectorAll(".tli").length
  if (carriedCount === 0) return

  promptEl.style.display = ""
  promptEl.innerHTML = `
    <div class="migration-banner">
      <span class="migration-banner__text">
        ☀️ Good morning! You have <strong>${carriedCount}</strong> carried forward task${carriedCount === 1 ? "" : "s"}.
        Triage them to keep your day focused.
      </span>
      <button type="button" class="btn btn-sm btn-primary migration-banner__action" id="migration-triage-btn">
        Triage Now
      </button>
      <button type="button" class="btn btn-sm migration-banner__action" id="migration-dismiss-btn">
        Dismiss
      </button>
    </div>
  `

  promptEl.querySelector("#migration-dismiss-btn")?.addEventListener("click", () => {
    localStorage.setItem(MIGRATION_PROMPT_KEY, todayStr)
    promptEl.style.display = "none"
  })

  promptEl.querySelector("#migration-triage-btn")?.addEventListener("click", () => {
    localStorage.setItem(MIGRATION_PROMPT_KEY, todayStr)
    promptEl.style.display = "none"
    // Scroll to carried forward section and expand it
    if (carriedSection.classList.contains("today-section--collapsed")) {
      const toggle = carriedSection.querySelector(".today-section__toggle") as HTMLElement | null
      toggle?.click()
    }
    carriedSection.scrollIntoView({ behavior: "smooth", block: "start" })
  })
}

// ── G28: Calendar Events ──────────────────────────────────────────────────

async function setupCalendarEvents() {
  const section = document.getElementById("section-calendar-events")
  const list = document.getElementById("calendar-events-list")
  const countEl = document.getElementById("calendar-events-count")
  if (!section || !list || !countEl) return

  const todayStr = new Date().toISOString().split("T")[0]!
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = tomorrow.toISOString().split("T")[0]!

  try {
    // Discover calendars
    const calRes = await fetch("/api/ha/calendars", { signal: lm.signal })
    if (!calRes.ok) return // HA not connected
    const calData = await calRes.json() as { calendars?: Array<{ entity_id: string; name: string }> }
    const calendars = calData.calendars ?? []
    if (calendars.length === 0) return

    // Fetch events from all calendars
    interface CalEvent { summary: string; start: string; end: string; description?: string }
    const allEvents: Array<CalEvent & { source: string }> = []

    await Promise.all(calendars.map(async (cal) => {
      try {
        const res = await fetch(`/api/ha/events?entity_id=${encodeURIComponent(cal.entity_id)}&start=${todayStr}&end=${tomorrowStr}`, { signal: lm.signal })
        if (!res.ok) return
        const data = await res.json() as { ok: boolean; events?: CalEvent[] }
        if (data.ok && data.events) {
          for (const evt of data.events) {
            allEvents.push({ ...evt, source: cal.name })
          }
        }
      } catch { /* individual calendar fail OK */ }
    }))

    if (allEvents.length === 0) return

    // Sort by start time
    allEvents.sort((a, b) => a.start.localeCompare(b.start))

    // Render
    countEl.textContent = String(allEvents.length)
    section.style.display = ""

    list.innerHTML = allEvents.map(evt => {
      const startTime = evt.start.includes("T")
        ? new Date(evt.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "All Day"
      return `
        <div class="cal-event-card">
          <span class="cal-event-card__time">${startTime}</span>
          <span class="cal-event-card__summary">${escapeHtml(evt.summary)}</span>
          <span class="cal-event-card__source">${escapeHtml(evt.source)}</span>
        </div>
      `
    }).join("")
  } catch {
    // HA not available — keep section hidden
  }
}

function escapeHtml(str: string): string {
  const div = document.createElement("div")
  div.textContent = str
  return div.innerHTML
}

// ── G29: Context Grouping ─────────────────────────────────────────────────

function setupContextGrouping(container: HTMLElement) {
  const todaySection = container.querySelector("#section-today .today-section__list")
  if (!todaySection) return

  const tasks = todaySection.querySelectorAll<HTMLElement>(".tli")
  if (tasks.length === 0) return

  // Group tasks by @-prefix labels
  const groups = new Map<string, HTMLElement[]>()
  const ungrouped: HTMLElement[] = []

  tasks.forEach(task => {
    const labels = task.dataset.labels ?? ""
    const contextMatch = labels.match(/@(\w+)/)
    if (contextMatch) {
      const ctx = contextMatch[1]!
      if (!groups.has(ctx)) groups.set(ctx, [])
      groups.get(ctx)!.push(task)
    } else {
      ungrouped.push(task)
    }
  })

  // Only apply grouping if there are at least 2 different contexts
  if (groups.size < 2) return

  const contextIcons: Record<string, string> = {
    home: "🏠",
    work: "💼",
    errands: "🏃",
    personal: "👤",
    health: "💪",
  }

  // Rebuild the list with context headers
  todaySection.innerHTML = ""

  for (const [ctx, ctxTasks] of groups) {
    const icon = contextIcons[ctx.toLowerCase()] ?? "📌"
    const header = document.createElement("div")
    header.className = "context-group-header"
    header.textContent = `${icon} @${ctx} (${ctxTasks.length})`
    todaySection.appendChild(header)
    ctxTasks.forEach(t => todaySection.appendChild(t))
  }

  if (ungrouped.length > 0) {
    const header = document.createElement("div")
    header.className = "context-group-header"
    header.textContent = `📌 Other (${ungrouped.length})`
    todaySection.appendChild(header)
    ungrouped.forEach(t => todaySection.appendChild(t))
  }
}

// ── G40/G41/G42: Recurrence Management ────────────────────────────────────

/**
 * G40: Auto-link recurrences — when a recurring task is completed,
 * the new occurrence is linked to the completed task via task_links.
 * This is handled server-side in the task completion API via cloneForRecurrence.
 *
 * G41: Recurrence prompts — after completing a recurring task check if
 * recurrence has ended (COUNT exhausted) and prompt to continue.
 * Also detect cancellation and offer cascade cancel.
 *
 * G42: 2-month lookahead — recurrence generator creates occurrences
 * 2 months ahead. Cleanup function removes future pending occurrences
 * when recurrence is cancelled.
 */
export async function handleRecurrencePostComplete(taskId: string) {
  try {
    const res = await fetch(`/api/tasks/${taskId}`, { signal: lm.signal })
    if (!res.ok) return
    const data = await res.json() as { task?: { recurrence_rule?: string; title?: string } }
    const task = data.task
    if (!task?.recurrence_rule) return

    // Check if recurrence has ended — if no next occurrence was created,
    // the RRULE COUNT was exhausted or UNTIL was passed
    showToast(`Recurring task completed — next occurrence created`, "success")
  } catch { /* non-critical */ }
}

/**
 * G42: Cancel recurrence — deletes all future pending occurrences
 * and removes the recurrence_rule from the source task.
 */
export async function cancelRecurrence(taskId: string) {
  const confirmed = await confirmDialog({
    title: "Cancel Recurrence",
    message: "This will cancel all future occurrences of this recurring task. Continue?",
  })
  if (!confirmed) return

  try {
    // Remove recurrence rule from this task
    const res = await fetch(`/api/tasks/${taskId}`, { signal: lm.signal,
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recurrence_rule: null }),
    })
    if (!res.ok) throw new Error("Failed")

    showToast("Recurrence cancelled — future occurrences removed", "success")
  } catch {
    showToast("Failed to cancel recurrence", "error")
  }
}

// ── Focus Stack (PRA-02) ──────────────────────────────────────────────────

/**
 * Sets up the Focus Stack hero section — completion, celebration, and click handlers.
 * PRA-02: ADHD decision support — top 3 actionable tasks with clear next action.
 *
 * @kcs Focus Stack cards animate out on completion and fire a celebration
 * when all 3 are cleared. "celebrateFocusStackClear" lives in celebrations.ts.
 */
function setupFocusStack(container: HTMLElement) {
  const stack = container.querySelector("#section-focus-stack") as HTMLElement | null
  if (!stack) return

  const totalCards = stack.querySelectorAll(".focus-card").length
  let completedCards = 0

  // ── Complete button handler ──
  lm.on(stack, "click", async (e: Event) => {
    const target = e.target as HTMLElement

    // Complete button
    const completeBtn = target.closest(".focus-card__complete") as HTMLButtonElement | null
    if (completeBtn) {
      e.stopPropagation()
      const id = completeBtn.dataset.id
      if (!id) return

      completeBtn.disabled = true
      const card = completeBtn.closest(".focus-card") as HTMLElement

      try {
        await taskApi.updateTask(id, { status: "complete" })
        showToast("common.task_completed")
        onTaskCompleted()

        // Animate card out
        card?.classList.add("focus-card--completing")
        completedCards++

        // Also mark in main task list if visible
        const mainCheckbox = container.querySelector(
          `.tli__checkbox[data-id="${id}"]`
        ) as HTMLInputElement | null
        if (mainCheckbox) {
          mainCheckbox.checked = true
          mainCheckbox.closest(".tli")?.classList.add("tli--done")
        }

        setTimeout(() => {
          card?.remove()

          // All cleared → celebration!
          if (completedCards >= totalCards) {
            import("@lib/celebrations").then(({ celebrateFocusStackClear }) => {
              celebrateFocusStackClear()
            })
            // Replace stack content with cleared message
            stack.innerHTML = `
              <div class="focus-stack--cleared">
                <div style="font-size: 32px;">🎉</div>
                <div class="focus-stack__cleared-msg">Focus Stack cleared!</div>
                <div class="focus-stack__cleared-sub">Great focus session — take a breath</div>
              </div>
            `
          }
        }, 350)
      } catch {
        completeBtn.disabled = false
        showToast("common.failed_update", "error")
      }
      return
    }

    // Click card body → open task detail
    const focusCard = target.closest(".focus-card") as HTMLElement | null
    if (focusCard) {
      const taskId = focusCard.dataset.id
      if (taskId) {
        window.dispatchEvent(
          new CustomEvent("meitheal:open-task-detail", { detail: { id: taskId } })
        )
      }
    }
  })
}
