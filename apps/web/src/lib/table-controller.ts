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
import { taskBackgroundUrl } from "@lib/task-page-url"
import { parseTaskView, taskViewUrl } from "@lib/task-view-route"
import { loadTableColumnPreferences, TABLE_COLUMNS, TABLE_SECTIONS } from "@lib/table-registry"
import { getRememberedAreaId } from "@lib/area-selector-controller"
import {
  saveTableFilterState,
  loadTableFilterState,
  normalizeTableColumns,
  tableCreationRangeLabel,
  writeTableFilterParams,
  getGroupKey,
  getGroupDisplay,
  type FilterState,
} from "@lib/filter-state"
import { updateTableSort, setupSortableHeaders } from "@lib/controllers/table-sorting"
import { isSelectableTableRow, setupBulkActions, updateBulkBar } from "@lib/controllers/table-bulk-actions"
import type { TableGroupStats, TablePageStats } from "@lib/table-page"
import { notifyTaskCountsChanged } from "@lib/deferral-client"
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
let areaMap: Record<string, AreaInfo> = {}

// =============================================================================
// Initialization
// =============================================================================

const PAGE_FOCUS_KEY = "meitheal:table-page-focus"

function focusTablePage(shell: HTMLElement, direction: string) {
  const pager = shell.querySelector<HTMLElement>("#table-pagination:not([hidden])")
  const links = Array.from(pager?.querySelectorAll<HTMLAnchorElement>("[data-table-page-link]") ?? [])
  const target = links.find(link => link.rel === direction) ?? links[0] ?? shell.querySelector<HTMLElement>("#table-search")
  target?.focus()
}

