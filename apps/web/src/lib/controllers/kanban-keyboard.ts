/**
 * kanban-keyboard.ts — Keyboard shortcuts, search, quick-add, WIP limits, board navigation
 *
 * @domain kanban
 * @kcs Extracted from kanban-controller.ts for decomposition.
 *      Combines keyboard shortcuts (N/C), WIP limit indicators,
 *      inline quick-add, search filter, and arrow-key board navigation.
 */
import { getSelectedAreaId } from "@lib/area-selector-controller"
import { singleKeyShortcutsEnabled } from "@lib/single-key-shortcuts"
import { createClientLogger } from "@lib/client-logger"

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
      const toggles = board.querySelectorAll<HTMLElement>(".swimlane-group:not([hidden]) .swimlane-toggle")
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
      const existing = btn.previousElementSibling
      if (existing?.classList.contains("kanban-inline-add")) {
        existing.querySelector("input")?.focus()
        return
      }

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
        const areaId = getSelectedAreaId()

        let uncertain = false
        try {
          const res = await fetch("/api/tasks", {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": retryKey },
            body: JSON.stringify({ title, status: btn.dataset.status, task_type: btn.dataset.taskType, area_id: areaId || undefined }),
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

  // T-1914: Keyboard navigation for kanban board
  ;(() => {
    // Swimlane collapse event delegation
    board.addEventListener("click", (e) => {
      const target = e.target as HTMLElement
      const header = target.closest(".swimlane-header")
      if (header && !target.closest("button")) {
        const group = header.closest(".swimlane-group")
        if (!group) return
        const cardsEl = group.querySelector(".swimlane-cards")
        const toggle = header.querySelector(".swimlane-toggle")
        if (!cardsEl) return
        const isCollapsed = cardsEl.classList.toggle("collapsed")
        if (toggle) {
          toggle.classList.toggle("collapsed", isCollapsed)
          toggle.textContent = isCollapsed ? "▶" : "▼"
        }
        group.classList.toggle("swimlane-collapsed", isCollapsed)
        const type = (group as HTMLElement).dataset.swimlaneType || (group as HTMLElement).dataset.swimlaneValue || "dynamic"
        localStorage.setItem(`meitheal-swimlane-${type}`, isCollapsed ? "collapsed" : "expanded")
      }
    }, { signal })

    const visibleEntries = (column: Element) =>
      Array.from(column.querySelectorAll<HTMLButtonElement>(".card-open-btn"))
        .filter(btn => btn.getClientRects().length > 0 && !btn.closest(".swimlane-cards.collapsed"))

    board.addEventListener("keydown", (e) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const entry = (e.target as HTMLElement).closest<HTMLButtonElement>(".card-open-btn")
      const column = entry?.closest(".kanban-column")
      if (!entry || !column) return

      let next: HTMLButtonElement | undefined
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const entries = visibleEntries(column)
        const step = e.key === "ArrowDown" ? 1 : -1
        next = entries[entries.indexOf(entry) + step]
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const columns = Array.from(board.querySelectorAll(".kanban-column"))
        const rtl = getComputedStyle(board).direction === "rtl"
        const step = (e.key === "ArrowRight" ? 1 : -1) * (rtl ? -1 : 1)
        for (let index = columns.indexOf(column) + step; index >= 0 && index < columns.length; index += step) {
          const adjacent = columns[index]
          if (!adjacent) break
          next = visibleEntries(adjacent)[0]
          if (next) break
        }
      } else {
        return
      }

      e.preventDefault()
      next?.focus({ preventScroll: true })
      next?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" })
    }, { signal })
  })()
}
