/**
 * kanban-keyboard.ts — Keyboard shortcuts, search, quick-add, WIP limits, board navigation
 *
 * @domain kanban
 * @kcs Extracted from kanban-controller.ts for decomposition.
 *      Combines keyboard shortcuts (N/C), WIP limit indicators,
 *      inline quick-add, search filter, and arrow-key board navigation.
 */
import { createClientLogger } from "@lib/client-logger"
import { escapeHtml } from "@lib/safe-html"

const log = createClientLogger("kanban:keyboard")

/**
 * Initialise keyboard shortcuts, search, quick-add, WIP indicators, and board navigation.
 *
 * @param __signal – AbortSignal for listener cleanup
 */
export function initKeyboardAndSearch(__signal: AbortSignal): void {
  // Keyboard shortcuts for kanban (N = new task, C = collapse all swimlanes)
  document.addEventListener("keydown", (e) => {
    // Skip if user is typing in an input, textarea, or contenteditable
    const tag = document.activeElement?.tagName?.toLowerCase()
    if (tag === "input" || tag === "textarea" || tag === "select") return
    if (document.activeElement?.getAttribute("contenteditable") === "true") return

    // N = open quick-add in first visible column
    if (e.key === "n" || e.key === "N") {
      e.preventDefault()
      const firstBtn = document.querySelector(".kanban-add-btn")
      if (firstBtn) (firstBtn as HTMLElement).click()
    }

    // C = toggle collapse all swimlane groups
    if (e.key === "c" || e.key === "C") {
      e.preventDefault()
      const toggles = document.querySelectorAll(".swimlane-toggle")
      if (toggles.length === 0) return
      // Determine action: if most are open, collapse all; else expand all
      const openCount = document.querySelectorAll(".swimlane-group:not(.collapsed)").length
      const shouldCollapse = openCount > toggles.length / 2
      toggles.forEach((btn) => {
        const group = btn.closest(".swimlane-group")
        if (shouldCollapse && !group?.classList.contains("collapsed")) (btn as HTMLElement).click()
        if (!shouldCollapse && group?.classList.contains("collapsed")) (btn as HTMLElement).click()
      })
    }
  }, { signal: __signal })

  // WIP limit visual indicator on column badge counts
  document.querySelectorAll<HTMLElement>(".kanban-column").forEach((col) => {
    const wipLimit = parseInt(col.dataset.wipLimit || "0", 10)
    if (wipLimit <= 0) return
    const countBadge = col.querySelector(".kanban-count")
    if (!countBadge) return
    const count = parseInt(countBadge.textContent || "0", 10)
    if (count >= wipLimit) {
      countBadge.classList.add("wip-over")
    } else if (count >= wipLimit * 0.8) {
      countBadge.classList.add("wip-warning")
    }
  })

  // Quick add from kanban column — uses inline form, not prompt()
  document.querySelectorAll<HTMLElement>(".kanban-add-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      // If inline form already exists, focus it
      const existing = btn.parentElement?.querySelector(".kanban-inline-add")
      if (existing) {
        existing.querySelector("input")?.focus()
        return
      }

      const status = btn.dataset.status
      const taskType = btn.dataset.taskType
      const form = document.createElement("div")
      form.className = "kanban-inline-add"
      form.innerHTML = `
        <input type="text" class="form-input quick-add-input" placeholder="Task title..." aria-label="New task title" autofocus />
        <button type="button" class="btn btn-primary quick-add-btn">Add</button>
      `
      btn.parentElement?.insertBefore(form, btn)
      btn.classList.add("hidden")

      const input = form.querySelector<HTMLInputElement>("input")
      const addBtn = form.querySelector<HTMLButtonElement>("button")
      input?.focus()

      async function submitTask() {
        const title = input!.value.trim()
        if (!title) {
          cleanup()
          return
        }
        try {
          // P1-2: Double-submit prevention
          addBtn!.disabled = true
          addBtn!.classList.add("btn-loading")
          const payload: Record<string, string | undefined> = { title, status }
          if (taskType) payload.task_type = taskType
          const res = await fetch(
            "/api/tasks",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            },
          )
          if (res.ok) document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "kanban-lane-add" } }))
          else {
            addBtn!.disabled = false
            addBtn!.classList.remove("btn-loading")
          }
        } catch (err) {
          log.warn("Quick-add task failed", err)
          addBtn!.disabled = false
          addBtn!.classList.remove("btn-loading")
        }
      }

      function cleanup() {
        form.remove()
        btn.classList.remove("hidden")
      }

      addBtn?.addEventListener("click", submitTask)
      input?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault()
          submitTask()
        }
        if (e.key === "Escape") {
          cleanup()
        }
      })
      input?.addEventListener("blur", () => {
        // Delay to allow button click
        setTimeout(() => {
          if (!form.contains(document.activeElement)) cleanup()
        }, 200)
      })
    })
  })

  // Header "+ New Task" button → open the full New Task modal dialog
  document
    .getElementById("kanban-new-task-btn")
    ?.addEventListener("click", () => {
      if (typeof window.openNewTaskModal === "function") {
        window.openNewTaskModal()
      }
    })

  // T-1907: Search filters Kanban cards in real-time
  ;(() => {
    const searchInput = document.querySelector(".search-input")
    if (!searchInput) return

    searchInput.addEventListener("input", () => {
      const query = (searchInput as HTMLInputElement).value.toLowerCase().trim()
      const cards = document.querySelectorAll(".kanban-card")

      cards.forEach((card) => {
        const title = ((card as HTMLElement).dataset.title || "").toLowerCase()
        const desc = ((card as HTMLElement).dataset.desc || "").toLowerCase()
        const match = !query || title.includes(query) || desc.includes(query)
        ;(card as HTMLElement).style.display = match ? "" : "none"

        // Highlight matching text in title
        const titleEl = card.querySelector(".kanban-card-title .kanban-title-text")
        if (titleEl && !titleEl.hasAttribute("contenteditable")) {
          const originalTitle = (card as HTMLElement).dataset.title || ""
          if (query && match && title.includes(query)) {
            const idx = title.indexOf(query)
            const before = originalTitle.substring(0, idx)
            const matched = originalTitle.substring(idx, idx + query.length)
            const after = originalTitle.substring(idx + query.length)
            titleEl.innerHTML = `${escapeHtml(before)}<mark class="search-highlight">${escapeHtml(matched)}</mark>${escapeHtml(after)}`
          } else {
            titleEl.textContent = originalTitle
          }
        }
      })

      window.updateAllCounts?.()
    })
  })()

  // T-1914: Keyboard navigation for kanban board
  ;(() => {
    const board = document.querySelector(".kanban-board")
    if (!board) return

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
    })

    let focusedCard: HTMLElement | null = null

    board.addEventListener("keydown", (e) => {
      const cards = Array.from(board.querySelectorAll(".kanban-card")) as HTMLElement[]
      if (!cards.length) return

      if (!focusedCard || !document.contains(focusedCard)) {
        focusedCard = cards[0] ?? null
      }
      if (!focusedCard) return

      const currentCol = focusedCard.closest(".kanban-column")
      if (!currentCol) return
      const colCards = Array.from(
        currentCol.querySelectorAll(".kanban-card"),
      ) as HTMLElement[]
      const colIdx = colCards.indexOf(focusedCard)
      const columns = Array.from(board.querySelectorAll(".kanban-column"))
      const colPos = columns.indexOf(currentCol)

      let nextCard: HTMLElement | null = null

      switch ((e as KeyboardEvent).key) {
        case "ArrowDown":
          e.preventDefault()
          nextCard = colCards[colIdx + 1] ?? colCards[0] ?? null
          break
        case "ArrowUp":
          e.preventDefault()
          nextCard = colCards[colIdx - 1] ?? colCards[colCards.length - 1] ?? null
          break
        case "ArrowRight": {
          e.preventDefault()
          const nextCol = columns[colPos + 1] ?? columns[0]
          const nextColCards = nextCol?.querySelectorAll(".kanban-card")
          nextCard = (nextColCards?.[0] as HTMLElement) ?? null
          break
        }
        case "ArrowLeft": {
          e.preventDefault()
          const prevCol = columns[colPos - 1] ?? columns[columns.length - 1]
          const prevColCards = prevCol?.querySelectorAll(".kanban-card")
          nextCard = (prevColCards?.[0] as HTMLElement) ?? null
          break
        }
        case "Enter":
          e.preventDefault()
          if (focusedCard.dataset.id && typeof window.openTaskDetail === "function") {
            window.openTaskDetail(focusedCard.dataset.id)
          }
          return
      }

      if (nextCard && focusedCard) {
        focusedCard.classList.remove("kb-focused")
        focusedCard = nextCard
        focusedCard.classList.add("kb-focused")
        focusedCard.scrollIntoView({ block: "nearest" })
      }
    })

    // Focus first card when board gets focus
    board.addEventListener("focus", () => {
      const firstCard = board.querySelector(".kanban-card") as HTMLElement | null
      if (firstCard) {
        focusedCard = firstCard
        focusedCard.classList.add("kb-focused")
      }
    })

    board.addEventListener("blur", () => {
      if (focusedCard) focusedCard.classList.remove("kb-focused")
    })
  })()
}
