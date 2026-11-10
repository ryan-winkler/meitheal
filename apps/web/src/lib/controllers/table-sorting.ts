/**
 * Table Column Sorting
 *
 * @domain tasks
 * @bounded-context tasks (view-layer controller)
 *
 * Handles sortable table headers with asc/desc toggling,
 * requesting server ordering and updating the accessible indicator.
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

export function updateTableSort(sort: string | undefined): void {
  const [column, direction] = (sort ?? "").split("-")
  const active = direction === "asc" || direction === "desc"
  for (const header of document.querySelectorAll<HTMLElement>("#task-table th[data-col]")) {
    const selected = active && header.dataset.col === column
    const indicator = header.querySelector(".sort-indicator")
    if (indicator) indicator.textContent = selected ? (direction === "asc" ? "▲" : "▼") : ""
    if (selected) header.setAttribute("aria-sort", direction === "asc" ? "ascending" : "descending")
    else header.removeAttribute("aria-sort")
  }
}
