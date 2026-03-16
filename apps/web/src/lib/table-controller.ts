/**
 * Table Controller — Client-side logic for the table/list view
 *
 * Handles:
 * - Row grouping (swimlanes) with collapse/expand
 * - Unified filtering (search, status, priority, RICE, user, type, board, labels)
 * - Subtask tree expand/collapse (mutually exclusive with grouping)
 * - Inline editing (title, status, priority)
 * - Bulk actions (status, priority, board, delete)
 * - Column sorting (within groups when grouped)
 * - Table scroll shadow detection
 * - Board selector population from /api/boards
 *
 * @domain tasks
 * @bounded-context tasks (view-layer controller)
 */

import { showToast } from "@lib/toast"
import { confirmDialog } from "@lib/confirm-dialog"
import { onTaskCompleted } from "@lib/gamification-hook"
import { pageLifecycle } from "@lib/page-lifecycle"
import {
  saveFilterState,
  loadFilterState,
  clearFilterState,
  isTaskVisible,
  getGroupKey,
  getGroupDisplay,
  DEFAULT_SORT,
  type FilterState,
} from "@lib/filter-state"

// =============================================================================
// Types
// =============================================================================

interface BoardInfo {
  id: string
  title: string
  icon?: string
  color?: string
}

// =============================================================================
// State
// =============================================================================

let currentGroupBy = "none"
let currentSubGroupBy = "none"
let boardMap: Record<string, BoardInfo> = {}
let currentFilterState: Partial<FilterState> = {}
const __signal = pageLifecycle.signal

// =============================================================================
// Initialization
// =============================================================================

function init() {
  const table = document.getElementById("task-table") as HTMLTableElement | null
  if (!table) return

  // Load persisted filter state
  currentFilterState = loadFilterState()
  currentGroupBy = currentFilterState.groupBy ?? "none"
  currentSubGroupBy = currentFilterState.subGroupBy ?? "none"

  // Table-specific features
  setupSubtaskToggles()
  setupInlineEditing()
  setupRowClicks()
  setupBulkActions()
  setupSortableHeaders()
  setupTableOverflow()
  loadBoards() // Still needed for grouping header labels + bulk board selector

  // Listen for unified filter events from FilterToolbar
  document.addEventListener("meitheal:filter-change", ((e: CustomEvent) => {
    const detail = e.detail ?? {}
    if (detail.view && detail.view !== "table") return // Ignore kanban events

    // Update controller state from FilterToolbar event
    currentFilterState = {
      ...currentFilterState,
      search: detail.search ?? "",
      status: detail.status ?? "",
      priority: detail.priority ?? "",
      rice: detail.rice ?? "",
      user: detail.user ?? "",
      board: detail.board ?? "",
      types: detail.types ?? [],
    }

    // Handle groupBy + subGroupBy changes
    const newGroupBy = detail.groupBy ?? "none"
    const newSubGroupBy = detail.subGroupBy ?? "none"
    const groupChanged = newGroupBy !== currentGroupBy || newSubGroupBy !== currentSubGroupBy
    if (groupChanged) {
      currentGroupBy = newGroupBy
      currentSubGroupBy = newSubGroupBy
      currentFilterState.groupBy = currentGroupBy
      currentFilterState.subGroupBy = currentSubGroupBy
      applyGrouping(currentGroupBy, currentSubGroupBy)
    }

    saveFilterState(currentFilterState)
    applyAllFilters()
  }) as EventListener, { signal: __signal })

  // Listen for label filter events (from LabelFilterBar inside FilterToolbar)
  document.addEventListener("meitheal:label-filter", ((e: CustomEvent) => {
    currentFilterState.labels = e.detail?.labels ?? []
    saveFilterState(currentFilterState)
    applyAllFilters()
  }) as EventListener, { signal: __signal })

  // Apply grouping first (creates group headers before filtering)
  if (currentGroupBy !== "none") {
    applyGrouping(currentGroupBy, currentSubGroupBy)
  }

  // Apply initial filters — with stale-state protection
  applyAllFilters()

  // Stale filter protection: if ALL tasks are filtered out but tasks exist,
  // the restored state is stale — clear it and show everything
  const totalRows = document.querySelectorAll(".table-row").length
  const visibleRows = document.querySelectorAll(".table-row:not(.filtered-out)").length
  if (totalRows > 0 && visibleRows === 0) {
    clearFilterState()
    currentFilterState = {}
    currentGroupBy = "none"
    // Reset group-by select
    const groupBySelect = document.getElementById("table-group-by") as HTMLSelectElement | null
    if (groupBySelect) groupBySelect.value = "none"
    // Remove group headers
    applyGrouping("none")
    // Reset type toggles
    document.querySelectorAll<HTMLButtonElement>(".filter-toolbar__type-btn").forEach((btn) => {
      btn.classList.add("active")
      btn.setAttribute("aria-pressed", "true")
    })
    applyAllFilters()
  }
}

// =============================================================================
// Board Data Loading
// =============================================================================

async function loadBoards() {
  try {
    const res = await fetch("/api/boards", { signal: __signal })
    if (!res.ok) return
    const data = await res.json()
    const boards: BoardInfo[] = data.boards || []

    boards.forEach((b) => {
      boardMap[b.id] = b
    })

    // NOTE: Board filter <select> is populated by FilterToolbar's client script
    // We only populate the bulk board selector and update group headers here

    // Populate bulk board selector
    const bulkBoard = document.getElementById("bulk-board") as HTMLSelectElement | null
    if (bulkBoard) {
      boards.forEach((b) => {
        const opt = document.createElement("option")
        opt.value = b.id
        opt.textContent = `${b.icon ?? "📋"} ${b.title}`
        bulkBoard.appendChild(opt)
      })
    }

    // Update group headers with board names if grouped by board
    if (currentGroupBy === "board") {
      updateGroupHeaderLabels()
    }

    // Populate user filter from data attributes on rows
    populateUserFilter()
  } catch {
    /* offline fallback — board filter stays as-is */
  }
}

