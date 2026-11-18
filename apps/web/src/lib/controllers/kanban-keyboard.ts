import { initKanbanNavigation } from "./kanban-navigation"
/**
 * kanban-keyboard.ts — Keyboard shortcuts, search, quick-add, WIP limits, board navigation
 *
 * @domain kanban
 * @kcs Extracted from kanban-controller.ts for decomposition.
 *      Combines keyboard shortcuts (N/C), WIP limit indicators,
 *      inline quick-add, search filter, and arrow-key board navigation.
 */
import { taskCapturePlacement } from "@lib/task-capture-placement"
import { getSelectedAreaId } from "@lib/area-selector-controller"
import { singleKeyShortcutsEnabled } from "@lib/single-key-shortcuts"
import { createClientLogger } from "@lib/client-logger"
import { showToast } from "@lib/toast"

const log = createClientLogger("kanban:keyboard")

/**
 * Initialise keyboard shortcuts, search, quick-add, WIP indicators, and board navigation.
 *
 * @param signal – AbortSignal for listener cleanup
 */
export function initKeyboardAndSearch(signal: AbortSignal): void {
  const board = document.querySelector<HTMLElement>(".kanban-board")
  if (!board) return

  // Keep single-letter shortcuts inside the board, away from forms and dialogs.
  board.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement
    if (e.defaultPrevented || e.isComposing || e.repeat || e.ctrlKey || e.altKey || e.metaKey ||
        target.closest("input, textarea, select, [contenteditable]")) return
    if (!singleKeyShortcutsEnabled()) return

    // N = open quick-add in first visible column
    if (e.key === "n" || e.key === "N") {
      e.preventDefault()
      const column = target.closest(".kanban-column")
      column?.querySelector<HTMLButtonElement>(".kanban-column > .kanban-add-btn")?.click()
    }

    // C = toggle collapse all swimlane groups
    if (e.key === "c" || e.key === "C") {
      const toggles = board.querySelectorAll<HTMLButtonElement>(".swimlane-group:not([hidden]) .swimlane-header")
      // Without swimlanes, leave the key to the global shortcut instead of swallowing it.
      if (toggles.length === 0) return
      e.preventDefault()
      // Determine action: if most are open, collapse all; else expand all
      const openCount = board.querySelectorAll(".swimlane-group:not([hidden]):not(.swimlane-collapsed)").length
      const shouldCollapse = openCount > toggles.length / 2
      toggles.forEach((btn) => {
        const group = btn.closest(".swimlane-group")
        if (shouldCollapse && !group?.classList.contains("swimlane-collapsed")) btn.click()
        if (!shouldCollapse && group?.classList.contains("swimlane-collapsed")) btn.click()
      })
    }
  }, { signal })

  board.querySelectorAll<HTMLButtonElement>(".kanban-add-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (getSelectedAreaId() && !document.querySelector('#area-selector-dropdown [aria-selected="true"]')) {
        document.getElementById("area-selector-trigger")?.focus()
        showToast("kanban.quick_add_area_unavailable", "warning")
        return
      }
      const existing = btn.previousElementSibling
      if (existing?.classList.contains("kanban-inline-add")) {
        existing.querySelector("input")?.focus()
        return
      }

      const placement = taskCapturePlacement()
      const form = document.createElement("form")
      form.className = "kanban-inline-add"
      form.noValidate = true
      const input = document.createElement("input")
      input.className = "form-input quick-add-input"
      const titleLabel = window.mI18n?.get("kanban.quick_add_title") ?? "New task title"
      input.placeholder = titleLabel
      input.setAttribute("aria-label", titleLabel)
      const addBtn = document.createElement("button")
      addBtn.type = "submit"
      addBtn.className = "btn btn-primary quick-add-btn"
      const addLabel = window.mI18n?.get("kanban.quick_add_save") ?? "Add"
      addBtn.textContent = addLabel
      const error = document.createElement("div")
      error.className = "quick-add-error"
      error.setAttribute("role", "alert")
      const cancel = document.createElement("button")
      cancel.type = "button"
      cancel.className = "btn quick-add-cancel"
      cancel.textContent = window.mI18n?.get("common.cancel") ?? "Cancel"
      form.append(input, addBtn, error, cancel)
      btn.before(form)
      btn.hidden = true
      input.focus()

      let saving = false
      const retryKey = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte =>
        byte.toString(16).padStart(2, "0")
      ).join("")
      function showError(key: string, fallback: string, invalid = false) {
        error.textContent = window.mI18n?.get(`kanban.${key}`) ?? fallback
        if (invalid) input.setAttribute("aria-invalid", "true")
        if (form.contains(document.activeElement) || document.activeElement === document.body) input.focus()
      }

      form.addEventListener("submit", async (e) => {
        e.preventDefault()
        if (saving) return
        const title = input.value.trim()
        if (!title) {
          showError("quick_add_required", "Enter a task title.", true)
          return
        }
        if (title.length > 500) {
          showError("quick_add_too_long", "Use 500 characters or fewer.", true)
          return
        }

        saving = true
        addBtn.disabled = true
        cancel.disabled = true
        input.readOnly = true
        addBtn.textContent = window.mI18n?.get("kanban.quick_add_saving") ?? "Adding…"
        error.textContent = ""

        let uncertain = false
        try {
          const res = await fetch("/api/tasks", {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": retryKey },
            body: JSON.stringify({ title, status: btn.dataset.status, task_type: btn.dataset.taskType, ...(placement ? { placement } : {}) }),
          })
          if (res.ok) {
            form.remove()
            btn.hidden = false
            document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "kanban-lane-add" } }))
            return
          }
        } catch (err) {
          uncertain = true
          log.warn("Quick-add task failed", err)
        }

        saving = false
        input.readOnly = false
        addBtn.disabled = false
        cancel.disabled = false
        addBtn.textContent = addLabel
        if (uncertain) {
          showError("quick_add_unknown", "Couldn’t confirm the save. Your title is still here. Check the lane before retrying.")
        } else {
          showError("quick_add_failed", "Couldn’t add the task. Your title is still here. Try again.")
        }
      }, { signal })

      input.addEventListener("input", () => {
        error.textContent = ""
        input.removeAttribute("aria-invalid")
      }, { signal })
      function dismiss() {
        form.remove()
        btn.hidden = false
        btn.focus()
      }
      cancel.addEventListener("click", dismiss, { signal })
      form.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" || saving) return
        e.preventDefault()
        e.stopPropagation()
        dismiss()
      }, { signal })
    }, { signal })
  })

  initKanbanNavigation(board, signal)
}
