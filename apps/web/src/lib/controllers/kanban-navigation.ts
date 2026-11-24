/** Arrow-key movement is shared by every Kanban scope. */
export function initKanbanNavigation(board: HTMLElement, signal: AbortSignal): void {
    const visibleEntries = (column: Element) =>
      Array.from(column.querySelectorAll<HTMLButtonElement>(".card-open-btn"))
        .filter(btn => btn.getClientRects().length > 0)

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
}