function populateUserFilter() {
  const userFilter = document.getElementById("table-filter-user") as HTMLSelectElement | null
  if (!userFilter) return

  const rows = document.querySelectorAll<HTMLElement>(".table-row")
  const userSet = new Set<string>()
  rows.forEach((row) => {
    const assigned = row.dataset.assigned
    if (assigned) userSet.add(assigned)
  })

  Array.from(userSet)
    .sort()
    .forEach((user) => {
      // Avoid duplicates
      if (userFilter.querySelector(`option[value="${user}"]`)) return
      const opt = document.createElement("option")
      opt.value = user
      opt.textContent = user.replace(/^(ha_|custom_)/, "")
      userFilter.appendChild(opt)
    })

  // Restore saved user filter
  if (currentFilterState.user) {
    userFilter.value = currentFilterState.user
  }
}

// =============================================================================
// Filter State Restore
// =============================================================================

function restoreFilterControls() {
  const s = currentFilterState
  const setVal = (id: string, val: string | undefined) => {
    const el = document.getElementById(id) as HTMLSelectElement | HTMLInputElement | null
    if (el && val) el.value = val
  }

  setVal("table-search", s.search)
  setVal("table-filter-status", s.status)
  setVal("table-filter-priority", s.priority)
  setVal("table-filter-rice", s.rice)
  setVal("table-filter-user", s.user)
  setVal("table-filter-board", s.board)
  setVal("table-group-by", s.groupBy ?? "none")

  // Restore type toggles
  if (s.types && s.types.length > 0) {
    document.querySelectorAll<HTMLButtonElement>(".type-toggle").forEach((btn) => {
      const type = btn.dataset.type ?? ""
      const isActive = s.types!.includes(type)
      btn.classList.toggle("active", isActive)
      btn.setAttribute("aria-pressed", String(isActive))
    })
  }
}

// =============================================================================
// Filter Listeners
// =============================================================================

function setupFilterListeners() {
  const search = document.getElementById("table-search") as HTMLInputElement | null
  const statusFilter = document.getElementById("table-filter-status") as HTMLSelectElement | null
  const priorityFilter = document.getElementById("table-filter-priority") as HTMLSelectElement | null
  const riceFilter = document.getElementById("table-filter-rice") as HTMLSelectElement | null
  const userFilter = document.getElementById("table-filter-user") as HTMLSelectElement | null
  const boardFilter = document.getElementById("table-filter-board") as HTMLSelectElement | null
  const clearBtn = document.getElementById("clear-filters")

  const onFilterChange = () => {
    currentFilterState = {
      ...currentFilterState,
      search: search?.value ?? "",
      status: statusFilter?.value ?? "",
      priority: priorityFilter?.value ?? "",
      rice: riceFilter?.value ?? "",
      user: userFilter?.value ?? "",
      board: boardFilter?.value ?? "",
    }
    saveFilterState(currentFilterState)
    applyAllFilters()
  }

  search?.addEventListener("input", debounce(onFilterChange, 150))
  statusFilter?.addEventListener("change", onFilterChange)
  priorityFilter?.addEventListener("change", onFilterChange)
  riceFilter?.addEventListener("change", onFilterChange)
  userFilter?.addEventListener("change", onFilterChange)
  boardFilter?.addEventListener("change", onFilterChange)

  clearBtn?.addEventListener("click", () => {
    clearFilterState()
    currentFilterState = {}
    if (search) search.value = ""
    if (statusFilter) statusFilter.value = ""
    if (priorityFilter) priorityFilter.value = ""
    if (riceFilter) riceFilter.value = ""
    if (userFilter) userFilter.value = ""
    if (boardFilter) boardFilter.value = ""

    // Reset type toggles to all active
    document.querySelectorAll<HTMLButtonElement>(".type-toggle").forEach((btn) => {
      btn.classList.add("active")
      btn.setAttribute("aria-pressed", "true")
    })

    applyAllFilters()
  })

  // Listen for label filter changes
  document.addEventListener("meitheal:label-filter", ((e: CustomEvent) => {
    currentFilterState.labels = e.detail?.labels ?? []
    saveFilterState(currentFilterState)
    applyAllFilters()
  }) as EventListener)
}

// =============================================================================
// Type Toggle Listeners
// =============================================================================

function setupTypeToggleListeners() {
  document.querySelectorAll<HTMLButtonElement>(".type-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("active")
      const isActive = btn.classList.contains("active")
      btn.setAttribute("aria-pressed", String(isActive))

      // Collect active types
      const activeTypes: string[] = []
      document.querySelectorAll<HTMLButtonElement>(".type-toggle.active").forEach((b) => {
        if (b.dataset.type) activeTypes.push(b.dataset.type)
      })

      // If all are active, store empty array (meaning "all")
      const allTypes = document.querySelectorAll<HTMLButtonElement>(".type-toggle")
      currentFilterState.types = activeTypes.length === allTypes.length ? [] : activeTypes
      saveFilterState(currentFilterState)
      applyAllFilters()
    })
  })
}

// =============================================================================
// Group-By Listener
// =============================================================================

function setupGroupByListener() {
  const groupBySelect = document.getElementById("table-group-by") as HTMLSelectElement | null
  groupBySelect?.addEventListener("change", () => {
    currentGroupBy = groupBySelect.value
    currentFilterState.groupBy = currentGroupBy
    saveFilterState(currentFilterState)
    applyGrouping(currentGroupBy)
    applyAllFilters()
  })
}

// =============================================================================
// Unified Filter Application
// =============================================================================

