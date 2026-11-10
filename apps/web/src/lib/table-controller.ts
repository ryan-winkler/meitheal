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
 * - Area selector population from /api/areas
 *
 * @domain tasks
 * @bounded-context tasks (view-layer controller)
 */

import { showToast } from "@lib/toast"
import { confirmDialog } from "@lib/confirm-dialog"
import { onTaskCompleted } from "@lib/gamification-hook"
import { pageLifecycle } from "@lib/page-lifecycle"
import { initPageShellNavigation } from "@lib/page-shell-controller"
import { escapeHtml, sanitizeCssColor } from "@lib/safe-html"
import { openTaskDetailHandoff } from "@lib/task-detail-handoff"
import { loadTableColumnPreferences, TABLE_COLUMNS, TABLE_SECTIONS } from "@lib/table-registry"
import { getRememberedAreaId } from "@lib/area-selector-controller"
import {
  saveTableFilterState,
  loadTableFilterState,
  normalizeTableColumns,
  isTaskVisible,
  getGroupKey,
  getGroupDisplay,
  type FilterState,
} from "@lib/filter-state"
import { applyTableSort, setupSortableHeaders } from "@lib/controllers/table-sorting"
import { setupBulkActions, updateBulkBar } from "@lib/controllers/table-bulk-actions"
import { reconcileTableDeferral } from "@lib/controllers/table-deferral"

// =============================================================================
// Types
// =============================================================================

interface AreaInfo {
  id: string
  name: string
  icon?: string
  color?: string
}

// =============================================================================
// State
// =============================================================================

let currentGroupBy = "none"
let currentSubGroupBy = "none"
let areaMap: Record<string, AreaInfo> = {}
let currentFilterState: Partial<FilterState> = {}

// =============================================================================
// Initialization
// =============================================================================

function init(signal: AbortSignal) {
  const shell = document.getElementById("table-shell")
  if (!shell || shell.dataset.tableReady === "true") return
  shell.dataset.tableReady = "true"
  signal.addEventListener("abort", () => { delete shell.dataset.tableReady }, { once: true })
  areaMap = Object.create(null)
  if (document.getElementById("table-bar")) {
    initPageShellNavigation({
      barId: "table-bar",
      shellId: "table-shell",
      sectionSelector: "[data-table-section]",
      sectionIds: TABLE_SECTIONS.map((section) => section.id),
      defaultSectionId: "table-overview",
      flashClass: "page-shell__section--flash",
      sectionLinkSelectors: ["[data-table-section-link]"],
    })
  }

  const table = document.getElementById("task-table") as HTMLTableElement | null
  currentFilterState = loadTableFilterState()
  currentFilterState.area ??= getRememberedAreaId()
  currentFilterState.columns ??= loadTableColumnPreferences()
  currentGroupBy = currentFilterState.groupBy ?? "none"
  currentSubGroupBy = currentFilterState.subGroupBy ?? "none"

  if (table) {
    applyColumns()
    setupSubtaskToggles(signal)
    setupInlineEditing(signal)
    setupRowClicks(table)
    setupBulkActions({ signal, applyAllFilters, updateGroupCounts })
    setupSortableHeaders(signal, (column, direction) => {
      currentFilterState.sort = `${column}-${direction}`
      saveTableFilterState(currentFilterState)
      applyTableSort(currentFilterState.sort, currentGroupBy !== "none")
    }, () => currentFilterState.sort)
    setupTableOverflow()
    void loadAreas(signal)
  }

  document.addEventListener("meitheal:filter-change", event => {
    const detail = (event as CustomEvent<Partial<FilterState> & { view: string; clear?: boolean }>).detail
    if (detail?.view !== "table") return
    const newGroup = detail.groupBy ?? "none"
    const newSubGroup = detail.subGroupBy ?? "none"
    const groupChanged = newGroup !== currentGroupBy || newSubGroup !== currentSubGroupBy
    currentFilterState = {
      ...currentFilterState,
      search: detail.search ?? "",
      status: detail.status ?? "",
      priority: detail.priority ?? "",
      rice: detail.rice ?? "",
      user: detail.user ?? "",
      task_type: detail.task_type ?? "",
      types: detail.types ?? [],
      labels: detail.labels ?? currentFilterState.labels ?? [],
      advancedFilter: detail.advancedFilter ?? null,
      groupBy: newGroup,
      subGroupBy: newSubGroup,
    }
    if (detail.clear) {
      currentFilterState.area = ""
      document.dispatchEvent(new Event("meitheal:table-area-reset"))
    }
    currentGroupBy = newGroup
    currentSubGroupBy = newSubGroup
    saveTableFilterState(currentFilterState)
    if (groupChanged) applyGrouping(currentGroupBy, currentSubGroupBy)
    applyAllFilters()
    if (groupChanged) applyTableSort(currentFilterState.sort, currentGroupBy !== "none")
  }, { signal })

  document.addEventListener("meitheal:label-filter", event => {
    const detail = (event as CustomEvent<{ labels: string[]; view?: string }>).detail
    if (detail?.view !== "table") return
    currentFilterState.labels = detail.labels
    saveTableFilterState(currentFilterState)
    applyAllFilters()
  }, { signal })

  document.addEventListener("meitheal:area-changed", event => {
    const { areaId } = (event as CustomEvent<{ areaId: string }>).detail
    currentFilterState.area = areaId
    saveTableFilterState(currentFilterState)
    applyAllFilters()
  }, { signal })

  document.addEventListener("meitheal:columns-change", event => {
    const { visible } = (event as CustomEvent<{ visible: string[] }>).detail
    const columns = normalizeTableColumns(visible)
    if (!columns) return
    currentFilterState.columns = columns
    saveTableFilterState(currentFilterState)
    applyColumns()
  }, { signal })

  if (currentGroupBy !== "none") applyGrouping(currentGroupBy, currentSubGroupBy)
  applyAllFilters()
  applyTableSort(currentFilterState.sort, currentGroupBy !== "none")
}

