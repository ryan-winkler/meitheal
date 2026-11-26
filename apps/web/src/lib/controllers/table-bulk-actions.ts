/**
 * Table Bulk Actions
 *
 * @domain tasks
 * @bounded-context tasks (view-layer controller)
 *
 * Handles multi-select row checkboxes, select-all,
 * bulk status/priority/area updates, bulk delete,
 * and the floating bulk action bar.
 */

import type { TableTaskWrites } from "../table-task-writes"
import { showToast } from "@lib/toast"
import { confirmDialog } from "@lib/confirm-dialog"
import { onTaskCompleted } from "@lib/gamification-hook"
import { notifyTaskCountsChanged } from "@lib/deferral-client"
import { reconcileTableDeferral } from "./table-deferral"

// ── Types ─────────────────────────────────────────────────────────────────

interface BulkDeps {
  signal: AbortSignal
  onTasksChanged: () => void
  writes: TableTaskWrites
}

// ── Public API ────────────────────────────────────────────────────────────

export function setupBulkActions(deps: BulkDeps): void {
  const bulkBar = document.getElementById("bulk-bar")
  const selectAll = document.getElementById("select-all") as HTMLInputElement | null
  const bulkStatus = document.getElementById("bulk-status") as HTMLSelectElement | null
  const bulkPriority = document.getElementById("bulk-priority") as HTMLSelectElement | null
  const bulkArea = document.getElementById("bulk-area") as HTMLSelectElement | null
  const bulkDelete = document.getElementById("bulk-delete")
  const bulkClose = document.getElementById("bulk-close")

  const table = document.getElementById("task-table")
  table?.addEventListener("change", event => {
    if ((event.target as Element).matches(".row-check")) updateBulkBar()
  }, { signal: deps.signal })

  selectAll?.addEventListener("change", () => {
    table?.querySelectorAll<HTMLInputElement>(".table-row .row-check").forEach(box => {
      box.checked = selectAll.checked && isSelectableTableRow(box.closest(".table-row"))
    })
    updateBulkBar()
  }, { signal: deps.signal })

  // Bulk status change
  bulkStatus?.addEventListener("change", async () => {
    const val = bulkStatus.value
    if (!val) return
    const ids = getSelectedIds()
    if (ids.length === 0) return

    await bulkUpdateField("status", val, ids, deps)
    bulkStatus.value = ""
  }, { signal: deps.signal })

  // Bulk priority change
  bulkPriority?.addEventListener("change", async () => {
    const val = bulkPriority.value
    if (!val) return
    const ids = getSelectedIds()
    if (ids.length === 0) return

    await bulkUpdateField("priority", Number(val), ids, deps)
    bulkPriority.value = ""
  }, { signal: deps.signal })

  // Bulk board change
  bulkArea?.addEventListener("change", async () => {
    const val = bulkArea.value
    if (!val) return
    const ids = getSelectedIds()
    if (ids.length === 0) return

    await bulkUpdateField("area_id", val, ids, deps)
    bulkArea.value = ""
  }, { signal: deps.signal })

  // Bulk delete
  bulkDelete?.addEventListener("click", async () => {
    const ids = getSelectedIds()
    if (ids.length === 0) return

    const intents = ids.flatMap(id => {
      const row = table?.querySelector<HTMLElement>(`.table-row[data-id="${CSS.escape(id)}"]`)
      const intent = row && deps.writes.capture(row)
      return row && intent ? [{ row, intent }] : []
    })
    if (intents.length !== ids.length) return
    const confirmed = await confirmDialog({
      title: `Delete ${ids.length} task${ids.length > 1 ? "s" : ""}?`,
      message: "This action cannot be undone.",
      confirmText: "Delete",
      variant: "danger",
      signal: intents[0]!.intent.signal,
    })
    if (!confirmed || intents.some(({ intent }) => !deps.writes.current(intent))) return

    let deleted = 0
    const projects: Array<string | undefined> = []
    for (const { row, intent } of intents) {
      if (!deps.writes.current(intent)) break
      if (await deps.writes.remove(row, intent)) {
        projects.push(row.dataset.projectId)
        row.remove()
        deleted++
      }
    }
    updateBulkBar()

    if (deps.signal.aborted) return
    showToast(`Deleted ${deleted} task${deleted === 1 ? "" : "s"}`, deleted > 0 ? "success" : "error")
    if (deleted > 0) {
      notifyTaskCountsChanged(...projects)
      deps.onTasksChanged()
    }
  }, { signal: deps.signal })

  // Bulk close button
  bulkClose?.addEventListener("click", () => {
    table?.querySelectorAll<HTMLInputElement>(".row-check").forEach((cb) => {
      cb.checked = false
    })
    if (selectAll) selectAll.checked = false
    updateBulkBar()
  }, { signal: deps.signal })
}

