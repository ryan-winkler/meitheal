/**
 * Table Column Sorting
 *
 * @domain tasks
 * @bounded-context tasks (view-layer controller)
 *
 * Handles sortable table headers with asc/desc toggling,
 * global and within-group sorting, indicator display,
 * and filter state persistence.
 */

import {
  saveFilterState,
  DEFAULT_SORT,
  type FilterState,
} from "@lib/filter-state"

// ── Types ─────────────────────────────────────────────────────────────────

interface SortDeps {
  currentFilterState: Partial<FilterState>
  currentGroupBy: string
  setupRowClicks: () => void
  setupInlineEditing: () => void
}

// ── Public API ────────────────────────────────────────────────────────────

export function setupSortableHeaders(deps: SortDeps): void {
  let currentSortCol = ""
  let currentSortDir: "asc" | "desc" = "asc"

  // Restore sort from filter state
  const savedSort = deps.currentFilterState.sort ?? DEFAULT_SORT
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
      deps.currentFilterState.sort = `${col}-${currentSortDir}`
      saveFilterState(deps.currentFilterState)

      // Sort rows (within groups if grouped, global if not)
      sortTableRows(col, currentSortDir, isNumeric, deps)
    })
  })
}

// ── Internal helpers ──────────────────────────────────────────────────────

function sortTableRows(col: string, dir: "asc" | "desc", isNumeric: boolean, deps: SortDeps): void {
  const tbody = document.querySelector<HTMLElement>("#task-table tbody")
  if (!tbody) return

  if (deps.currentGroupBy !== "none") {
    sortRowsWithinGroups(tbody, col, dir, isNumeric)
  } else {
    sortRowsGlobally(tbody, col, dir, isNumeric, deps)
  }
}

function sortRowsGlobally(tbody: HTMLElement, col: string, dir: "asc" | "desc", isNumeric: boolean, deps: SortDeps): void {
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

  tbody.replaceChildren()
  tbody.appendChild(fragment)

  // Re-setup row event listeners
  deps.setupRowClicks()
  deps.setupInlineEditing()
}

function sortRowsWithinGroups(tbody: HTMLElement, col: string, dir: "asc" | "desc", isNumeric: boolean): void {
  const headers = Array.from(tbody.querySelectorAll<HTMLElement>(".group-header-row"))
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
