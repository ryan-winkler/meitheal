import type { ListenerManager } from "../managed-listeners"
import { taskApi } from "../task-api-client"
import { showTaskBatchResult } from "../task-batch-feedback"
import { confirmDialog } from "../confirm-dialog"
import { onTaskCompleted } from "../gamification-hook"

interface BatchRetry {
  url: string
  action: string
  ids: string[]
  saved: number
  attempted: number
}

export function setupBatchUI(container: HTMLElement, lm: ListenerManager) {
  const batchBtn = container.querySelector<HTMLButtonElement>("#batch-mode-toggle")
  const bar = container.querySelector<HTMLElement>("#batch-action-bar")
  if (!batchBtn || !bar) return () => {}

  // The current history entry carries the failed selection through Today's refresh.
  let retry: BatchRetry | undefined
  const previous = history.state?.meithealTodayBatch as BatchRetry | undefined
  if (previous) {
    try {
      history.replaceState({ ...history.state, meithealTodayBatch: null }, "")
      if (previous.url === location.href) retry = previous
    } catch { /* Leave the current view usable if history is unavailable. */ }
  }
  const selected = new Set(retry?.ids)
  let batchMode = selected.size > 0
  let pending = false

  batchBtn.hidden = false
  const count = bar.querySelector("span")!
  const buttons = [batchBtn, ...bar.querySelectorAll("button")]

  function syncBox(box: HTMLInputElement) {
    box.hidden = !batchMode
    box.checked = selected.has(box.dataset.id!)
    box.disabled = pending
  }

  function addBatchCheckboxes(scope: HTMLElement) {
    for (const row of scope.querySelectorAll<HTMLElement>(".tli[data-id]")) {
      let box = row.querySelector<HTMLInputElement>(".tli__batch-cb")
      if (!box) {
        box = document.createElement("input")
        box.type = "checkbox"
        box.className = "tli__batch-cb"
        box.dataset.id = row.dataset.id
        box.setAttribute("aria-label", "Select for batch action")
        row.prepend(box)
      }
      syncBox(box)
    }
  }

  function syncBar() {
    bar.hidden = !batchMode || !selected.size
    count.textContent = pending
      ? (window.mI18n?.get("common.saving") ?? "Saving…")
      : `${selected.size} selected`
  }

  function syncSelection() {
    batchBtn.setAttribute("aria-pressed", String(batchMode))
    container.classList.toggle("batch-mode", batchMode)
    for (const box of container.querySelectorAll<HTMLInputElement>(".tli__batch-cb")) syncBox(box)
    syncBar()
  }

  function setPending(value: boolean) {
    pending = value
    for (const button of buttons) button.setAttribute("aria-disabled", String(value))
    syncSelection()
  }

  lm.on(batchBtn, "click", () => {
    if (pending) return
    batchMode = !batchMode
    selected.clear()
    syncSelection()
  })

  lm.on(container, "change", (event: Event) => {
    const box = event.target
    if (!(box instanceof HTMLInputElement) || !box.matches(".tli__batch-cb") || pending || !box.dataset.id) return
    const id = box.dataset.id
    if (box.checked) selected.add(id)
    else selected.delete(id)
    for (const copy of container.querySelectorAll<HTMLInputElement>(`.tli__batch-cb[data-id="${CSS.escape(id)}"]`)) syncBox(copy)
    syncBar()
  })

  lm.on(bar, "click", async (event: Event) => {
    const action = (event.target as Element).closest<HTMLButtonElement>("button")?.value
    if (!action || pending || !selected.size) return
    if (action === "deselect") {
      selected.clear()
      syncSelection()
      batchBtn.focus()
      return
    }

    const ids = [...selected]
    setPending(true)
    if (action === "delete" && !await confirmDialog({
      title: `Delete ${ids.length} tasks?`,
      message: "This action cannot be undone.",
      variant: "danger",
      confirmText: "Delete All",
      signal: lm.signal,
    })) {
      if (!lm.disposed) setPending(false)
      return
    }
    if (lm.disposed) return

    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const patch = action === "complete" ? { status: "complete" } : { due_date: tomorrow.toISOString().slice(0, 10) }
    const results = await Promise.allSettled(ids.map(id => action === "delete" ? taskApi.deleteTask(id) : taskApi.updateTask(id, patch)))
    if (lm.disposed) return

    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        selected.delete(ids[index]!)
        if (action === "complete") void onTaskCompleted(result.value)
      }
    }
    const saved = ids.length - selected.size
    const message = action === "complete" ? "common.task_completed" : action === "snooze" ? "common.task_snoozed" : "common.task_deleted"
    const report = () => showTaskBatchResult(saved, ids.length, message)
    if (saved === 0 || saved === ids.length) report()
    if (saved === 0) {
      setPending(false)
      return
    }

    lm.onTimeout(() => {
      if (selected.size) {
        try {
          history.replaceState({ ...history.state, meithealTodayBatch: { url: location.href, action, ids: [...selected], saved, attempted: ids.length } }, "")
        } catch {
          report()
          setPending(false)
          return
        }
      }
      document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: `today-batch-${action}` } }))
    }, 500)
  })

  addBatchCheckboxes(container)
  syncSelection()
  if (retry) {
    buttons.find(button => button.value === retry.action)?.focus({ preventScroll: true })
    showTaskBatchResult(retry.saved, retry.attempted, "")
  }
  return addBatchCheckboxes
}
