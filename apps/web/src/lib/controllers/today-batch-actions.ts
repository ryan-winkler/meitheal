/**
 * Today Batch Actions — G30
 *
 * @domain tasks
 * @bounded-context tasks (presentation)
 *
 * Multi-select mode with batch complete/snooze/delete operations.
 */

import type { ListenerManager } from "../managed-listeners"
import { taskApi } from "../task-api-client"
import { showToast } from "../toast"
import { confirmDialog } from "../confirm-dialog"
import { onTaskCompleted } from "../gamification-hook"

let batchMode = false
const batchSelected = new Set<string>()

export function setupBatchUI(
  container: HTMLElement,
  lm: ListenerManager,
): void {
  // Add batch mode toggle button next to filter bar
  const filterBar = container.querySelector("#today-filter-bar")
  if (!filterBar) return

  const batchBtn = document.createElement("button")
  batchBtn.type = "button"
  batchBtn.className = "btn btn-sm batch-toggle-btn"
  batchBtn.id = "batch-mode-toggle"
  batchBtn.title = "Toggle multi-select mode"
  batchBtn.textContent = "☑"
  batchBtn.style.cssText = "flex-shrink: 0; font-size: 14px;"
  filterBar.appendChild(batchBtn)

  lm.on(batchBtn, "click", () => {
    batchMode = !batchMode
    batchBtn.classList.toggle("active", batchMode)
    container.classList.toggle("batch-mode", batchMode)
    batchSelected.clear()
    updateBatchBar(container, lm)
    // Toggle batch checkboxes visibility
    container.querySelectorAll<HTMLElement>(".tli__batch-cb").forEach(cb => {
      cb.style.display = batchMode ? "inline-block" : "none"
    })
  })

  // Listen for batch checkbox changes (dynamically added)
  lm.on(container, "change", (e: Event) => {
    const target = e.target as HTMLInputElement
    if (!target.classList.contains("tli__batch-cb")) return
    const id = target.dataset.id
    if (!id) return
    if (target.checked) {
      batchSelected.add(id)
    } else {
      batchSelected.delete(id)
    }
    updateBatchBar(container, lm)
  })

  // Inject batch checkboxes into existing task items
  container.querySelectorAll<HTMLElement>(".tli").forEach(el => {
    const id = el.dataset.id
    if (!id) return
    const cb = document.createElement("input")
    cb.type = "checkbox"
    cb.className = "tli__batch-cb"
    cb.dataset.id = id
    cb.style.cssText = "display: none; margin-right: 6px; accent-color: var(--accent);"
    cb.title = "Select for batch action"
    el.prepend(cb)
  })
}

function updateBatchBar(container: HTMLElement, lm: ListenerManager): void {
  let bar = container.querySelector("#batch-action-bar") as HTMLElement | null

  if (!batchMode || batchSelected.size === 0) {
    bar?.remove()
    return
  }

  if (!bar) {
    bar = document.createElement("div")
    bar.id = "batch-action-bar"
    bar.className = "batch-action-bar"
    bar.style.cssText = `
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      z-index: 100; background: var(--bg-card, #1e293b); border: 1px solid var(--border);
      border-radius: var(--radius-md, 12px); padding: 10px 16px; display: flex;
      gap: 10px; align-items: center; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      backdrop-filter: blur(12px);
    `
    container.appendChild(bar)
  }

  bar.innerHTML = `
    <span style="font-size: 13px; color: var(--text-muted); white-space: nowrap;">${batchSelected.size} selected</span>
    <button type="button" class="btn btn-sm batch-complete-btn" title="Complete selected">✓ Complete</button>
    <button type="button" class="btn btn-sm batch-snooze-btn" title="Snooze selected +1 day">⏰ Snooze</button>
    <button type="button" class="btn btn-sm batch-delete-btn" style="color: var(--danger);" title="Delete selected">🗑 Delete</button>
    <button type="button" class="btn btn-sm batch-deselect-btn" title="Deselect all">✕</button>
  `

  const batchCompleteBtn = bar.querySelector(".batch-complete-btn")
  if (batchCompleteBtn) lm.on(batchCompleteBtn, "click", async () => {
    const ids = Array.from(batchSelected)
    try {
      const completed = await Promise.all(ids.map(id => taskApi.updateTask(id, { status: "complete" })))
      showToast("common.task_completed")
      completed.forEach(result => onTaskCompleted(result))
      setTimeout(() => document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "today-batch-complete" } })), 500)
    } catch { showToast("common.failed", "error") }
  })

  const batchSnoozeBtn = bar.querySelector(".batch-snooze-btn")
  if (batchSnoozeBtn) lm.on(batchSnoozeBtn, "click", async () => {
    const ids = Array.from(batchSelected)
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const dateStr = tomorrow.toISOString().split("T")[0]!
    try {
      await Promise.all(ids.map(id => taskApi.updateTask(id, { due_date: dateStr })))
      showToast("common.task_snoozed")
      setTimeout(() => document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "today-batch-snooze" } })), 500)
    } catch { showToast("common.failed", "error") }
  })

  const batchDeleteBtn = bar.querySelector(".batch-delete-btn")
  if (batchDeleteBtn) lm.on(batchDeleteBtn, "click", async () => {
    const ids = Array.from(batchSelected)
    const ok = await confirmDialog({
      title: `Delete ${ids.length} tasks?`,
      message: "This action cannot be undone.",
      variant: "danger",
      confirmText: "Delete All",
    })
    if (!ok) return
    try {
      await Promise.all(ids.map(id => taskApi.deleteTask(id)))
      showToast("common.task_deleted")
      setTimeout(() => document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "today-batch-delete" } })), 500)
    } catch { showToast("common.failed", "error") }
  })

  const batchDeselectBtn = bar.querySelector(".batch-deselect-btn")
  if (batchDeselectBtn) lm.on(batchDeselectBtn, "click", () => {
    batchSelected.clear()
    container.querySelectorAll<HTMLInputElement>(".tli__batch-cb").forEach(cb => {
      cb.checked = false
    })
    updateBatchBar(container, lm)
  })
}
