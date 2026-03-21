/**
 * tasks-view-controller.ts — Client-side view switching for the unified /tasks page.
 *
 * Manages hash-based navigation between Kanban, Table, Calendar, and Timeline views.
 * Each view container is shown/hidden via CSS. View controllers are lazily initialized
 * on first display via the `meitheal:view-changed` custom event.
 *
 * @domain navigation
 * @phase 16.1 — Client-side view switching
 *
 * Persona Enhancements:
 * - T3: Double-init guard with Set<string> + data-view-initialized attribute
 * - T6: Keyboard shortcuts 1-4 for view switching when no input is focused
 * - T7: Per-view scroll position save/restore
 * - T8: ARIA tablist/tab roles on view switcher buttons
 */

const VALID_VIEWS = ["kanban", "table", "calendar", "timeline"] as const
type TaskView = (typeof VALID_VIEWS)[number]

const DEFAULT_VIEW: TaskView = "kanban"
const STORAGE_KEY = "meitheal:tasks-last-view"

/** [T3] Track initialized views to prevent double-init on rapid switching */
const initializedViews = new Set<TaskView>()

/** [T7] Per-view scroll positions for restore on switch */
const scrollPositions = new Map<TaskView, number>()

/**
 * Resolve the active view from the URL hash, localStorage, or default.
 */
function resolveActiveView(): TaskView {
  const hash = window.location.hash.replace("#", "")
  if (VALID_VIEWS.includes(hash as TaskView)) return hash as TaskView

  // Fallback to last-used view
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored && VALID_VIEWS.includes(stored as TaskView)) return stored as TaskView
  } catch { /* localStorage unavailable */ }

  return DEFAULT_VIEW
}

/** [T7] Save scroll position for the current view */
function saveScrollPosition(view: TaskView) {
  const container = document.getElementById(`tasks-view-${view}`)
  if (container) {
    scrollPositions.set(view, container.scrollTop)
  }
}

/** [T7] Restore scroll position for the target view */
function restoreScrollPosition(view: TaskView) {
  const container = document.getElementById(`tasks-view-${view}`)
  if (container) {
    const saved = scrollPositions.get(view)
    if (saved !== undefined) {
      container.scrollTop = saved
    }
  }
}

/** Get the currently visible view */
function getCurrentView(): TaskView | null {
  for (const v of VALID_VIEWS) {
    const container = document.getElementById(`tasks-view-${v}`)
    if (container && container.style.display !== "none") return v
  }
  return null
}

/**
 * Switch the visible view container.
 */
function switchView(view: TaskView) {
  // [T7] Save scroll of the current view before switching
  const current = getCurrentView()
  if (current && current !== view) {
    saveScrollPosition(current)
  }

  // Hide all view containers
  for (const v of VALID_VIEWS) {
    const container = document.getElementById(`tasks-view-${v}`)
    if (container) {
      container.style.display = v === view ? "" : "none"
      container.setAttribute("aria-hidden", v === view ? "false" : "true")
    }
  }

  // [T8] Update view tab pills with ARIA selected state
  document.querySelectorAll<HTMLElement>("[data-view-tab]").forEach(tab => {
    const isActive = tab.dataset.viewTab === view
    tab.classList.toggle("is-active", isActive)
    tab.classList.toggle("active", isActive)
    tab.setAttribute("aria-selected", String(isActive))
    tab.setAttribute("tabindex", isActive ? "0" : "-1")
  })

  // Update URL hash without scroll jump
  if (window.location.hash !== `#${view}`) {
    history.replaceState(null, "", `#${view}`)
  }

  // B1: Update browser tab title to reflect active view
  const viewTitles: Record<TaskView, string> = {
    kanban: "Kanban Board",
    table: "Table View",
    calendar: "Calendar",
    timeline: "Timeline",
  }
  document.title = `Meitheal — ${viewTitles[view]}`
  // Also update the page heading
  const heading = document.querySelector(".unified-bar__title-text")
  if (heading) heading.textContent = viewTitles[view]

  // Persist preference
  try {
    localStorage.setItem(STORAGE_KEY, view)
  } catch { /* localStorage unavailable */ }

  // [T3] Fire view-changed event with double-init guard
  const firstInit = !initializedViews.has(view)
  if (firstInit) {
    initializedViews.add(view)
    const container = document.getElementById(`tasks-view-${view}`)
    container?.setAttribute("data-view-initialized", "true")
  }

  window.dispatchEvent(new CustomEvent("meitheal:view-changed", {
    detail: { view, firstInit },
  }))

  // Phase 16.3: Toggle view-specific toolbar elements (Fields/Lanes for kanban-only)
  document.querySelectorAll<HTMLElement>("[data-view-only]").forEach(el => {
    const showForView = el.dataset.viewOnly
    el.classList.toggle("is-active", showForView === view)
  })

  // [T7] Restore scroll position after switching
  requestAnimationFrame(() => restoreScrollPosition(view))
}