function applyAllFilters() {
  const rows = document.querySelectorAll<HTMLElement>(".table-row")
  let visibleCount = 0

  rows.forEach((row) => {
    const visible = isTaskVisible(row, currentFilterState)
    row.classList.toggle("filtered-out", !visible)
    if (visible) visibleCount++
  })

  // Update group counts and summary rows
  updateGroupCounts()
  renderSummaryRows()

  // Show/hide no-results row
  const noResults = document.querySelector<HTMLElement>(".no-results-row")
  if (noResults) {
    noResults.style.display = visibleCount === 0 ? "" : "none"
  }
}

// =============================================================================
// Row Grouping Engine
// =============================================================================

function applyGrouping(groupBy: string, subGroupBy = "none") {
  const tbody = document.querySelector<HTMLElement>("#task-table tbody")
  if (!tbody) return

  // Remove existing group headers
  tbody.querySelectorAll(".group-header-row").forEach((el) => el.remove())

  if (groupBy === "none") {
    // Remove all group data attributes
    tbody.querySelectorAll<HTMLElement>(".table-row").forEach((row) => {
      row.removeAttribute("data-group-value")
      row.classList.remove("group-collapsed-row")
    })
    // Re-enable subtask tree
    enableSubtaskTree()
    return
  }

  // Disable subtask tree when grouping is active
  disableSubtaskTree()

  // Collect rows and compute groups
  const rows = Array.from(tbody.querySelectorAll<HTMLElement>(".table-row"))
  const groups = new Map<string, HTMLElement[]>()
  const groupOrder: string[] = []

  rows.forEach((row) => {
    const key = getGroupKey(row, groupBy)
    row.setAttribute("data-group-value", key)
    if (!groups.has(key)) {
      groups.set(key, [])
      groupOrder.push(key)
    }
    groups.get(key)!.push(row)
  })

  // Sort groups by a natural order
  groupOrder.sort((a, b) => {
    if (groupBy === "priority") return Number(a) - Number(b)
    if (groupBy === "rice") {
      const order = { high: 0, medium: 1, low: 2, none: 3 }
      return (order[a as keyof typeof order] ?? 99) - (order[b as keyof typeof order] ?? 99)
    }
    if (groupBy === "status") {
      const order = { backlog: 0, pending: 1, active: 2, complete: 3 }
      return (order[a as keyof typeof order] ?? 99) - (order[b as keyof typeof order] ?? 99)
    }
    if (groupBy === "type") {
      const order = { epic: 0, story: 1, task: 2 }
      return (order[a as keyof typeof order] ?? 99) - (order[b as keyof typeof order] ?? 99)
    }
    return a.localeCompare(b)
  })

  // Build grouped DOM using DocumentFragment for performance
  const fragment = document.createDocumentFragment()
  const colCount = document.querySelectorAll("#task-table thead th").length

  // Load collapse states from sessionStorage
  const collapseKey = `meitheal-table-groups-${groupBy}`
  let collapsedGroups: string[] = []
  try {
    collapsedGroups = JSON.parse(sessionStorage.getItem(collapseKey) ?? "[]")
  } catch { /* ignore */ }

  for (const key of groupOrder) {
    const groupRows = groups.get(key) ?? []
    const display = getGroupDisplayForKey(groupBy, key)
    const isCollapsed = collapsedGroups.includes(key)

    // Create group header row
    const headerRow = document.createElement("tr")
    headerRow.className = `group-header-row${isCollapsed ? " collapsed" : ""}`
    headerRow.setAttribute("data-group-key", key)
    headerRow.setAttribute("data-group-by", groupBy)
    headerRow.setAttribute("role", "rowgroup")
    headerRow.setAttribute("aria-expanded", String(!isCollapsed))

    const td = document.createElement("td")
    td.setAttribute("colspan", String(colCount))
    td.className = "group-header-cell"
    td.innerHTML = `
      <button type="button" class="group-toggle" aria-label="Toggle group ${display.label}">
        <span class="group-toggle-arrow">▾</span>
      </button>
      <span class="group-dot" style="background: ${display.color}"></span>
      <span class="group-icon">${display.icon}</span>
      <span class="group-label">${display.label}</span>
      <span class="group-count">${groupRows.length}</span>
      <span class="group-checkbox-wrapper">
        <input type="checkbox" class="group-select-all" data-group-key="${key}" aria-label="Select all in ${display.label}" />
      </span>
    `
    headerRow.appendChild(td)
    fragment.appendChild(headerRow)

    if (subGroupBy !== "none" && subGroupBy !== groupBy) {
      // --- Sub-grouping: nest a second dimension within this primary group ---
      const subGroups = new Map<string, HTMLElement[]>()
      const subOrder: string[] = []
      groupRows.forEach((row) => {
        const sk = getGroupKey(row, subGroupBy)
        row.setAttribute("data-sub-group-value", sk)
        if (!subGroups.has(sk)) { subGroups.set(sk, []); subOrder.push(sk) }
        subGroups.get(sk)!.push(row)
      })

      const subCollapseKey = `meitheal-table-subgroups-${groupBy}-${subGroupBy}-${key}`
      let collapsedSubs: string[] = []
      try { collapsedSubs = JSON.parse(sessionStorage.getItem(subCollapseKey) ?? "[]") } catch { /* */ }

      for (const sk of subOrder) {
        const subRows = subGroups.get(sk) ?? []
        const subDisplay = getGroupDisplayForKey(subGroupBy, sk)
        const subIsCollapsed = isCollapsed || collapsedSubs.includes(sk)

        const subHeaderRow = document.createElement("tr")
        subHeaderRow.className = `group-header-row sub-group-header-row${subIsCollapsed ? " collapsed" : ""}`
        subHeaderRow.setAttribute("data-group-key", sk)
        subHeaderRow.setAttribute("data-group-by", subGroupBy)
        subHeaderRow.setAttribute("data-parent-group-key", key)
        subHeaderRow.setAttribute("data-sub-group-collapse-key", subCollapseKey)
        subHeaderRow.setAttribute("role", "rowgroup")
        subHeaderRow.setAttribute("aria-expanded", String(!subIsCollapsed))
        if (isCollapsed) subHeaderRow.classList.add("group-collapsed-row")

        const subTd = document.createElement("td")
        subTd.setAttribute("colspan", String(colCount))
        subTd.className = "group-header-cell sub-group-header-cell"
        subTd.innerHTML = `
          <button type="button" class="group-toggle sub-group-toggle" aria-label="Toggle sub-group ${subDisplay.label}">
            <span class="group-toggle-arrow">▾</span>
          </button>
          <span class="group-dot" style="background: ${subDisplay.color}"></span>
          <span class="group-label">${subDisplay.label}</span>
          <span class="group-count">${subRows.length}</span>
        `
        subHeaderRow.appendChild(subTd)
        fragment.appendChild(subHeaderRow)

        subRows.forEach((row) => {
          row.classList.toggle("group-collapsed-row", subIsCollapsed)
          fragment.appendChild(row)
        })
      }
    } else {
      // --- No sub-grouping: add rows directly ---
      groupRows.forEach((row) => {
        row.classList.toggle("group-collapsed-row", isCollapsed)
        fragment.appendChild(row)
      })
    }
  }

  // Preserve no-results row
  const noResults = tbody.querySelector(".no-results-row")
  tbody.innerHTML = ""
  tbody.appendChild(fragment)
  if (noResults) tbody.appendChild(noResults)

  // Set up group header click handlers
  setupGroupHeaderListeners()
}