function setupPagerFocus(shell: HTMLElement, signal: AbortSignal) {
  shell.querySelector("#table-pagination")?.addEventListener("click", event => {
    if (!(event instanceof MouseEvent) || event.defaultPrevented || event.detail !== 0 ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const link = (event.target as Element).closest<HTMLAnchorElement>("[data-table-page-link]")
    if (!link) return
    try {
      sessionStorage.setItem(PAGE_FOCUS_KEY, JSON.stringify({
        destination: link.pathname + link.search, direction: link.rel, expires: Date.now() + 10_000,
      }))
    } catch { /* storage unavailable */ }
  }, { signal })

  try {
    const pending = sessionStorage.getItem(PAGE_FOCUS_KEY)
    if (!pending) return
    sessionStorage.removeItem(PAGE_FOCUS_KEY)
    const marker = JSON.parse(pending)
    if (marker?.destination === location.pathname + location.search && marker.expires > Date.now() &&
        (marker.direction === "next" || marker.direction === "prev")) {
      focusTablePage(shell, marker.direction)
    }
  } catch { /* storage unavailable or marker malformed */ }
}

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

  const table = shell.querySelector<HTMLTableElement>("#task-table")
  const container = shell.querySelector<HTMLElement>(".table-container")
  const tbody = table?.tBodies[0]
  const status = shell.querySelector<HTMLElement>("#table-refresh-status")
  const message = status?.querySelector<HTMLElement>("[data-table-refresh-message]")
  const retry = status?.querySelector<HTMLButtonElement>("[data-table-retry]")
  if (!table || !container || !tbody || !status || !message || !retry) return

  const initial = loadTableFilterState()
  initial.area ??= getRememberedAreaId()
  const initialColumns = initial.columns ?? loadTableColumnPreferences()
  initial.columns = initialColumns
  const rendered = JSON.parse(shell.dataset.tableFilters ?? "{}") as Partial<FilterState>
  let applied: Partial<FilterState> = { ...rendered, area: rendered.area ?? "", columns: initial.columns }
  let desired = initial
  let requestNumber = 0
  let pending: AbortController | undefined
  let resetPageOnRetry = false
  const replacedTitleEditors = new WeakSet<HTMLElement>()

  const renderRows = () => {
    const stats = JSON.parse(table.dataset.tableStats ?? "{}") as TablePageStats
    currentGroupBy = applied.groupBy ?? "none"
    applyGrouping(currentGroupBy, applied.subGroupBy ?? "none", stats)
    applyColumns(applied.columns)
    updateTableSort(applied.sort)
    shell.dataset.tableFilters = JSON.stringify(applied)
    const createdRange = tableCreationRangeLabel(applied.createdFrom, applied.createdThrough)
    shell.querySelector("[data-table-created-summary]")?.classList.toggle("filter-pill--active", Boolean(createdRange))
    const createdDateIndicator = shell.querySelector<HTMLElement>("[data-table-created-active]")
    if (createdDateIndicator) {
      createdDateIndicator.textContent = createdRange
      createdDateIndicator.hidden = !createdRange
    }
    document.dispatchEvent(new Event("meitheal:table-filters-applied"))
    const selectAll = table.querySelector<HTMLInputElement>("#select-all")
    if (selectAll) selectAll.checked = false
    updateBulkBar()
    container.classList.toggle("has-scroll", container.scrollWidth > container.clientWidth)
    return stats.total.count
  }

  const refresh = async (nextState = desired, resetPage = resetPageOnRetry) => {
    desired = nextState
    resetPageOnRetry = resetPage
    pending?.abort()
    const request = new AbortController()
    pending = request
    table.setAttribute("aria-busy", "true")
    status.hidden = true
    retry.hidden = true

    const url = new URL(location.href)
    writeTableFilterParams(url.searchParams, nextState)
    for (const key of ["open", "comment"]) url.searchParams.delete(key)
    if (resetPage) url.searchParams.delete("tp")
    url.searchParams.set("view", "table")
    url.hash = ""
    // Previous workers can return cached HTML even when fetch uses no-store.
    url.searchParams.set("tableRefresh", `${performance.timeOrigin}-${++requestNumber}`)

    try {
      const response = await fetch(url, {
        cache: "no-store", redirect: "error",
        signal: AbortSignal.any([request.signal, signal, AbortSignal.timeout(10_000)]),
      })
      if (!response.ok) throw new Error("Table refresh unavailable")
      const html = new DOMParser().parseFromString(await response.text(), "text/html")
      if (request.signal.aborted || signal.aborted || pending !== request) return
      const replacement = html.querySelector<HTMLTableElement>("#task-table")
      const fragments = ["#task-summary", "#table-pagination", "#table-empty", ".table-container", "#table-workflow-notice"].map(selector =>
        [shell.querySelector<HTMLElement>(selector), html.querySelector<HTMLElement>(selector)] as const)
      if (!replacement?.tBodies[0] || fragments.some(([current, fresh]) => !current || !fresh)) {
        throw new Error("Table refresh missing content")
      }

      const focused = document.activeElement
      const row = focused?.closest<HTMLElement>(".table-row")
      const id = row?.dataset.id
      const control = ["[data-open-table-task]", ".row-check", ".editable-cell", "select[data-field=status]",
        "select[data-field=priority]", ".delete-row", ".subtree-toggle", "[data-open-table-parent]"]
        .find(selector => focused?.matches(selector))
      const titleEditor = control === ".editable-cell" && focused instanceof HTMLElement ? focused : null
      const titleDraft = titleEditor?.textContent
      // Removing the focused editor can dispatch focusout before it is disconnected.
      if (titleEditor) replacedTitleEditors.add(titleEditor)
      const pagerLink = focused?.closest<HTMLAnchorElement>("#table-pagination [data-table-page-link]")
      const group = focused?.closest<HTMLElement>(".group-header-row")
      const groupControl = [".group-toggle", ".group-select-all"].find(selector => focused?.matches(selector))
      table.dataset.tablePage = replacement.dataset.tablePage
      table.dataset.tableStats = replacement.dataset.tableStats
      tbody.replaceChildren(...replacement.tBodies[0].children)
      for (const [current, fresh] of fragments) {
        current!.hidden = fresh!.hidden
        if (current!.matches("#task-summary, #table-pagination")) current!.replaceChildren(...fresh!.childNodes)
      }
      const workflowOptions = shell.querySelector("[data-table-workflow-options]")
      const freshWorkflowOptions = html.querySelector('[data-table-workflow-options="ready"]')
      if (workflowOptions && freshWorkflowOptions) {
        const lane = focused instanceof HTMLInputElement && workflowOptions.contains(focused) ? focused.value : null
        workflowOptions.replaceChildren(...freshWorkflowOptions.childNodes)
        if (lane !== null) {
          const control = workflowOptions.querySelector<HTMLInputElement>(`[data-table-lane][value="${CSS.escape(lane)}"]`)
          const summary = workflowOptions.parentElement?.querySelector("summary")
          const target = control && !control.disabled ? control : summary
          target?.focus({ preventScroll: true })
        }
      }
      // Column visibility can change while the rows are loading.
      applied = { ...nextState, columns: desired.columns ?? initialColumns }
      saveTableFilterState(applied, Number(table.dataset.tablePage))
      const background = taskBackgroundUrl(new URL(location.href))
      for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-view-tab]")) {
        const view = parseTaskView(link.dataset.viewTab ?? null)
        if (view) link.href = taskViewUrl(background, view).href
      }
      const count = renderRows()
      resetPageOnRetry = false

      status.classList.add("sr-only")
      message.textContent = `${count} ${status.dataset.tableUpdated}`
      status.hidden = false
      if (pagerLink && !pagerLink.isConnected) {
        focusTablePage(shell, pagerLink.rel)
      } else if (focused && !focused.isConnected && (row || group)) {
        const replacementRow = id && table.querySelector<HTMLElement>(`.table-row[data-id="${CSS.escape(id)}"]`)
        const replacementGroup = group && Array.from(table.querySelectorAll<HTMLElement>(".group-header-row")).find(header =>
          header.dataset.groupKey === group.dataset.groupKey && header.dataset.parentGroupKey === group.dataset.parentGroupKey)
        const target = (control && replacementRow && replacementRow.querySelector<HTMLElement>(control))
          || (groupControl && replacementGroup && replacementGroup.querySelector<HTMLElement>(groupControl))
        if (target && titleEditor && titleDraft != null && titleDraft.trim() !== titleEditor.dataset.original) {
          target.textContent = titleDraft
        }
        ;(target || (container.hidden ? shell.querySelector<HTMLElement>("#table-search") : container))?.focus()
      }
    } catch {
      if (request.signal.aborted || signal.aborted || pending !== request) return
      status.classList.remove("sr-only")
      message.textContent = status.dataset.tableFailure ?? ""
      status.hidden = false
      retry.hidden = false
    } finally {
      if (pending === request) {
        pending = undefined
        table.removeAttribute("aria-busy")
      }
    }
  }

  setupPagerFocus(shell, signal)
  setupGroupHeaderListeners(tbody, signal)
  setupSubtaskToggles(tbody, signal)
  setupInlineEditing(table, signal, () => void refresh(), replacedTitleEditors)
  setupRowClicks(table, signal, () => void refresh())
  setupBulkActions({ signal, onTasksChanged: () => void refresh() })
  setupSortableHeaders(signal, (column, direction) => void refresh({ ...desired, sort: `${column}-${direction}` }, true), () => desired.sort)
  setupTableOverflow()
  retry.addEventListener("click", () => {
    shell.querySelector<HTMLElement>("#table-search")?.focus()
    void refresh(desired, resetPageOnRetry)
  }, { signal })
  void loadAreas(signal)
  renderRows()

  const rowParams = (state: Partial<FilterState>) => {
    const params = new URLSearchParams()
    writeTableFilterParams(params, state)
    params.delete("columns")
    return params.toString()
  }
  if (retry.hidden && rowParams(initial) !== rowParams(applied)) void refresh(initial)
  else if (retry.hidden && new URLSearchParams(location.search).has("tp")) {
    const url = new URL(location.href)
    const page = Number(table.dataset.tablePage)
    if (page > 1) url.searchParams.set("tp", String(page))
    else url.searchParams.delete("tp")
    if (url.href !== location.href) history.replaceState(history.state, "", url)
  }

  document.addEventListener("meitheal:filter-change", event => {
    const detail = (event as CustomEvent<Partial<FilterState> & { view: string; clear?: boolean }>).detail
    if (detail?.view !== "table") return
    const next = {
      ...desired,
      search: detail.search ?? "",
      status: detail.status ?? "",
      priority: detail.priority ?? "",
      rice: detail.rice ?? "",
      user: detail.user ?? "",
      task_type: detail.task_type ?? "",
      laneIds: detail.laneIds ?? [],
      createdFrom: detail.createdFrom,
      createdThrough: detail.createdThrough,
      types: detail.types ?? [],
      labels: detail.labels ?? desired.labels ?? [],
      advancedFilter: detail.advancedFilter ?? null,
      groupBy: detail.groupBy ?? "none",
      subGroupBy: detail.subGroupBy ?? "none",
    }
    if (detail.clear) {
      next.area = ""
      document.dispatchEvent(new Event("meitheal:table-area-reset"))
    }
    void refresh(next, true)
  }, { signal })

  document.addEventListener("meitheal:label-filter", event => {
    const detail = (event as CustomEvent<{ labels: string[]; view?: string }>).detail
    if (detail?.view === "table") void refresh({ ...desired, labels: detail.labels }, true)
  }, { signal })

  document.addEventListener("meitheal:area-changed", event => {
    const { areaId } = (event as CustomEvent<{ areaId: string }>).detail
    void refresh({ ...desired, area: areaId }, true)
  }, { signal })

  document.addEventListener("meitheal:columns-change", event => {
    const { visible } = (event as CustomEvent<{ visible: string[] }>).detail
    const columns = normalizeTableColumns(visible)
    if (!columns) return
    desired.columns = applied.columns = columns
    saveTableFilterState(applied)
    applyColumns(columns)
    shell.dataset.tableFilters = JSON.stringify(applied)
  }, { signal })
}

