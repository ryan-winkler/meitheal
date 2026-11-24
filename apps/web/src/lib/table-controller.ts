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
 * - Area choices and grouping labels from the accepted Table response
 *
 * @domain tasks
 * @bounded-context tasks (view-layer controller)
 */

import { createTableTaskWrites, type TableTaskWrites } from "./table-task-writes"
import { showToast } from "@lib/toast"
import { confirmDialog } from "@lib/confirm-dialog"
import { onTaskCompleted } from "@lib/gamification-hook"
import { pageLifecycle } from "@lib/page-lifecycle"
import { initPageShellNavigation } from "@lib/page-shell-controller"
import { escapeHtml, sanitizeCssColor } from "@lib/safe-html"
import { openTaskDetailHandoff } from "@lib/task-detail-handoff"
import { currentTaskApiContext, taskApiHeaders } from "@lib/task-api"
import { hydrateTaskAssignees } from "@lib/task-assignee-display"
import { replaceTaskBackgroundUrl, taskBackgroundUrl } from "@lib/task-page-url"
import { TASK_REFRESH_FRAGMENT_HEADER } from "@lib/task-view-route"
import { loadTableColumnPreferences, TABLE_COLUMNS, TABLE_SECTIONS } from "@lib/table-registry"
import { getRememberedAreaId, TABLE_AREA_CATALOG_EVENT } from "@lib/area-selector-controller"
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
import { byId, domEl, qs, setAttr } from "@lib/dom-helpers"

// =============================================================================
// Types
// =============================================================================

type AreaDisplay = ReturnType<typeof getGroupDisplay>
type RenderGroupStats = TableGroupStats<number | null>
type RenderPageStats = TablePageStats<number | null>

// =============================================================================
// State
// =============================================================================

let currentGroupBy = "none"

// =============================================================================
// Initialization
// =============================================================================

const PAGE_FOCUS_KEY = "meitheal:table-page-focus"

function hasTablePageStats(stats: RenderPageStats | null): stats is RenderPageStats {
  // JSON serializes an overflowing RICE sum as null.
  const hasTotals = (totals: RenderGroupStats) =>
    Number.isFinite(totals?.count) && Number.isFinite(totals?.riceCount) &&
    (totals.riceSum === null || Number.isFinite(totals.riceSum))
  return Boolean(stats && Array.isArray(stats.epicLabels) && stats.epicLabels.every(entry =>
    Array.isArray(entry) && entry.length === 2 && entry.every(value => typeof value === "string"),
  ) && hasTotals(stats.total) && [stats.groups, stats.subgroups].every(entries =>
    Array.isArray(entries) && entries.every(entry =>
      Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && hasTotals(entry[1]),
    ),
  ))
}

function focusTablePage(shell: HTMLElement, direction: string) {
  const pager = qs<HTMLElement>(shell, "#table-pagination:not([hidden])")
  const links = Array.from(pager?.querySelectorAll<HTMLAnchorElement>("[data-table-page-link]") ?? [])
  const target = links.find(link => link.rel === direction) ?? links[0] ?? qs<HTMLElement>(shell, "#table-search")
  target?.focus()
}