export function isSelectableTableRow(row: Element | null): boolean {
  return row instanceof HTMLTableRowElement && row.matches(".table-row:not(.group-collapsed-row)") && !row.hidden
}

function tableCheckboxes() {
  return Array.from(document.querySelectorAll<HTMLInputElement>("#task-table .row-check"))
}

export function getSelectedIds(): string[] {
  return tableCheckboxes().flatMap(box => box.checked && box.dataset.id && isSelectableTableRow(box.closest(".table-row"))
    ? [box.dataset.id] : [])
}

export function updateBulkBar(): void {
  const bulkBar = document.getElementById("bulk-bar")
  const selectedCountEl = document.getElementById("selected-count")
  const boxes = tableCheckboxes()
  const visible = boxes.filter(box => {
    const row = box.closest<HTMLElement>(".table-row")
    const selectable = isSelectableTableRow(row)
    if (!selectable) box.checked = false
    row?.classList.toggle("is-selected", selectable && box.checked)
    return selectable
  })
  const selected = visible.filter(box => box.checked)
  const selectAll = document.querySelector<HTMLInputElement>("#task-table #select-all")
  if (selectAll) {
    selectAll.checked = visible.length > 0 && selected.length === visible.length
    selectAll.indeterminate = selected.length > 0 && selected.length < visible.length
  }
  for (const box of document.querySelectorAll<HTMLInputElement>("#task-table .group-select-all")) {
    const group = visible.filter(rowBox => rowBox.closest<HTMLElement>(".table-row")?.dataset.groupValue === box.dataset.groupKey)
    const count = group.filter(rowBox => rowBox.checked).length
    box.checked = group.length > 0 && count === group.length
    box.indeterminate = count > 0 && count < group.length
  }

  if (bulkBar) {
    bulkBar.style.display = selected.length > 0 ? "flex" : "none"
    if (selected.length > 0) bulkBar.dataset.bulkOpen = "true"
    else delete bulkBar.dataset.bulkOpen
  }
  if (selectedCountEl) {
    selectedCountEl.textContent = `${selected.length} selected`
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────

async function bulkUpdateField(field: string, value: unknown, ids: string[], deps: BulkDeps): Promise<void> {
  let updated = 0
  for (const id of ids) {
    try {
      const row = document.querySelector<HTMLElement>(`#task-table .table-row[data-id="${CSS.escape(id)}"]`)
      if (!row) continue
      const updatedTask = await deps.writes.edit(row, { [field]: value })
      if (updatedTask) {
        updated++
        if (row) {
          if (field === "status") {
            row.dataset.status = String(value)
            row.classList.toggle("row-done", value === "complete")
            void reconcileTableDeferral(row, String(value), deps.signal)
            // Gamification + confetti on completion
            if (value === "complete") {
              onTaskCompleted(updatedTask)
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
          if (field === "area_id") {
            row.dataset.area = String(value)
          }
        }
      }
    } catch { /* continue */ }
  }

  if (deps.signal.aborted) return
  showToast(`Updated ${updated} task${updated === 1 ? "" : "s"}`, updated > 0 ? "success" : "error")
  if (updated > 0) deps.onTasksChanged()
}