function applyColumns(columns: readonly string[] | undefined) {
  const table = document.getElementById("task-table")
  if (!table) return
  for (const column of TABLE_COLUMNS) {
    table.classList.toggle(`hide-col-${column.id}`, columns !== undefined && !columns.includes(column.id))
  }
  table.querySelectorAll<HTMLTableCellElement>("tbody :is(td, th)[colspan]").forEach(cell => {
    cell.colSpan = (columns?.length ?? TABLE_COLUMNS.length) + 2
  })
  document.querySelectorAll<HTMLAnchorElement>("#table-pagination [data-table-page-link], #task-table [data-open-table-parent]")
    .forEach(link => {
      const url = new URL(link.href)
      if (columns) url.searchParams.set("columns", JSON.stringify(columns))
      link.href = url.href
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
// Row Grouping Engine
// =============================================================================

function applyGrouping(groupBy: string, subGroupBy: string, stats: TablePageStats) {
  const tbody = document.querySelector<HTMLElement>("#task-table tbody")
  if (!tbody) return

  if (groupBy === "none") return
  const groupTotals = new Map(stats.groups)
  const subgroupTotals = new Map(stats.subgroups)

  // Collect rows and compute groups
  const rows = Array.from(tbody.querySelectorAll<HTMLElement>(".table-row"))
  const groups = new Map<string, HTMLElement[]>()
  const groupOrder: string[] = []

  rows.forEach((row, index) => {
    row.id = `table-task-row-${index}`
    const key = getGroupKey(row, groupBy)
    row.setAttribute("data-group-value", key)
    if (!groups.has(key)) {
      groups.set(key, [])
      groupOrder.push(key)
    }
    groups.get(key)!.push(row)
  })

  // The server already ordered groups before slicing the page.
  const fragment = document.createDocumentFragment()

  // Load collapse states from sessionStorage
  const collapseKey = `meitheal-table-groups-${groupBy}`
  let collapsedGroups: string[] = []
  try {
    collapsedGroups = JSON.parse(sessionStorage.getItem(collapseKey) ?? "[]")
  } catch { /* ignore */ }

  function associateHeaders(rows: HTMLElement[], ...headers: string[]) {
    for (const row of rows) {
      row.querySelector(".col-title")?.setAttribute("headers", ["table-title-header", ...headers].join(" "))
    }
  }

  for (const [index, key] of groupOrder.entries()) {
    const groupId = `table-group-heading-${index}`
    const groupRows = groups.get(key) ?? []
    const display = getGroupDisplayForKey(groupBy, key)
    const isCollapsed = collapsedGroups.includes(key)

    // Create group header row
    const headerRow = document.createElement("tr")
    headerRow.className = `group-header-row${isCollapsed ? " collapsed" : ""}`
    headerRow.setAttribute("data-group-key", key)
    headerRow.setAttribute("data-group-by", groupBy)
    const headerCell = document.createElement("th")
    headerCell.id = groupId
    headerCell.scope = "row"
    headerCell.colSpan = TABLE_COLUMNS.length + 2
    headerCell.className = "group-header-cell"
    headerCell.setAttribute("aria-labelledby", groupId + "-label")
    const contentDiv = document.createElement("div")
    contentDiv.className = "group-header-content"

    const toggleBtn = document.createElement("button")
    toggleBtn.type = "button"
    toggleBtn.className = "group-toggle"
    toggleBtn.setAttribute("aria-label", `Toggle group ${display.label}`)
    toggleBtn.setAttribute("aria-expanded", String(!isCollapsed))
    const arrowSpan = document.createElement("span")
    arrowSpan.className = "group-toggle-arrow"
    arrowSpan.setAttribute("aria-hidden", "true")
    arrowSpan.textContent = "▾"
    toggleBtn.appendChild(arrowSpan)

    const dotSpan = document.createElement("span")
    dotSpan.className = "group-dot"
    dotSpan.setAttribute("aria-hidden", "true")
    dotSpan.style.background = sanitizeCssColor(display.color)

    const iconSpan = document.createElement("span")
    iconSpan.className = "group-icon"
    iconSpan.setAttribute("aria-hidden", "true")
    iconSpan.textContent = display.icon

    const labelSpan = document.createElement("span")
    labelSpan.className = "group-label"
    labelSpan.id = `${groupId}-label`
    labelSpan.textContent = display.label

    const countSpan = document.createElement("span")
    countSpan.className = "group-count"
    countSpan.textContent = String(groupTotals.get(key)?.count ?? 0)

    const cbWrapper = document.createElement("span")
    cbWrapper.className = "group-checkbox-wrapper"
    const cb = document.createElement("input")
    cb.type = "checkbox"
    cb.className = "group-select-all"
    cb.dataset.groupKey = key
    cb.setAttribute("aria-label", `Select visible tasks in ${display.label} on this page`)
    cbWrapper.appendChild(cb)

    contentDiv.append(toggleBtn, dotSpan, iconSpan, labelSpan, countSpan, cbWrapper)
    headerCell.replaceChildren(contentDiv)
    const controlledRows = groupRows.map(row => row.id)
    headerRow.appendChild(headerCell)
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

      for (const [subIndex, sk] of subOrder.entries()) {
        const subgroupId = `${groupId}-sub-${subIndex}`
        const subRows = subGroups.get(sk) ?? []
        const subDisplay = getGroupDisplayForKey(subGroupBy, sk)
        const subIsCollapsed = collapsedSubs.includes(sk)

        const subHeaderRow = document.createElement("tr")
        subHeaderRow.className = `group-header-row sub-group-header-row${subIsCollapsed ? " collapsed" : ""}`
        subHeaderRow.setAttribute("data-group-key", sk)
        subHeaderRow.setAttribute("data-group-by", subGroupBy)
        subHeaderRow.setAttribute("data-parent-group-key", key)
        subHeaderRow.setAttribute("data-sub-group-collapse-key", subCollapseKey)
        subHeaderRow.id = subgroupId + "-row"
        controlledRows.push(subHeaderRow.id)
        if (isCollapsed) subHeaderRow.classList.add("group-collapsed-row")

        const subCell = document.createElement("th")
        subCell.id = subgroupId
        subCell.scope = "row"
        subCell.colSpan = TABLE_COLUMNS.length + 2
        subCell.className = "group-header-cell sub-group-header-cell"
        subCell.setAttribute("aria-labelledby", subgroupId + "-label")
        const subContent = document.createElement("div")
        subContent.className = "group-header-content"

        const subToggleBtn = document.createElement("button")
        subToggleBtn.type = "button"
        subToggleBtn.className = "group-toggle sub-group-toggle"
        subToggleBtn.setAttribute("aria-label", `Toggle sub-group ${subDisplay.label}`)
        subToggleBtn.setAttribute("aria-expanded", String(!subIsCollapsed))
        subToggleBtn.setAttribute("aria-controls", subRows.map(row => row.id).join(" "))
        const subArrow = document.createElement("span")
        subArrow.className = "group-toggle-arrow"
        subArrow.setAttribute("aria-hidden", "true")
        subArrow.textContent = "▾"
        subToggleBtn.appendChild(subArrow)

        const subDot = document.createElement("span")
        subDot.className = "group-dot"
        subDot.setAttribute("aria-hidden", "true")
        subDot.style.background = sanitizeCssColor(subDisplay.color)

        const subLabel = document.createElement("span")
        subLabel.className = "group-label"
        subLabel.id = `${subgroupId}-label`
        subLabel.textContent = subDisplay.label

        const subCount = document.createElement("span")
        subCount.className = "group-count"
        subCount.textContent = String(subgroupTotals.get(JSON.stringify([key, sk]))?.count ?? 0)

        subContent.append(subToggleBtn, subDot, subLabel, subCount)
        subCell.replaceChildren(subContent)
        subHeaderRow.appendChild(subCell)
        fragment.appendChild(subHeaderRow)

        associateHeaders(subRows, groupId, subgroupId)
        subRows.forEach((row) => {
          row.classList.toggle("group-collapsed-row", isCollapsed || subIsCollapsed)
          fragment.appendChild(row)
        })
      }
    } else {
      // --- No sub-grouping: add rows directly ---
      associateHeaders(groupRows, groupId)
      groupRows.forEach((row) => {
        row.classList.toggle("group-collapsed-row", isCollapsed)
        fragment.appendChild(row)
      })
    }
    headerCell.querySelector("button")?.setAttribute("aria-controls", controlledRows.join(" "))
  }

  const noResults = tbody.querySelector(".no-results-row")
  tbody.replaceChildren(fragment)
  if (noResults) tbody.append(noResults)
  renderSummaryRows(tbody, groupTotals, stats.total)
}

function getGroupDisplayForKey(groupBy: string, key: string): { label: string, icon: string, color: string } {
  if (groupBy === "area" && areaMap[key]) {
    const b = areaMap[key]
    return { label: b.name, icon: b.icon ?? "📋", color: (b.color ?? getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()) || "#6366F1" }
  }
  return getGroupDisplay(groupBy, key)
}

function setupGroupHeaderListeners(tbody: HTMLElement, signal: AbortSignal) {
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
    header.querySelector("button")?.setAttribute("aria-expanded", String(!isCollapsed))

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
      const collapseKey = `meitheal-table-groups-${groupBy}`
      let sibling = header.nextElementSibling
      let subCollapsed = false
      while (sibling && !sibling.matches(".group-header-row:not(.sub-group-header-row), .no-results-row")) {
        if (sibling.matches(".sub-group-header-row")) {
          subCollapsed = sibling.classList.contains("collapsed")
          sibling.classList.toggle("group-collapsed-row", isCollapsed)
        } else {
          sibling.classList.toggle("group-collapsed-row", isCollapsed || (sibling.matches(".table-row") && subCollapsed))
        }
        sibling = sibling.nextElementSibling
      }
      try {
        let collapsed: string[] = JSON.parse(sessionStorage.getItem(collapseKey) ?? "[]")
        if (isCollapsed) { if (!collapsed.includes(groupKey)) collapsed.push(groupKey) }
        else { collapsed = collapsed.filter((k) => k !== groupKey) }
        sessionStorage.setItem(collapseKey, JSON.stringify(collapsed))
      } catch { /* ignore */ }
    }
    updateBulkBar()
  }, { signal })

  // Group select-all checkbox delegation
  tbody.addEventListener("change", (e) => {
    const target = e.target as HTMLElement
    if (!target.classList.contains("group-select-all")) return

    const header = target.closest<HTMLElement>(".group-header-row")
    if (!header) return

    const checked = (target as HTMLInputElement).checked
    let sibling = header.nextElementSibling
    while (sibling && !sibling.matches(".group-header-row:not(.sub-group-header-row), .no-results-row")) {
      const checkbox = sibling.querySelector<HTMLInputElement>(".row-check")
      if (checkbox && isSelectableTableRow(sibling)) checkbox.checked = checked
      sibling = sibling.nextElementSibling
    }
    updateBulkBar()
  }, { signal })
}