function setupPagerFocus(shell: HTMLElement, signal: AbortSignal) {
  qs(shell, "#table-pagination")?.addEventListener("click", event => {
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
  const shell = byId("table-shell")
  if (!shell || shell.dataset.tableReady === "true") return
  shell.dataset.tableReady = "true"
  signal.addEventListener("abort", () => { delete shell.dataset.tableReady }, { once: true })
  if (byId("table-bar")) {
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

  const table = qs<HTMLTableElement>(shell, "#task-table")
  const container = qs<HTMLElement>(shell, ".table-container")
  const tbody = table?.tBodies[0]
  const status = qs<HTMLElement>(shell, "#table-refresh-status")
  const message = qs<HTMLElement>(status, "[data-table-refresh-message]")
  const retry = qs<HTMLButtonElement>(status, "[data-table-retry]")
  if (!table || !container || !tbody || !status || !message || !retry) return
  const bulkArea = document.querySelector<HTMLSelectElement>("#bulk-area")
  const areaSelector = byId("area-selector-dropdown")
  const areaPicker = "#area-selector-dropdown[data-area-catalog-ready='true']"
  const initialAreaCatalog = document.querySelector(areaPicker)
  let areas = applyAreaCatalog(initialAreaCatalog, bulkArea)
  void hydrateTaskAssignees(tbody, signal)

  const initial = loadTableFilterState()
  initial.area = areaSelector ? initial.area ?? getRememberedAreaId() : ""
  const initialColumns = initial.columns ?? loadTableColumnPreferences()
  initial.columns = initialColumns
  const rendered = JSON.parse(shell.dataset.tableFilters ?? "{}") as Partial<FilterState>
  let applied: Partial<FilterState> = { ...rendered, area: rendered.area ?? "", columns: initial.columns }
  let desired = initial
  let requestNumber = 0
  let pending: AbortController | undefined
  let resetPageOnRetry = false
  const replacedTitleEditors = new WeakSet<HTMLElement>()

  const renderRows = (stats = JSON.parse(table.dataset.tableStats ?? "{}") as RenderPageStats) => {
    currentGroupBy = applied.groupBy ?? "none"
    applyGrouping(currentGroupBy, applied.subGroupBy ?? "none", stats, areas)
    applyColumns(applied.columns)
    updateTableSort(applied.sort)
    const manualBtn = byId("table-manual-order-btn")
    if (manualBtn) setAttr(manualBtn, "aria-pressed", String(applied.sort === "manual-asc" && (!applied.groupBy || applied.groupBy === "none")))
    shell.dataset.tableFilters = JSON.stringify(applied)
    const createdRange = tableCreationRangeLabel(applied.createdFrom, applied.createdThrough)
    qs(shell, "[data-table-created-summary]")?.classList.toggle("filter-pill--active", Boolean(createdRange))
    const createdDateIndicator = qs<HTMLElement>(shell, "[data-table-created-active]")
    if (createdDateIndicator) {
      createdDateIndicator.textContent = createdRange
      createdDateIndicator.hidden = !createdRange
    }
    document.dispatchEvent(new Event("meitheal:table-filters-applied"))
    const selectAll = qs<HTMLInputElement>(table, "#select-all")
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
    setAttr(table, "aria-busy", "true")
    status.hidden = true
    retry.hidden = true

    const url = taskBackgroundUrl()
    writeTableFilterParams(url.searchParams, nextState)
    for (const key of ["open", "comment"]) url.searchParams.delete(key)
    if (resetPage) url.searchParams.delete("tp")
    url.searchParams.set("view", "table")
    url.hash = ""
    // Previous workers can return cached HTML even when fetch uses no-store.
    url.searchParams.set("tableRefresh", `${performance.timeOrigin}-${++requestNumber}`)

    try {
      const response = await fetch(url, {
        headers: { [TASK_REFRESH_FRAGMENT_HEADER]: "1" },
        cache: "no-store", redirect: "error",
        signal: AbortSignal.any([request.signal, signal, AbortSignal.timeout(10_000)]),
      })
      if (!response.ok) throw new Error("Table refresh unavailable")
      const html = new DOMParser().parseFromString(await response.text(), "text/html")
      if (request.signal.aborted || signal.aborted || pending !== request) return
      const replacement = qs<HTMLTableElement>(html, "#task-table")
      const areaCatalog = areaSelector ? qs<HTMLElement>(html, areaPicker) : null
      const fragments = ["#task-summary", "#table-pagination", "#table-empty", ".table-container", "#table-workflow-notice"].map(selector =>
        [qs<HTMLElement>(shell, selector), qs<HTMLElement>(html, selector)] as const)
      if (!replacement?.tBodies[0] || (areaSelector && !areaCatalog) || fragments.some(([current, fresh]) => !current || !fresh)) {
        throw new Error("Table refresh missing content")
      }
      const page = Number(replacement.dataset.tablePage)
      const stats = JSON.parse(replacement.dataset.tableStats ?? "null") as RenderPageStats | null
      if (!Number.isSafeInteger(page) || page < 1 || !hasTablePageStats(stats)) {
        throw new Error("Table refresh missing pagination or group totals")
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
      writes.restore()
      areas = applyAreaCatalog(areaCatalog, bulkArea)
      if (areaCatalog) document.dispatchEvent(new CustomEvent(TABLE_AREA_CATALOG_EVENT, { detail: areaCatalog }))
      void hydrateTaskAssignees(tbody, signal)
      for (const [current, fresh] of fragments) {
        current!.hidden = fresh!.hidden
        if (current!.matches("#task-summary, #table-pagination, #table-empty")) current!.replaceChildren(...fresh!.childNodes)
      }
      const workflowOptions = qs<HTMLElement>(shell, "[data-table-workflow-options]")
      const freshWorkflowOptions = qs(html, '[data-table-workflow-options="ready"]')
      if (workflowOptions && freshWorkflowOptions) {
        const lane = focused instanceof HTMLInputElement && workflowOptions.contains(focused) ? focused.value : null
        workflowOptions.replaceChildren(...freshWorkflowOptions.childNodes)
        workflowOptions.dataset.tableWorkflowOptions = "ready"
        if (lane !== null) {
          const control = qs<HTMLInputElement>(workflowOptions, `[data-table-lane][value="${CSS.escape(lane)}"]`)
          const summary = workflowOptions.parentElement?.querySelector("summary")
          const target = control && !control.disabled ? control : summary
          target?.focus({ preventScroll: true })
        }
      }
      // Column visibility can change while the rows are loading.
      applied = { ...nextState, columns: desired.columns ?? initialColumns }
      saveTableFilterState(applied, page)
      const count = renderRows(stats)
      resetPageOnRetry = false

      status.classList.add("sr-only")
      message.textContent = `${count} ${status.dataset.tableUpdated}`
      status.hidden = false
      if (pagerLink && !pagerLink.isConnected) {
        focusTablePage(shell, pagerLink.rel)
      } else if (focused && !focused.isConnected && (row || group)) {
        const replacementRow = id && qs<HTMLElement>(table, `.table-row[data-id="${CSS.escape(id)}"]`)
        const replacementGroup = group && Array.from(table.querySelectorAll<HTMLElement>(".group-header-row")).find(header =>
          header.dataset.groupKey === group.dataset.groupKey && header.dataset.parentGroupKey === group.dataset.parentGroupKey)
        const target = (control && replacementRow && qs<HTMLElement>(replacementRow, control))
          || (groupControl && replacementGroup && qs<HTMLElement>(replacementGroup, groupControl))
        if (target && titleEditor && titleDraft != null && titleDraft.trim() !== titleEditor.dataset.original) {
          target.textContent = titleDraft
        }
        ;(target || (container.hidden ? qs<HTMLElement>(shell, "#table-search") : container))?.focus()
      }
    } catch {
      if (request.signal.aborted || signal.aborted || pending !== request) return
      status.classList.remove("sr-only")
      const groupingChanged = (nextState.groupBy ?? "none") !== (applied.groupBy ?? "none") ||
        (nextState.subGroupBy ?? "none") !== (applied.subGroupBy ?? "none")
      message.textContent = (groupingChanged ? status.dataset.tableSelectionPending : status.dataset.tableFailure) ?? ""
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
  const writes = createTableTaskWrites(table, signal, () => void refresh())
  const refreshAfterWrite = () => { if (!writes.hasPending()) void refresh() }
  setupInlineEditing(table, signal, refreshAfterWrite, replacedTitleEditors, writes)
  setupRowClicks(table, signal, refreshAfterWrite, writes)
  setupBulkActions({ signal, onTasksChanged: refreshAfterWrite, writes })
  setupSortableHeaders(signal, (column, direction) => void refresh({ ...desired, sort: `${column}-${direction}` }, true), () => desired.sort)
  const manualOrderBtn = byId("table-manual-order-btn")
  manualOrderBtn?.addEventListener("click", () => {
    const isManual = desired.sort === "manual-asc" && (!desired.groupBy || desired.groupBy === "none")
    void refresh(isManual ? { ...desired, sort: undefined } : { ...desired, sort: "manual-asc", groupBy: "none", subGroupBy: "none" }, true)
  }, { signal })

  const persistTableOrder = async (movedRow: HTMLElement, rollback: () => void) => {
    const needsSwitch = (desired.groupBy && desired.groupBy !== "none") || (desired.sort && !desired.sort.startsWith("manual"))
    if (needsSwitch) {
      rollback()
      const approved = await confirmDialog({
        title: "Switch to Manual order?",
        message: "Reordering rows switches the table to ungrouped Manual order.",
        confirmText: "Switch & Reorder",
        signal,
      })
      if (!approved || signal.aborted) return
      desired = { ...desired, sort: "manual-asc", groupBy: "none", subGroupBy: "none" }
      await refresh(desired, true)
      showToast("Manual order enabled — drag or press Alt+Up/Down to position rows")
      return
    }
    const orderedIds = Array.from(tbody.querySelectorAll<HTMLElement>(".table-row[data-id]"))
      .map(row => row.dataset.id)
      .filter((id): id is string => Boolean(id))
    if (!orderedIds.length) return
    try {
      const ctx = currentTaskApiContext()
      const res = await fetch("/api/tasks/reorder", {
        method: "POST",
        headers: ctx ? taskApiHeaders(ctx, { "content-type": "application/json" }) : { "content-type": "application/json" },
        body: JSON.stringify({ scope: "table", ordered_ids: orderedIds }),
        signal,
      })
      if (!res.ok) throw new Error("Table reorder failed")
      if (!desired.sort) desired = { ...desired, sort: "manual-asc" }
      await refresh(desired)
    } catch {
      rollback()
      if (!signal.aborted) showToast("Could not save table order", "error")
    }
  }

  const getRowTier = (row: HTMLElement) => ({
    parentId: row.dataset.parentId ?? "",
    depth: Number(row.dataset.depth ?? 0),
  })

  const getRowSubtreeBlock = (rows: HTMLElement[], startIdx: number): HTMLElement[] => {
    const startRow = rows[startIdx]
    if (!startRow) return []
    const baseDepth = Number(startRow.dataset.depth ?? 0)
    let endIdx = startIdx + 1
    while (endIdx < rows.length && Number(rows[endIdx]!.dataset.depth ?? 0) > baseDepth) {
      endIdx++
    }
    return rows.slice(startIdx, endIdx)
  }

  const canSwapTableRows = (dragged: HTMLElement, target: HTMLElement): boolean => {
    if (table.dataset.canEdit === "false") return false
    const a = getRowTier(dragged)
    const b = getRowTier(target)
    if (a.parentId !== b.parentId || a.depth !== b.depth) return false
    const rows = Array.from(tbody.querySelectorAll<HTMLElement>(":scope > .table-row"))
    const idxA = rows.indexOf(dragged)
    const idxB = rows.indexOf(target)
    if (idxA < 0 || idxB < 0 || idxA === idxB) return false
    const lo = Math.min(idxA, idxB)
    const hi = Math.max(idxA, idxB)
    for (let i = lo + 1; i < hi; i++) {
      if (Number(rows[i]!.dataset.depth ?? 0) < a.depth) return false
    }
    return true
  }

  const moveRowBlock = (dragged: HTMLElement, target: HTMLElement, direction: "before" | "after"): void => {
    const rows = Array.from(tbody.querySelectorAll<HTMLElement>(":scope > .table-row"))
    const draggedIdx = rows.indexOf(dragged)
    const targetIdx = rows.indexOf(target)
    if (draggedIdx < 0 || targetIdx < 0) return
    const block = getRowSubtreeBlock(rows, draggedIdx)
    if (block.includes(target)) return
    const anchor = direction === "before"
      ? target
      : (getRowSubtreeBlock(rows, targetIdx).at(-1)?.nextElementSibling ?? null)
    for (const node of block) tbody.insertBefore(node, anchor)
  }

  const restoreBlockBefore = (block: HTMLElement[], anchor: Element | null): void => {
    for (const node of block) {
      if (node.parentElement === tbody) tbody.insertBefore(node, anchor)
    }
  }

  let preDragState: { block: HTMLElement[]; anchor: Element | null } | null = null
  void import("@lib/list-drag-reorder")
    .then(({ attachVerticalListDragReorder }) => {
      if (signal.aborted) return
      attachVerticalListDragReorder(tbody, {
        handle: ".table-row-drag-handle",
        item: ".table-row",
        ghostClass: "dragging",
        signal,
        canSwap: canSwapTableRows,
        moveItem: moveRowBlock,
        onStart: () => {
          const dragging = qs<HTMLElement>(tbody, ".table-row.dragging")
          if (!dragging) return
          const rows = Array.from(tbody.querySelectorAll<HTMLElement>(":scope > .table-row"))
          const idx = rows.indexOf(dragging)
          const block = idx >= 0 ? getRowSubtreeBlock(rows, idx) : [dragging]
          preDragState = { block, anchor: block.at(-1)?.nextElementSibling ?? null }
        },
        onEnd: ({ item, oldIndex, newIndex }) => {
          const snapshot = preDragState
          preDragState = null
          if (oldIndex === newIndex || !snapshot) return
          void persistTableOrder(item, () => {
            restoreBlockBefore(snapshot.block, snapshot.anchor)
          })
        },
      })
    })
    .catch(() => {})

  tbody.addEventListener("keydown", (event) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return
    if (table.dataset.canEdit === "false") return
    const handle = (event.target as Element | null)?.closest<HTMLElement>(".table-row-drag-handle")
    const row = handle?.closest<HTMLElement>(".table-row")
    if (!handle || !row || row.parentElement !== tbody) return
    event.preventDefault()
    const rows = Array.from(tbody.querySelectorAll<HTMLElement>(":scope > .table-row"))
    const idx = rows.indexOf(row)
    const { parentId, depth } = getRowTier(row)
    const block = getRowSubtreeBlock(rows, idx)
    let target: HTMLElement | undefined
    if (event.key === "ArrowUp") {
      for (let i = idx - 1; i >= 0; i--) {
        const candidate = rows[i]!
        const cTier = getRowTier(candidate)
        if (cTier.depth < depth) break
        if (cTier.depth === depth && cTier.parentId === parentId) {
          target = candidate
          break
        }
      }
    } else {
      for (let i = idx + block.length; i < rows.length; i++) {
        const candidate = rows[i]!
        const cTier = getRowTier(candidate)
        if (cTier.depth < depth) break
        if (cTier.depth === depth && cTier.parentId === parentId) {
          target = candidate
          break
        }
      }
    }
    if (!target) return
    const prevAnchor = block.at(-1)?.nextElementSibling ?? null
    moveRowBlock(row, target, event.key === "ArrowUp" ? "before" : "after")
    handle.focus()
    void persistTableOrder(row, () => { restoreBlockBefore(block, prevAnchor) })
  }, { signal })

  setupTableOverflow()
  retry.addEventListener("click", () => {
    qs<HTMLElement>(shell, "#table-search")?.focus()
    void refresh(desired, resetPageOnRetry)
  }, { signal })
  renderRows()
  if (!initialAreaCatalog && retry.hidden) {
    status.hidden = false
    retry.hidden = false
    message.textContent = window.mI18n?.get("table.area_catalog_failed") ?? "Area names could not load."
  }

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
    if (url.href !== location.href) replaceTaskBackgroundUrl(url)
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

  document.addEventListener("meitheal:task-hierarchy-changed", () => {
    if (desired.groupBy === "epic" || desired.subGroupBy === "epic") refreshAfterWrite()
  }, { signal })

  document.addEventListener("meitheal:lanes-changed", () => {
    refreshAfterWrite()
  }, { signal })

  document.addEventListener("meitheal:tasks-changed", event => {
    const detail = (event as CustomEvent<{ action?: string }>).detail
    if (detail?.action === "deferral") return
    refreshAfterWrite()
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
  const table = byId("task-table")
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

function applyAreaCatalog(catalog: Element | null, bulkArea: HTMLSelectElement | null): Map<string, AreaDisplay> {
  const areas = new Map<string, AreaDisplay>()
  for (const { dataset } of catalog?.querySelectorAll<HTMLElement>("[data-area-id]") ?? []) {
    const { areaId, areaName, areaIcon, areaColor } = dataset
    if (areaId && areaName) areas.set(areaId, {
      label: areaName, icon: areaIcon || "📋", color: areaColor || "var(--accent)",
    })
  }
  const prompt = bulkArea?.options[0]
  if (bulkArea && prompt) {
    const selected = bulkArea.value
    const options = Array.from(areas, ([id, area]) => new Option(`${area.icon} ${area.label}`, id))
    bulkArea.replaceChildren(prompt, ...options)
    bulkArea.value = areas.has(selected) ? selected : ""
  }
  return areas
}

// =============================================================================
// Row Grouping Engine
// =============================================================================

function groupDecoration(className: string, text = "") {
  const span = domEl("span", className)
  setAttr(span, "aria-hidden", "true")
  span.textContent = text
  return span
}

function applyGrouping(groupBy: string, subGroupBy: string, stats: RenderPageStats, areas: Map<string, AreaDisplay>) {
  const tbody = document.querySelector<HTMLElement>("#task-table tbody")
  if (!tbody) return

  if (groupBy === "none") return
  const groupTotals = new Map(stats.groups)
  const subgroupTotals = new Map(stats.subgroups)
  const epicLabels = new Map(stats.epicLabels)

  // Collect rows and compute groups
  const rows = Array.from(tbody.querySelectorAll<HTMLElement>(".table-row"))
  const groups = new Map<string, HTMLElement[]>()
  const groupOrder: string[] = []

  rows.forEach((row, index) => {
    row.id = `table-task-row-${index}`
    const key = getGroupKey(row, groupBy)
    setAttr(row, "data-group-value", key)
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
      setAttr(row.querySelector(".col-title"), "headers", ["table-title-header", ...headers].join(" "))
    }
  }

  for (const [index, key] of groupOrder.entries()) {
    const groupId = `table-group-heading-${index}`
    const groupRows = groups.get(key) ?? []
    const display = getGroupDisplayForKey(groupBy, key, areas, epicLabels, groupRows[0])
    const isCollapsed = collapsedGroups.includes(key)

    // Create group header row
    const headerRow = domEl("tr", `group-header-row${isCollapsed ? " collapsed" : ""}`)
    setAttr(headerRow, "data-group-key", key)
    setAttr(headerRow, "data-group-by", groupBy)
    const headerCell = domEl("th")
    headerCell.id = groupId
    headerCell.scope = "row"
    headerCell.colSpan = TABLE_COLUMNS.length + 2
    headerCell.className = "group-header-cell"
    setAttr(headerCell, "aria-labelledby", groupId + "-label")
    const contentDiv = domEl("div", "group-header-content")

    const toggleBtn = domEl("button")
    toggleBtn.type = "button"
    toggleBtn.className = "group-toggle"
    setAttr(toggleBtn, "aria-label", `Toggle group ${display.label}`)
    setAttr(toggleBtn, "aria-expanded", String(!isCollapsed))
    toggleBtn.append(groupDecoration("group-toggle-arrow", "▾"))

    const dotSpan = groupDecoration("group-dot")
    dotSpan.style.background = sanitizeCssColor(display.color)

    const iconSpan = groupDecoration("group-icon", display.icon)

    const labelSpan = domEl("span", "group-label")
    labelSpan.id = `${groupId}-label`
    labelSpan.textContent = display.label

    const countSpan = domEl("span", "group-count", String(groupTotals.get(key)?.count ?? 0))

    const cbWrapper = domEl("span", "group-checkbox-wrapper")
    const cb = domEl("input")
    cb.type = "checkbox"
    cb.className = "group-select-all"
    cb.dataset.groupKey = key
    setAttr(cb, "aria-label", `Select visible tasks in ${display.label} on this page`)
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
        setAttr(row, "data-sub-group-value", sk)
        if (!subGroups.has(sk)) { subGroups.set(sk, []); subOrder.push(sk) }
        subGroups.get(sk)!.push(row)
      })

      const subCollapseKey = `meitheal-table-subgroups-${groupBy}-${subGroupBy}-${key}`
      let collapsedSubs: string[] = []
      try { collapsedSubs = JSON.parse(sessionStorage.getItem(subCollapseKey) ?? "[]") } catch { /* */ }

      for (const [subIndex, sk] of subOrder.entries()) {
        const subgroupId = `${groupId}-sub-${subIndex}`
        const subRows = subGroups.get(sk) ?? []
        const subDisplay = getGroupDisplayForKey(subGroupBy, sk, areas, epicLabels, subRows[0])
        const subIsCollapsed = collapsedSubs.includes(sk)

        const subHeaderRow = domEl("tr", `group-header-row sub-group-header-row${subIsCollapsed ? " collapsed" : ""}`)
        setAttr(subHeaderRow, "data-group-key", sk)
        setAttr(subHeaderRow, "data-group-by", subGroupBy)
        setAttr(subHeaderRow, "data-parent-group-key", key)
        setAttr(subHeaderRow, "data-sub-group-collapse-key", subCollapseKey)
        subHeaderRow.id = subgroupId + "-row"
        controlledRows.push(subHeaderRow.id)
        if (isCollapsed) subHeaderRow.classList.add("group-collapsed-row")

        const subCell = domEl("th")
        subCell.id = subgroupId
        subCell.scope = "row"
        subCell.colSpan = TABLE_COLUMNS.length + 2
        subCell.className = "group-header-cell sub-group-header-cell"
        setAttr(subCell, "aria-labelledby", subgroupId + "-label")
        const subContent = domEl("div", "group-header-content")

        const subToggleBtn = domEl("button")
        subToggleBtn.type = "button"
        subToggleBtn.className = "group-toggle sub-group-toggle"
        setAttr(subToggleBtn, "aria-label", `Toggle sub-group ${subDisplay.label}`)
        setAttr(subToggleBtn, "aria-expanded", String(!subIsCollapsed))
        setAttr(subToggleBtn, "aria-controls", subRows.map(row => row.id).join(" "))
        subToggleBtn.append(groupDecoration("group-toggle-arrow", "▾"))

        const subDot = groupDecoration("group-dot")
        subDot.style.background = sanitizeCssColor(subDisplay.color)

        const subLabel = domEl("span", "group-label")
        subLabel.id = `${subgroupId}-label`
        subLabel.textContent = subDisplay.label

        const subCount = domEl("span", "group-count", String(subgroupTotals.get(JSON.stringify([key, sk]))?.count ?? 0))

        subContent.append(subToggleBtn, subDot)
        if (subGroupBy === "area") subContent.append(groupDecoration("group-icon", subDisplay.icon))
        subContent.append(subLabel, subCount)
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
    setAttr(headerCell.querySelector("button"), "aria-controls", controlledRows.join(" "))
  }

  const noResults = qs(tbody, ".no-results-row")
  tbody.replaceChildren(fragment)
  if (noResults) tbody.append(noResults)
  renderSummaryRows(tbody, groupTotals, stats.total)
}

function getGroupDisplayForKey(
  groupBy: string, key: string, areas: Map<string, AreaDisplay>, epicLabels: Map<string, string>, row?: HTMLElement,
): AreaDisplay {
  if (groupBy === "workflow") return { label: row?.dataset.workflowLabel ?? "", icon: "📋", color: "var(--accent)" }
  if (groupBy === "epic") return {
    label: epicLabels.get(key) ?? window.mI18n?.get("table.no_epic") ?? "No Epic",
    icon: "🎯", color: "var(--type-epic, #8b5cf6)",
  }
  if (groupBy === "area") {
    const area = areas.get(key)
    if (area) return area
    if (key !== "default") return {
      label: key ? window.mI18n?.get("table.unavailable_area") ?? "Unavailable Area"
        : window.mI18n?.get("recent_activity.no_area") ?? "No area",
      icon: "📋", color: "var(--accent)",
    }
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
    setAttr(header.querySelector("button"), "aria-expanded", String(!isCollapsed))

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
      const checkbox = qs<HTMLInputElement>(sibling, ".row-check")
      if (checkbox && isSelectableTableRow(sibling)) checkbox.checked = checked
      sibling = sibling.nextElementSibling
    }
    updateBulkBar()
  }, { signal })
}

function renderSummaryRows(tbody: HTMLElement, groups: Map<string, RenderGroupStats>, total: RenderGroupStats) {
  function summary(stats: RenderGroupStats, grandTotal = false) {
    const row = domEl("tr")
    row.className = grandTotal ? "grand-total-row" : "group-summary-row"
    const cell = row.insertCell()
    cell.colSpan = TABLE_COLUMNS.length + 2
    cell.className = grandTotal ? "grand-total-cell" : "group-summary-cell"
    const avgRice = stats.riceCount > 0 && stats.riceSum !== null
      ? (stats.riceSum / stats.riceCount).toFixed(1) : "—"
    const labelSpan = domEl("span", "summary-label", `${grandTotal ? "Total: " : ""}${stats.count} task${stats.count !== 1 ? "s" : ""}`)
    const sepSpan = domEl("span", "summary-separator", "·")
    const riceSpan = domEl("span", "summary-rice", `Avg RICE: ${avgRice}`)
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
    setAttr(toggle, "aria-expanded", String(expanded))
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
    const toggle = qs<HTMLButtonElement>(row, ".subtree-toggle")
    if (toggle) {
      toggle.textContent = "▸"
      setAttr(toggle, "aria-expanded", "false")
    }
    toggleChildRows(row.dataset.id ?? "", false)
  })
}

// =============================================================================
// Inline Editing
// =============================================================================

function setupInlineEditing(table: HTMLTableElement, signal: AbortSignal, refresh: () => void, replacedTitleEditors: WeakSet<HTMLElement>, writes: TableTaskWrites) {
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
      const row = cell.closest<HTMLElement>(".table-row")
      if (!row) return
      const updated = await writes.edit(row, { title })
      if (!updated || signal.aborted) return
      cell.dataset.original = title
      showToast("Title updated", "success")
      refresh()
    } catch {
      if (signal.aborted) return
      showToast("Could not confirm the change. Your input is kept.", "error")
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
    try {
      const updated = await writes.edit(row, { [field]: field === "priority" ? Number(value) : value })
      if (!updated || signal.aborted) return
      showToast(`${field} updated`, "success")
      if (field === "status") {
        row.dataset.status = value
        row.classList.toggle("row-done", value === "complete")
        void reconcileTableDeferral(row, value, signal)
        if (value === "complete") onTaskCompleted(updated)
      }
      refresh()
    } catch {
      if (signal.aborted) return
      showToast("Could not confirm the change. Your input is kept.", "error")
    }
  }, { signal })
}

function setupRowClicks(table: HTMLTableElement, signal: AbortSignal, refresh: () => void, writes: TableTaskWrites) {
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
    const intent = writes.capture(row)
    if (!intent) return
    const confirmed = await confirmDialog({
      title: "Delete task?", message: "This action cannot be undone.",
      confirmText: "Delete", variant: "danger", signal: intent.signal,
    })
    if (!confirmed || !writes.current(intent)) return
    try {
      if (!await writes.remove(row, intent) || signal.aborted) return
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
