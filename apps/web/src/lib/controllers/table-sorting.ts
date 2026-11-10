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

type SortDirection = "asc" | "desc"

export function setupSortableHeaders(
  signal: AbortSignal,
  onSort: (column: string, direction: SortDirection) => void,
  getSort: () => string | undefined,
): void {
  document.querySelectorAll<HTMLElement>("#task-table th[data-col]").forEach(header => {
    header.addEventListener("click", () => {
      const column = header.dataset.col!
      onSort(column, getSort() === `${column}-asc` ? "desc" : "asc")
    }, { signal })
  })
}

export function applyTableSort(sort: string | undefined, grouped: boolean): void {
  if (!sort) return
  const [column, direction] = sort.split("-")
  if (direction !== "asc" && direction !== "desc") return
  const headers = Array.from(document.querySelectorAll<HTMLElement>("#task-table th[data-col]"))
  const selected = headers.find(header => header.dataset.col === column)
  const tbody = document.querySelector<HTMLElement>("#task-table tbody")
  if (!selected || !tbody) return

  for (const header of headers) {
    const indicator = header.querySelector(".sort-indicator")
    if (indicator) indicator.textContent = header === selected ? (direction === "asc" ? "▲" : "▼") : ""
    if (header === selected) header.setAttribute("aria-sort", direction === "asc" ? "ascending" : "descending")
    else header.removeAttribute("aria-sort")
  }
  const compare = (a: HTMLElement, b: HTMLElement) => compareRows(a, b, column!, direction)
  if (grouped) sortRowsWithinGroups(tbody, compare)
  else sortRowsGlobally(tbody, compare)
}

function sortRowsGlobally(tbody: HTMLElement, compare: (a: HTMLElement, b: HTMLElement) => number): void {
  const rows = Array.from(tbody.querySelectorAll<HTMLElement>(".table-row"))
  const noResults = tbody.querySelector<HTMLElement>(".no-results-row")

  // Only sort root rows (depth 0), children stay with their parents
  const rootRows = rows.filter((r) => Number(r.dataset.depth ?? 0) === 0)
  const childMap = new Map<string, HTMLElement[]>()

  // Build child map
  rows.forEach((row) => {
    const parentId = row.dataset.parentId
    if (parentId && Number(row.dataset.depth) > 0) {
      if (!childMap.has(parentId)) childMap.set(parentId, [])
      childMap.get(parentId)!.push(row)
    }
  })

  rootRows.sort(compare)

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

}

function sortRowsWithinGroups(tbody: HTMLElement, compare: (a: HTMLElement, b: HTMLElement) => number): void {
  const headers = Array.from(tbody.querySelectorAll<HTMLElement>(".group-header-row"))
  headers.forEach((header) => {
    const groupRows: HTMLElement[] = []
    let sibling = header.nextElementSibling
    while (sibling instanceof HTMLElement && sibling.classList.contains("table-row")) {
      groupRows.push(sibling)
      sibling = sibling.nextElementSibling
    }
    if (groupRows.length <= 1) return
    groupRows.sort(compare)

    // Re-insert sorted rows after header
    groupRows.forEach((row) => {
      header.parentElement?.insertBefore(row, sibling as Node)
    })
  })
}

function getCellSortValue(row: HTMLElement, col: string): string | number | null {
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
      const timestamp = Date.parse(row.dataset.dueDate ?? "")
      return Number.isFinite(timestamp) ? timestamp : null
    }
    case "rice":
      return Number(row.dataset.rice ?? -1)
    default:
      return ""
  }
}

function compareRows(a: HTMLElement, b: HTMLElement, col: string, direction: SortDirection): number {
  const aValue = getCellSortValue(a, col)
  const bValue = getCellSortValue(b, col)
  if (aValue === null || bValue === null) return Number(aValue === null) - Number(bValue === null)
  const result = typeof aValue === "number" && typeof bValue === "number"
    ? aValue - bValue
    : String(aValue).localeCompare(String(bValue))
  return direction === "asc" ? result : -result
}