/**
 * Initialize the tasks view controller.
 * Call from the page's script block via pageLifecycle.
 */
export function initTasksViewSwitcher(signal?: AbortSignal) {
  const activeView = resolveActiveView()

  // Mark kanban as always initialized (it's the default SSR view)
  initializedViews.add("kanban")

  // [T8] Set up ARIA tablist role on view tab container
  const tabContainer = document.querySelector("[data-view-tabs]")
  if (tabContainer) {
    tabContainer.setAttribute("role", "tablist")
    tabContainer.setAttribute("aria-label", "Task view switcher")
  }

  // [T8] Set up ARIA tab roles on individual buttons
  document.querySelectorAll<HTMLElement>("[data-view-tab]").forEach((tab, index) => {
    tab.setAttribute("role", "tab")
    const viewName = tab.dataset.viewTab ?? ""
    tab.setAttribute("aria-label", `Switch to ${viewName.charAt(0).toUpperCase() + viewName.slice(1)} view`)
    tab.setAttribute("tabindex", tab.dataset.viewTab === activeView ? "0" : "-1")
    tab.setAttribute("aria-selected", String(tab.dataset.viewTab === activeView))
  })

  // Initial switch
  switchView(activeView)

  // Listen for hash changes (browser back/forward)
  const onHashChange = () => {
    const hash = window.location.hash.replace("#", "")
    if (VALID_VIEWS.includes(hash as TaskView)) {
      switchView(hash as TaskView)
    }
  }
  window.addEventListener("hashchange", onHashChange, signal ? { signal } : undefined)

  // Listen for programmatic tab clicks
  document.querySelectorAll<HTMLElement>("[data-view-tab]").forEach(tab => {
    tab.addEventListener("click", (e) => {
      e.preventDefault()
      const view = tab.dataset.viewTab as TaskView
      if (view && VALID_VIEWS.includes(view)) {
        switchView(view)
      }
    }, signal ? { signal } : undefined)
  })

  // [T6] Keyboard shortcuts: 1-4 to switch views when no input is focused
  const viewKeyMap: Record<string, TaskView> = {
    "1": "kanban",
    "2": "table",
    "3": "calendar",
    "4": "timeline",
  }

  window.addEventListener("keydown", (e) => {
    // Skip if user is typing in an input, textarea, select, or contenteditable
    const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
    const isEditable = (e.target as HTMLElement)?.isContentEditable
    if (tag === "input" || tag === "textarea" || tag === "select" || isEditable) return

    // Skip if any modifier keys are held (Ctrl, Alt, Meta, Shift)
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return

    const view = viewKeyMap[e.key]
    if (view) {
      e.preventDefault()
      switchView(view)
    }
  }, signal ? { signal } : undefined)

  // Listen for "View Details" from popup/chart clicks — open detail panel (not page nav)
  window.addEventListener("meitheal:open-task", ((e: CustomEvent) => {
    const taskId = e.detail?.taskId
    if (taskId) {
      import("@lib/task-detail-handoff").then(({ openTaskDetailHandoff }) => {
        openTaskDetailHandoff(taskId)
      })
    }
  }) as EventListener, signal ? { signal } : undefined)
}