function getGroupDisplayForKey(groupBy: string, key: string): { label: string, icon: string, color: string } {
  if (groupBy === "board" && boardMap[key]) {
    const b = boardMap[key]
    return { label: b.title, icon: b.icon ?? "📋", color: (b.color ?? getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()) || "#6366F1" }
  }
  return getGroupDisplay(groupBy, key)
}

function setupGroupHeaderListeners() {
  const tbody = document.querySelector("#task-table tbody")
  if (!tbody || (tbody as HTMLElement).dataset.groupListenerBound) return
  ;(tbody as HTMLElement).dataset.groupListenerBound = "true"

  // Event delegation on tbody — handles all current and future group headers
  tbody.addEventListener("click", (e) => {
    const target = e.target as HTMLElement

    // Skip if clicking on checkbox area
    if (target.closest(".group-checkbox-wrapper")) return

    // Check if click is within a group header cell
    const headerCell = target.closest(".group-header-cell")
    if (!headerCell) return

    const header = headerCell.closest<HTMLElement>(".group-header-row")
    if (!header) return

    e.stopPropagation()

    const isSubGroup = header.classList.contains("sub-group-header-row")
    const groupKey = header.dataset.groupKey ?? ""
    const groupBy = header.dataset.groupBy ?? currentGroupBy
    const isCollapsed = header.classList.toggle("collapsed")
    header.setAttribute("aria-expanded", String(!isCollapsed))

    if (isSubGroup) {
      // Sub-group: collapse rows until next sub-group or primary group header
      const subCollapseKey = header.dataset.subGroupCollapseKey ?? `meitheal-table-subgroups-${groupBy}-${groupKey}`
      let sibling = header.nextElementSibling
      while (sibling && !sibling.classList.contains("group-header-row") && !sibling.classList.contains("no-results-row")) {
        ;(sibling as HTMLElement).classList.toggle("group-collapsed-row", isCollapsed)
        sibling = sibling.nextElementSibling
      }
      try {
        let collapsed: string[] = JSON.parse(sessionStorage.getItem(subCollapseKey) ?? "[]")
        if (isCollapsed) { if (!collapsed.includes(groupKey)) collapsed.push(groupKey) }
        else { collapsed = collapsed.filter((k) => k !== groupKey) }
        sessionStorage.setItem(subCollapseKey, JSON.stringify(collapsed))
      } catch { /* ignore */ }
    } else {
      // Primary group: collapse all siblings (rows + sub-group headers) until next primary group
      const collapseKey = `meitheal-table-groups-${groupBy}`
      let sibling = header.nextElementSibling
      while (sibling && !sibling.classList.contains("group-header-row") || (sibling?.classList.contains("sub-group-header-row") ?? false)) {
        if (sibling && (!sibling.classList.contains("group-header-row") || sibling.classList.contains("sub-group-header-row"))) {
          ;(sibling as HTMLElement).classList.toggle("group-collapsed-row", isCollapsed)
        }
        if (!sibling || (sibling.classList.contains("group-header-row") && !sibling.classList.contains("sub-group-header-row"))) break
        sibling = sibling.nextElementSibling
      }
      try {
        let collapsed: string[] = JSON.parse(sessionStorage.getItem(collapseKey) ?? "[]")
        if (isCollapsed) { if (!collapsed.includes(groupKey)) collapsed.push(groupKey) }
        else { collapsed = collapsed.filter((k) => k !== groupKey) }
        sessionStorage.setItem(collapseKey, JSON.stringify(collapsed))
      } catch { /* ignore */ }
    }
  })

  // Group select-all checkbox delegation
  tbody.addEventListener("change", (e) => {
    const target = e.target as HTMLElement
    if (!target.classList.contains("group-select-all")) return

    const header = target.closest<HTMLElement>(".group-header-row")
    if (!header) return

    const checked = (target as HTMLInputElement).checked
    let sibling = header.nextElementSibling
    while (sibling && !sibling.classList.contains("group-header-row") && !sibling.classList.contains("no-results-row")) {
      const checkbox = (sibling as HTMLElement).querySelector<HTMLInputElement>(".row-check")
      if (checkbox && !(sibling as HTMLElement).classList.contains("filtered-out")) {
        checkbox.checked = checked
      }
      sibling = sibling.nextElementSibling
    }
    updateBulkBar()
  })
}