function renderSummaryRows(tbody: HTMLElement, groups: Map<string, TableGroupStats>, total: TableGroupStats) {
  function summary(stats: TableGroupStats, grandTotal = false) {
    const row = document.createElement("tr")
    row.className = grandTotal ? "grand-total-row" : "group-summary-row"
    const cell = row.insertCell()
    cell.colSpan = TABLE_COLUMNS.length + 2
    cell.className = grandTotal ? "grand-total-cell" : "group-summary-cell"
    const avgRice = stats.riceCount > 0 ? (stats.riceSum / stats.riceCount).toFixed(1) : "—"
    const labelSpan = document.createElement("span")
    labelSpan.className = "summary-label"
    labelSpan.textContent = `${grandTotal ? "Total: " : ""}${stats.count} task${stats.count !== 1 ? "s" : ""}`
    const sepSpan = document.createElement("span")
    sepSpan.className = "summary-separator"
    sepSpan.textContent = "·"
    const riceSpan = document.createElement("span")
    riceSpan.className = "summary-rice"
    riceSpan.textContent = `Avg RICE: ${avgRice}`
    cell.replaceChildren(labelSpan, sepSpan, riceSpan)
    return row
  }

  for (const header of tbody.querySelectorAll<HTMLElement>(".group-header-row:not(.sub-group-header-row)")) {
    const stats = groups.get(header.dataset.groupKey ?? "")
    if (!stats) continue
    let next = header.nextElementSibling
    while (next && !next.matches(".group-header-row:not(.sub-group-header-row), .no-results-row")) next = next.nextElementSibling
    tbody.insertBefore(summary(stats), next)
  }
  if (total.count > 0) tbody.append(summary(total, true))
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
      const subgroup = header.classList.contains("sub-group-header-row")
      header.querySelector(".group-toggle")?.setAttribute("aria-label", `Toggle ${subgroup ? "sub-group" : "group"} ${areaMap[key].name}`)
      header.querySelector(".group-select-all")?.setAttribute("aria-label", `Select visible tasks in ${areaMap[key].name} on this page`)
      if (icon) icon.textContent = areaMap[key].icon ?? "📋"
      if (dot) dot.style.background = (areaMap[key].color ?? getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()) || "#6366F1"
    }
  })
}