function visibleColumnCount() {
  return (currentFilterState.columns ?? TABLE_COLUMNS).length + 2
}

function applyColumns() {
  const table = document.getElementById("task-table")
  if (!table) return
  for (const column of TABLE_COLUMNS) {
    table.classList.toggle(`hide-col-${column.id}`, !currentFilterState.columns?.includes(column.id))
  }
  table.querySelectorAll<HTMLTableCellElement>("tbody td[colspan]").forEach(cell => {
    cell.colSpan = visibleColumnCount()
  })
}

// =============================================================================
// Area Data Loading
// =============================================================================

async function loadAreas(signal: AbortSignal) {
  try {
    const res = await fetch("/api/areas", { signal })
    if (!res.ok) return
    const data = await res.json()
    if (signal.aborted) return
    const boards: AreaInfo[] = data.areas || []

    boards.forEach((b) => {
      areaMap[b.id] = b
    })

    // NOTE: Area filter <select> is populated by FilterToolbar's client script
    // We only populate the bulk board selector and update group headers here

    // Populate bulk board selector
    const bulkArea = document.getElementById("bulk-area") as HTMLSelectElement | null
    if (bulkArea) {
      boards.forEach((b) => {
        const opt = document.createElement("option")
        opt.value = b.id
        opt.textContent = `${b.icon ?? "📋"} ${b.name}`
        bulkArea.appendChild(opt)
      })
    }

    // Update group headers with board names if grouped by board
    if (currentGroupBy === "area") {
      updateGroupHeaderLabels()
    }

  } catch {
    /* offline fallback — board filter stays as-is */
  }
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
  const colCount = visibleColumnCount()

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
      <button type="button" class="group-toggle" aria-label="Toggle group ${escapeHtml(display.label)}">
        <span class="group-toggle-arrow">▾</span>
      </button>
      <span class="group-dot" style="background: ${sanitizeCssColor(display.color)}"></span>
      <span class="group-icon">${escapeHtml(display.icon)}</span>
      <span class="group-label">${escapeHtml(display.label)}</span>
      <span class="group-count">${groupRows.length}</span>
      <span class="group-checkbox-wrapper">
        <input type="checkbox" class="group-select-all" data-group-key="${escapeHtml(key)}" aria-label="Select all in ${escapeHtml(display.label)}" />
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
          <button type="button" class="group-toggle sub-group-toggle" aria-label="Toggle sub-group ${escapeHtml(subDisplay.label)}">
            <span class="group-toggle-arrow">▾</span>
          </button>
          <span class="group-dot" style="background: ${sanitizeCssColor(subDisplay.color)}"></span>
          <span class="group-label">${escapeHtml(subDisplay.label)}</span>
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
  tbody.replaceChildren()
  tbody.appendChild(fragment)
  if (noResults) tbody.appendChild(noResults)

  // Set up group header click handlers
  setupGroupHeaderListeners()
}

function getGroupDisplayForKey(groupBy: string, key: string): { label: string, icon: string, color: string } {
  if (groupBy === "area" && areaMap[key]) {
    const b = areaMap[key]
    return { label: b.name, icon: b.icon ?? "📋", color: (b.color ?? getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()) || "#6366F1" }
  }
  return getGroupDisplay(groupBy, key)
}