function updateGroupCounts() {
  document.querySelectorAll<HTMLElement>(".group-header-row").forEach((header) => {
    const groupKey = header.dataset.groupKey ?? ""
    const countEl = header.querySelector<HTMLElement>(".group-count")
    if (!countEl) return

    // Count visible rows in this group
    let count = 0
    let sibling = header.nextElementSibling
    while (sibling && !sibling.classList.contains("group-header-row") && !sibling.classList.contains("no-results-row")) {
      if (!(sibling as HTMLElement).classList.contains("filtered-out")) {
        count++
      }
      sibling = sibling.nextElementSibling
    }
    countEl.textContent = String(count)

    // Auto-hide empty groups
    if (count === 0) {
      header.classList.add("group-empty")
    } else {
      header.classList.remove("group-empty")
    }
  })
}

/**
 * Render per-group summary rows (task count + avg RICE)
 * and a grand total row at the bottom.
 */
function renderSummaryRows() {
  const tbody = document.querySelector<HTMLElement>("#task-table tbody")
  if (!tbody) return

  // Remove existing summary/total rows
  tbody.querySelectorAll(".group-summary-row, .grand-total-row").forEach(el => el.remove())

  // Only render when grouping is active
  if (currentGroupBy === "none") return

  const colCount = document.querySelectorAll("#task-table thead th").length
  const headers = tbody.querySelectorAll<HTMLElement>(".group-header-row:not(.sub-group-header-row)")

  let grandTotalTasks = 0
  let grandTotalRice = 0
  let grandTotalRiceCount = 0

  headers.forEach((header) => {
    if (header.classList.contains("group-empty")) return

    let taskCount = 0
    let riceSum = 0
    let riceEntries = 0
    let lastRow: Element | null = null

    let sibling = header.nextElementSibling
    while (sibling && (!sibling.classList.contains("group-header-row") || sibling.classList.contains("sub-group-header-row"))) {
      if (sibling.classList.contains("table-row") && !sibling.classList.contains("filtered-out")) {
        taskCount++
        const riceVal = Number((sibling as HTMLElement).dataset.rice ?? "")
        if (!isNaN(riceVal) && (sibling as HTMLElement).dataset.rice !== "") {
          riceSum += riceVal
          riceEntries++
        }
      }
      lastRow = sibling
      sibling = sibling.nextElementSibling
    }

    grandTotalTasks += taskCount
    grandTotalRice += riceSum
    grandTotalRiceCount += riceEntries

    if (taskCount === 0) return

    const summaryRow = document.createElement("tr")
    summaryRow.className = "group-summary-row"
    const td = document.createElement("td")
    td.setAttribute("colspan", String(colCount))
    td.className = "group-summary-cell"

    const avgRice = riceEntries > 0 ? (riceSum / riceEntries).toFixed(1) : "\u2014"
    td.innerHTML = `
      <span class="summary-label">${taskCount} task${taskCount !== 1 ? "s" : ""}</span>
      <span class="summary-separator">\u00b7</span>
      <span class="summary-rice">Avg RICE: ${avgRice}</span>
    `
    summaryRow.appendChild(td)

    if (lastRow && lastRow.nextElementSibling) {
      tbody.insertBefore(summaryRow, lastRow.nextElementSibling)
    } else if (lastRow) {
      tbody.appendChild(summaryRow)
    }
  })

  // Grand total row
  if (grandTotalTasks > 0) {
    const totalRow = document.createElement("tr")
    totalRow.className = "grand-total-row"
    const td = document.createElement("td")
    td.setAttribute("colspan", String(colCount))
    td.className = "grand-total-cell"

    const avgRice = grandTotalRiceCount > 0 ? (grandTotalRice / grandTotalRiceCount).toFixed(1) : "\u2014"
    td.innerHTML = `
      <span class="summary-label">Total: ${grandTotalTasks} task${grandTotalTasks !== 1 ? "s" : ""}</span>
      <span class="summary-separator">\u00b7</span>
      <span class="summary-rice">Avg RICE: ${avgRice}</span>
    `
    totalRow.appendChild(td)
    tbody.appendChild(totalRow)
  }
}

function updateGroupHeaderLabels() {
  // Called after boards load — updates board group header labels
  document.querySelectorAll<HTMLElement>(".group-header-row[data-group-by='board']").forEach((header) => {
    const key = header.dataset.groupKey ?? ""
    if (boardMap[key]) {
      const label = header.querySelector<HTMLElement>(".group-label")
      const icon = header.querySelector<HTMLElement>(".group-icon")
      const dot = header.querySelector<HTMLElement>(".group-dot")
      if (label) label.textContent = boardMap[key].title
      if (icon) icon.textContent = boardMap[key].icon ?? "📋"
      if (dot) dot.style.background = (boardMap[key].color ?? getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()) || "#6366F1"
    }
  })
}

// =============================================================================
// Subtask Tree (mutually exclusive with grouping)
// =============================================================================

function setupSubtaskToggles() {
  document.querySelectorAll<HTMLButtonElement>(".subtree-toggle").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation()
      const parentId = btn.dataset.parentId
      if (!parentId) return

      const isCollapsed = btn.textContent?.trim() === "▸"
      btn.textContent = isCollapsed ? "▾" : "▸"
      btn.setAttribute("aria-expanded", String(isCollapsed))

      toggleChildRows(parentId, isCollapsed)
    })
  })
}