// =============================================================================
// Subtask Tree (mutually exclusive with grouping)
// =============================================================================

function setupSubtaskToggles(tbody: HTMLTableSectionElement, signal: AbortSignal) {
  tbody.addEventListener("click", event => {
    const toggle = (event.target as Element).closest<HTMLButtonElement>(".subtree-toggle")
    const parentId = toggle?.dataset.parentId
    if (!toggle || !parentId) return
    const expanded = toggle.getAttribute("aria-expanded") === "false"
    toggle.textContent = expanded ? "▾" : "▸"
    toggle.setAttribute("aria-expanded", String(expanded))
    toggleChildRows(parentId, expanded)
    updateBulkBar()
  }, { signal })
}

function toggleChildRows(parentId: string, show: boolean) {
  const childRows = document.querySelectorAll<HTMLElement>(
    `.table-row[data-parent-id="${CSS.escape(parentId)}"]`
  )
  childRows.forEach(row => {
    row.hidden = !show
    if (row.dataset.hasChildren !== "true" || show) return
    const toggle = row.querySelector<HTMLButtonElement>(".subtree-toggle")
    if (toggle) {
      toggle.textContent = "▸"
      toggle.setAttribute("aria-expanded", "false")
    }
    toggleChildRows(row.dataset.id ?? "", false)
  })
}

