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

import { showToast } from "@lib/toast"
import { confirmDialog } from "@lib/confirm-dialog"
import { onTaskCompleted } from "@lib/gamification-hook"
import { reconcileTableDeferral } from "./table-deferral"

// ── Types ─────────────────────────────────────────────────────────────────

interface BulkDeps {
  signal: AbortSignal
  applyAllFilters: () => void
  updateGroupCounts: () => void
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

    await bulkUpdateField("status", val, ids, deps)
    bulkStatus.value = ""
  })

  // Bulk priority change
  bulkPriority?.addEventListener("change", async () => {
    const val = bulkPriority.value
    if (!val) return
    const ids = getSelectedIds()
    if (ids.length === 0) return

    await bulkUpdateField("priority", Number(val), ids, deps)
    bulkPriority.value = ""
  })

  // Bulk board change
  bulkArea?.addEventListener("change", async () => {
    const val = bulkArea.value
    if (!val) return
    const ids = getSelectedIds()
    if (ids.length === 0) return

    await bulkUpdateField("area_id", val, ids, deps)
    bulkArea.value = ""
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
        const res = await fetch(`/api/tasks/${id}`, { method: "DELETE", signal: deps.signal })
        if (res.ok) {
          const row = document.querySelector<HTMLElement>(`.table-row[data-id="${id}"]`)
          row?.remove()
          deleted++
        }
      } catch { /* continue */ }
    }

    showToast(`Deleted ${deleted} task${deleted > 1 ? "s" : ""}`, "success")
    updateBulkBar()
    deps.updateGroupCounts()
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

export function getSelectedIds(): string[] {
  const ids: string[] = []
  document.querySelectorAll<HTMLInputElement>(".row-check:checked").forEach((cb) => {
    const id = cb.dataset.id
    if (id) ids.push(id)
  })
  return ids
}

export function updateBulkBar(): void {
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

// ── Internal helpers ──────────────────────────────────────────────────────

async function bulkUpdateField(field: string, value: unknown, ids: string[], deps: BulkDeps): Promise<void> {
  let updated = 0
  for (const id of ids) {
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
        signal: deps.signal,
      })
      if (res.ok) {
        updated++
        const row = document.querySelector<HTMLElement>(`.table-row[data-id="${id}"]`)
        if (row) {
          if (field === "status") {
            row.dataset.status = String(value)
            row.classList.toggle("row-done", value === "complete")
            void reconcileTableDeferral(row, String(value), deps.signal)
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
          if (field === "area_id") {
            row.dataset.area = String(value)
          }
        }
      }
    } catch { /* continue */ }
  }

  showToast(`Updated ${updated} task${updated > 1 ? "s" : ""}`, "success")
  deps.applyAllFilters()
}