function toggleChildRows(parentId: string, show: boolean) {
  const childRows = document.querySelectorAll<HTMLElement>(
    `.table-row[data-parent-id="${parentId}"]`
  )
  childRows.forEach((row) => {
    row.style.display = show ? "" : "none"
    // Recursively toggle grandchildren if this child has children
    if (row.dataset.hasChildren === "true" && !show) {
      const toggle = row.querySelector<HTMLButtonElement>(".subtree-toggle")
      if (toggle) {
        toggle.textContent = "▸"
        toggle.setAttribute("aria-expanded", "false")
      }
      toggleChildRows(row.dataset.id ?? "", false)
    }
  })
}

function disableSubtaskTree() {
  // When grouping is active, flatten the tree
  document.querySelectorAll<HTMLElement>(".subtree-toggle").forEach((btn) => {
    btn.style.display = "none"
  })
  document.querySelectorAll<HTMLElement>(".subtree-indent-marker").forEach((m) => {
    m.style.display = "none"
  })
  // Remove subtask indentation
  document.querySelectorAll<HTMLElement>(".task-title-cell").forEach((cell) => {
    cell.style.paddingLeft = ""
  })
  document.querySelectorAll<HTMLElement>(".cell-description").forEach((cell) => {
    cell.style.marginLeft = ""
  })
  // Show all rows (un-collapse subtrees)
  document.querySelectorAll<HTMLElement>(".table-row").forEach((row) => {
    if (row.style.display === "none" && row.dataset.parentId) {
      row.style.display = ""
    }
  })
}

function enableSubtaskTree() {
  // Restore subtask tree when grouping is "none"
  document.querySelectorAll<HTMLElement>(".subtree-toggle").forEach((btn) => {
    btn.style.display = ""
  })
  document.querySelectorAll<HTMLElement>(".subtree-indent-marker").forEach((m) => {
    m.style.display = ""
  })
  // Restore subtask indentation
  document.querySelectorAll<HTMLElement>(".table-row").forEach((row) => {
    const depth = Number(row.dataset.depth ?? 0)
    if (depth > 0) {
      const titleCell = row.querySelector<HTMLElement>(".task-title-cell")
      const descCell = row.querySelector<HTMLElement>(".cell-description")
      if (titleCell) titleCell.style.paddingLeft = `${depth * 20}px`
      if (descCell) descCell.style.marginLeft = `${depth * 20}px`
    }
  })
}

// =============================================================================
// Inline Editing
// =============================================================================

function setupInlineEditing() {
  // Inline title editing
  document.querySelectorAll<HTMLElement>(".editable-cell").forEach((cell) => {
    cell.addEventListener("blur", async () => {
      const newVal = cell.textContent?.trim() ?? ""
      const original = cell.dataset.original ?? ""
      if (newVal === original || !newVal) {
        cell.textContent = original
        return
      }
      const id = cell.dataset.id
      if (!id) return

      try {
        const res = await fetch(`/api/tasks/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: newVal }),
          signal: __signal,
        })
        if (res.ok) {
          cell.dataset.original = newVal
          showToast("Title updated", "success")
        } else {
          cell.textContent = original
          showToast("Failed to update", "error")
        }
      } catch {
        cell.textContent = original
        showToast("Network error", "error")
      }
    })

    cell.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault()
        cell.blur()
      }
      if (e.key === "Escape") {
        cell.textContent = cell.dataset.original ?? ""
        cell.blur()
      }
    })

    // Stop click from opening task detail
    cell.addEventListener("click", (e) => e.stopPropagation())
  })

  // Inline select changes (status, priority)
  document.querySelectorAll<HTMLSelectElement>(".inline-select").forEach((sel) => {
    sel.addEventListener("click", (e) => e.stopPropagation())
    sel.addEventListener("change", async () => {
      const id = sel.dataset.id
      const field = sel.dataset.field
      if (!id || !field) return

      try {
        const res = await fetch(`/api/tasks/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [field]: field === "priority" ? Number(sel.value) : sel.value }),
          signal: __signal,
        })
        if (res.ok) {
          showToast(`${field} updated`, "success")
          // Update row data attribute
          const row = sel.closest<HTMLElement>(".table-row")
          if (row && field === "status") {
            row.dataset.status = sel.value
            row.classList.toggle("row-done", sel.value === "complete")
            // Gamification + confetti on completion
            if (sel.value === "complete") {
              const priority = Number(row?.dataset.priority ?? 3)
              onTaskCompleted(priority)
            }
          }
          if (row && field === "priority") {
            row.dataset.priority = sel.value
          }
          // Re-apply filters (status/priority change may affect visibility)
          applyAllFilters()
        } else {
          showToast("Failed to update", "error")
        }
      } catch {
        showToast("Network error", "error")
      }
    })
  })
}

// =============================================================================
// Row Click to Open Detail
// =============================================================================

function setupRowClicks() {
  document.querySelectorAll<HTMLElement>(".table-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      const target = e.target as HTMLElement
      // Skip if clicking interactive elements
      if (
        target.closest("button") ||
        target.closest("select") ||
        target.closest("input") ||
        target.closest(".editable-cell") ||
        target.closest("a")
      ) return

      const id = row.dataset.id
      if (id) {
        document.dispatchEvent(
          new CustomEvent("meitheal:open-task", { detail: { taskId: id } })
        )
      }
    })
  })
}

// =============================================================================
// Bulk Actions
// =============================================================================