// =============================================================================
// Inline Editing
// =============================================================================

function setupInlineEditing(table: HTMLTableElement, signal: AbortSignal, refresh: () => void, replacedTitleEditors: WeakSet<HTMLElement>) {
  table.addEventListener("focusout", async event => {
    const cell = (event.target as Element).closest<HTMLElement>(".editable-cell")
    if (!cell || !cell.isConnected || replacedTitleEditors.has(cell)) return
    const title = cell.textContent?.trim() ?? ""
    const original = cell.dataset.original ?? ""
    if (!title || title === original) {
      cell.textContent = original
      return
    }
    const id = cell.dataset.id
    if (!id) return

    try {
      const response = await fetch(`/api/tasks/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }), signal,
      })
      if (!response.ok) throw new Error("Title update failed")
      if (signal.aborted) return
      cell.dataset.original = title
      showToast("Title updated", "success")
      refresh()
    } catch {
      if (signal.aborted) return
      cell.textContent = original
      showToast("Failed to update", "error")
    }
  }, { signal })

  table.addEventListener("keydown", event => {
    const cell = (event.target as Element).closest<HTMLElement>(".editable-cell")
    if (!cell || (event.key !== "Enter" && event.key !== "Escape")) return
    event.preventDefault()
    if (event.key === "Escape") cell.textContent = cell.dataset.original ?? ""
    cell.blur()
  }, { signal })

  table.addEventListener("change", async event => {
    const select = (event.target as Element).closest<HTMLSelectElement>(".inline-select")
    const id = select?.dataset.id
    const field = select?.dataset.field
    const row = select?.closest<HTMLElement>(".table-row")
    if (!id || !field || !row || !select) return
    const value = select.value
    const previous = row.dataset[field] ?? ""
    try {
      const response = await fetch(`/api/tasks/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: field === "priority" ? Number(value) : value }), signal,
      })
      if (!response.ok) throw new Error("Task update failed")
      if (signal.aborted) return
      showToast(`${field} updated`, "success")
      if (field === "status") {
        row.dataset.status = value
        row.classList.toggle("row-done", value === "complete")
        void reconcileTableDeferral(row, value, signal)
        if (value === "complete") onTaskCompleted(await response.json())
      }
      refresh()
    } catch {
      if (signal.aborted) return
      select.value = previous
      showToast("Failed to update", "error")
    }
  }, { signal })
}