function setupGroupHeaderListeners() {
  const tbody = document.querySelector<HTMLElement>("#task-table tbody")
  if (!tbody || tbody.dataset.groupListenerBound) return
  tbody.dataset.groupListenerBound = "true"
  const signal = pageLifecycle.signal
  signal.addEventListener("abort", () => { delete tbody.dataset.groupListenerBound }, { once: true })

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
  }, { signal })

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
  }, { signal })
}

function updateGroupCounts() {
  document.querySelectorAll<HTMLElement>(".group-header-row").forEach((header) => {
    const countEl = header.querySelector<HTMLElement>(".group-count")
    if (!countEl) return

    let count = 0
    let sibling = header.nextElementSibling
    const subgroup = header.classList.contains("sub-group-header-row")
    while (sibling && !sibling.classList.contains("no-results-row")) {
      if (sibling.classList.contains("group-header-row") &&
          (subgroup || !sibling.classList.contains("sub-group-header-row"))) break
      if (sibling.classList.contains("table-row") && !sibling.classList.contains("filtered-out")) count++
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

  const colCount = visibleColumnCount()
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
    while (sibling && !sibling.classList.contains("no-results-row") &&
        (!sibling.classList.contains("group-header-row") || sibling.classList.contains("sub-group-header-row"))) {
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
  document.querySelectorAll<HTMLElement>(".group-header-row[data-group-by='area']").forEach((header) => {
    const key = header.dataset.groupKey ?? ""
    if (areaMap[key]) {
      const label = header.querySelector<HTMLElement>(".group-label")
      const icon = header.querySelector<HTMLElement>(".group-icon")
      const dot = header.querySelector<HTMLElement>(".group-dot")
      if (label) label.textContent = areaMap[key].name
      if (icon) icon.textContent = areaMap[key].icon ?? "📋"
      if (dot) dot.style.background = (areaMap[key].color ?? getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()) || "#6366F1"
    }
  })
}

// =============================================================================
// Subtask Tree (mutually exclusive with grouping)
// =============================================================================

function setupSubtaskToggles(signal: AbortSignal) {
  document.querySelectorAll<HTMLButtonElement>(".subtree-toggle").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation()
      const parentId = btn.dataset.parentId
      if (!parentId) return

      const isCollapsed = btn.textContent?.trim() === "▸"
      btn.textContent = isCollapsed ? "▾" : "▸"
      btn.setAttribute("aria-expanded", String(isCollapsed))

      toggleChildRows(parentId, isCollapsed)
    }, { signal })
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

function setupInlineEditing(signal: AbortSignal) {
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
          signal,
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
    }, { signal })

    cell.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault()
        cell.blur()
      }
      if (e.key === "Escape") {
        cell.textContent = cell.dataset.original ?? ""
        cell.blur()
      }
    }, { signal })

    // Stop click from opening task detail
    cell.addEventListener("click", (e) => e.stopPropagation(), { signal })
  })

  // Inline select changes (status, priority)
  document.querySelectorAll<HTMLSelectElement>(".inline-select").forEach((sel) => {
    sel.addEventListener("click", (e) => e.stopPropagation(), { signal })
    sel.addEventListener("change", async () => {
      const id = sel.dataset.id
      const field = sel.dataset.field
      if (!id || !field) return

      try {
        const res = await fetch(`/api/tasks/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [field]: field === "priority" ? Number(sel.value) : sel.value }),
          signal,
        })
        if (res.ok) {
          showToast(`${field} updated`, "success")
          // Update row data attribute
          const row = sel.closest<HTMLElement>(".table-row")
          if (row && field === "status") {
            row.dataset.status = sel.value
            row.classList.toggle("row-done", sel.value === "complete")
            void reconcileTableDeferral(row, sel.value, signal)
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
    }, { signal })
  })
}

// =============================================================================
// Row Click to Open Detail
// =============================================================================

function setupRowClicks(table: HTMLTableElement) {
  pageLifecycle.on(table, "click", (event) => {
    if (!(event.target instanceof Element)) return
    const row = event.target.closest<HTMLElement>(".table-row")
    const id = row?.dataset.id
    if (!id) return

    const control = event.target.closest("button, select, input, .editable-cell, a")
    if (!control || control.hasAttribute("data-open-table-task")) openTaskDetailHandoff(id)
  })
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
  pageLifecycle.on(window, "resize", debounce(checkOverflow, 200))
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

pageLifecycle.onPageLoad(signal => {
  try { init(signal) } catch (e) { console.error("[Meitheal][table] Boot failed", e) }
})