function setupBulkActions() {
  const bulkBar = document.getElementById("bulk-bar")
  const selectAll = document.getElementById("select-all") as HTMLInputElement | null
  const selectedCountEl = document.getElementById("selected-count")
  const bulkStatus = document.getElementById("bulk-status") as HTMLSelectElement | null
  const bulkPriority = document.getElementById("bulk-priority") as HTMLSelectElement | null
  const bulkBoard = document.getElementById("bulk-board") as HTMLSelectElement | null
  const bulkDelete = document.getElementById("bulk-delete")
  const bulkClose = document.getElementById("bulk-close")

  // Row checkboxes
  document.querySelectorAll<HTMLInputElement>(".row-check").forEach((cb) => {
    cb.addEventListener("click", (e) => e.stopPropagation())
    cb.addEventListener("change", updateBulkBar)
  })

  // Select all
  selectAll?.addEventListener("change", () => {
    const checked = selectAll.checked
    document.querySelectorAll<HTMLInputElement>(".row-check").forEach((cb) => {
      const row = cb.closest<HTMLElement>(".table-row")
      if (row && !row.classList.contains("filtered-out")) {
        cb.checked = checked
      }
    })
    updateBulkBar()
  })

  // Bulk status change
  bulkStatus?.addEventListener("change", async () => {
    const val = bulkStatus.value
    if (!val) return
    const ids = getSelectedIds()
    if (ids.length === 0) return

    await bulkUpdateField("status", val, ids)
    bulkStatus.value = ""
  })

  // Bulk priority change
  bulkPriority?.addEventListener("change", async () => {
    const val = bulkPriority.value
    if (!val) return
    const ids = getSelectedIds()
    if (ids.length === 0) return

    await bulkUpdateField("priority", Number(val), ids)
    bulkPriority.value = ""
  })

  // Bulk board change
  bulkBoard?.addEventListener("change", async () => {
    const val = bulkBoard.value
    if (!val) return
    const ids = getSelectedIds()
    if (ids.length === 0) return

    await bulkUpdateField("board_id", val, ids)
    bulkBoard.value = ""
  })

  // Bulk delete
  bulkDelete?.addEventListener("click", async () => {
    const ids = getSelectedIds()
    if (ids.length === 0) return

    const confirmed = await confirmDialog({
      title: `Delete ${ids.length} task${ids.length > 1 ? "s" : ""}?`,
      message: "This action cannot be undone.",
      confirmText: "Delete",
      variant: "danger",
    })
    if (!confirmed) return

    let deleted = 0
    for (const id of ids) {
      try {
        const res = await fetch(`/api/tasks/${id}`, { method: "DELETE", signal: __signal })
        if (res.ok) {
          const row = document.querySelector<HTMLElement>(`.table-row[data-id="${id}"]`)
          row?.remove()
          deleted++
        }
      } catch { /* continue */ }
    }

    showToast(`Deleted ${deleted} task${deleted > 1 ? "s" : ""}`, "success")
    updateBulkBar()
    updateGroupCounts()
  })

  // Bulk close button
  bulkClose?.addEventListener("click", () => {
    document.querySelectorAll<HTMLInputElement>(".row-check").forEach((cb) => {
      cb.checked = false
    })
    if (selectAll) selectAll.checked = false
    updateBulkBar()
  })
}

function getSelectedIds(): string[] {
  const ids: string[] = []
  document.querySelectorAll<HTMLInputElement>(".row-check:checked").forEach((cb) => {
    const id = cb.dataset.id
    if (id) ids.push(id)
  })
  return ids
}

async function bulkUpdateField(field: string, value: unknown, ids: string[]) {
  let updated = 0
  for (const id of ids) {
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
        signal: __signal,
      })
      if (res.ok) {
        updated++
        const row = document.querySelector<HTMLElement>(`.table-row[data-id="${id}"]`)
        if (row) {
          if (field === "status") {
            row.dataset.status = String(value)
            row.classList.toggle("row-done", value === "complete")
            // Gamification + confetti on completion
            if (value === "complete") {
              const priority = Number(row?.dataset.priority ?? 3)
              onTaskCompleted(priority)
            }
            // Update inline select
            const sel = row.querySelector<HTMLSelectElement>(`select[data-field="status"]`)
            if (sel) sel.value = String(value)
          }
          if (field === "priority") {
            row.dataset.priority = String(value)
            const sel = row.querySelector<HTMLSelectElement>(`select[data-field="priority"]`)
            if (sel) sel.value = String(value)
          }
          if (field === "board_id") {
            row.dataset.board = String(value)
          }
        }
      }
    } catch { /* continue */ }
  }

  showToast(`Updated ${updated} task${updated > 1 ? "s" : ""}`, "success")
  applyAllFilters()
}

function updateBulkBar() {
  const bulkBar = document.getElementById("bulk-bar")
  const selectedCountEl = document.getElementById("selected-count")
  const selected = getSelectedIds()

  if (bulkBar) {
    bulkBar.style.display = selected.length > 0 ? "flex" : "none"
  }
  if (selectedCountEl) {
    selectedCountEl.textContent = `${selected.length} selected`
  }
}

// =============================================================================
// Column Sorting
// =============================================================================

function setupSortableHeaders() {
  let currentSortCol = ""
  let currentSortDir: "asc" | "desc" = "asc"

  // Restore sort from filter state
  const savedSort = currentFilterState.sort ?? DEFAULT_SORT
  if (savedSort && savedSort !== DEFAULT_SORT) {
    const parts = savedSort.split("-")
    currentSortCol = parts[0] ?? ""
    currentSortDir = (parts[1] as "asc" | "desc") ?? "asc"

    // Mark the sorted header
    const header = document.querySelector<HTMLElement>(`th[data-col="${currentSortCol}"]`)
    if (header) {
      const indicator = header.querySelector<HTMLElement>(".sort-indicator")
      if (indicator) indicator.textContent = currentSortDir === "asc" ? "▲" : "▼"
    }
  }

  document.querySelectorAll<HTMLElement>("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.col ?? ""
      const isNumeric = th.dataset.numeric === "true"

      if (currentSortCol === col) {
        currentSortDir = currentSortDir === "asc" ? "desc" : "asc"
      } else {
        currentSortCol = col
        currentSortDir = "asc"
      }

      // Update indicators
      document.querySelectorAll<HTMLElement>(".sort-indicator").forEach((si) => {
        si.textContent = ""
      })
      const indicator = th.querySelector<HTMLElement>(".sort-indicator")
      if (indicator) indicator.textContent = currentSortDir === "asc" ? "▲" : "▼"

      // Save sort state
      currentFilterState.sort = `${col}-${currentSortDir}`
      saveFilterState(currentFilterState)

      // Sort rows (within groups if grouped, global if not)
      sortTableRows(col, currentSortDir, isNumeric)
    })
  })
}