function setupRowClicks(table: HTMLTableElement, signal: AbortSignal, refresh: () => void) {
  table.addEventListener("click", async event => {
    if (!(event.target instanceof Element)) return
    if (event.defaultPrevented || event.target.closest("a[data-task-detail-link]")) return
    const row = event.target.closest<HTMLElement>(".table-row")
    const id = row?.dataset.id
    if (!id || !row) return
    const control = event.target.closest<HTMLElement>("button, select, input, .editable-cell, a")
    const parent = control?.dataset.openTableParent
    if (parent && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault()
      openTaskDetailHandoff(parent)
      return
    }
    if (!control || control.hasAttribute("data-open-table-task")) {
      openTaskDetailHandoff(id)
      return
    }
    if (!control.classList.contains("delete-row")) return
    const confirmed = await confirmDialog({
      title: "Delete task?", message: "This action cannot be undone.",
      confirmText: "Delete", variant: "danger", signal,
    })
    if (!confirmed || signal.aborted) return
    try {
      const response = await fetch(`/api/tasks/${id}`, { method: "DELETE", signal })
      if (!response.ok) throw new Error("Task deletion failed")
      if (signal.aborted) return
      notifyTaskCountsChanged(row.dataset.projectId)
      showToast("Task deleted", "success")
      refresh()
    } catch {
      if (!signal.aborted) showToast("Failed to delete task", "error")
    }
  }, { signal })
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