function sortTableRows(col: string, dir: "asc" | "desc", isNumeric: boolean) {
  const tbody = document.querySelector<HTMLElement>("#task-table tbody")
  if (!tbody) return

  if (currentGroupBy !== "none") {
    // Sort within each group
    sortRowsWithinGroups(tbody, col, dir, isNumeric)
  } else {
    // Sort all rows globally
    sortRowsGlobally(tbody, col, dir, isNumeric)
  }
}

function sortRowsGlobally(tbody: HTMLElement, col: string, dir: "asc" | "desc", isNumeric: boolean) {
  const rows = Array.from(tbody.querySelectorAll<HTMLElement>(".table-row"))
  const noResults = tbody.querySelector<HTMLElement>(".no-results-row")

  // Only sort root rows (depth 0), children stay with their parents
  const rootRows = rows.filter((r) => Number(r.dataset.depth ?? 0) === 0)
  const childMap = new Map<string, HTMLElement[]>()

  // Build child map
  rows.forEach((row) => {
    const parentId = row.dataset.parentId
    if (parentId) {
      if (!childMap.has(parentId)) childMap.set(parentId, [])
      childMap.get(parentId)!.push(row)
    }
  })

  rootRows.sort((a, b) => {
    const aVal = getCellSortValue(a, col, isNumeric)
    const bVal = getCellSortValue(b, col, isNumeric)
    return compareSortValues(aVal, bVal, dir, isNumeric)
  })

  // Rebuild with children following parents
  const fragment = document.createDocumentFragment()
  function appendWithChildren(row: HTMLElement) {
    fragment.appendChild(row)
    const children = childMap.get(row.dataset.id ?? "") ?? []
    children.forEach((child) => appendWithChildren(child))
  }
  rootRows.forEach((row) => appendWithChildren(row))
  if (noResults) fragment.appendChild(noResults)

  tbody.innerHTML = ""
  tbody.appendChild(fragment)

  // Re-setup row event listeners
  setupRowClicks()
  setupInlineEditing()
}

function sortRowsWithinGroups(tbody: HTMLElement, col: string, dir: "asc" | "desc", isNumeric: boolean) {
  const headers = Array.from(tbody.querySelectorAll<HTMLElement>(".group-header-row"))
  const noResults = tbody.querySelector<HTMLElement>(".no-results-row")

  headers.forEach((header) => {
    const groupRows: HTMLElement[] = []
    let sibling = header.nextElementSibling
    while (sibling && !sibling.classList.contains("group-header-row") && !sibling.classList.contains("no-results-row")) {
      if (sibling.classList.contains("table-row")) {
        groupRows.push(sibling as HTMLElement)
      }
      sibling = sibling.nextElementSibling
    }

    if (groupRows.length <= 1) return

    groupRows.sort((a, b) => {
      const aVal = getCellSortValue(a, col, isNumeric)
      const bVal = getCellSortValue(b, col, isNumeric)
      return compareSortValues(aVal, bVal, dir, isNumeric)
    })

    // Re-insert sorted rows after header
    groupRows.forEach((row) => {
      header.parentElement?.insertBefore(row, sibling as Node)
    })
  })
}

function getCellSortValue(row: HTMLElement, col: string, isNumeric: boolean): string | number {
  switch (col) {
    case "title":
      return row.dataset.title ?? ""
    case "key": {
      const badge = row.querySelector<HTMLElement>(".ticket-key-badge")
      return badge?.textContent?.trim() ?? ""
    }
    case "type":
      return row.dataset.taskType ?? "task"
    case "status":
      return row.dataset.status ?? ""
    case "priority":
      return Number(row.dataset.priority ?? 3)
    case "due_date": {
      const cell = row.querySelector<HTMLElement>(".td-due")
      const text = cell?.textContent?.trim() ?? ""
      if (text === "—") return "zzz"
      return text
    }
    case "rice":
      return Number(row.dataset.rice ?? -1)
    default:
      return ""
  }
}

function compareSortValues(aVal: string | number, bVal: string | number, dir: "asc" | "desc", isNumeric: boolean): number {
  let cmp = 0
  if (isNumeric || typeof aVal === "number") {
    cmp = (Number(aVal) || 0) - (Number(bVal) || 0)
  } else {
    cmp = String(aVal).localeCompare(String(bVal))
  }
  return dir === "asc" ? cmp : -cmp
}

// =============================================================================
// Table Overflow Detection
// =============================================================================

function setupTableOverflow() {
  const container = document.querySelector<HTMLElement>(".table-container")
  if (!container) return

  function checkOverflow() {
    const hasScroll = container!.scrollWidth > container!.clientWidth
    container!.classList.toggle("has-scroll", hasScroll)
  }

  checkOverflow()
  window.addEventListener("resize", debounce(checkOverflow, 200))
}

// =============================================================================
// Utilities
// =============================================================================

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>
  return ((...args: unknown[]) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }) as T
}

// =============================================================================
// Boot
// =============================================================================

document.addEventListener("DOMContentLoaded", init)

// Also handle Astro view transitions
document.addEventListener("astro:page-load", init)
