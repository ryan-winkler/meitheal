/**
 * kanban-context-menu.ts — "More" button context menu (delete/archive)
 *
 * @domain kanban
 * @kcs Extracted from kanban-controller.ts for decomposition.
 */

/**
 * Initialise the context menu for kanban card "More" (⋯) buttons.
 *
 * @param buildTaskApiUrl – shared URL builder from kanban-controller
 * @param __signal – AbortSignal for listener cleanup
 */
export function initContextMenu(
  buildTaskApiUrl: (taskId: string | number | null, suffix?: string) => string,
  __signal: AbortSignal,
): void {
  let activeMenu: HTMLElement | null = null

  function closeMenu() {
    if (activeMenu) { activeMenu.remove(); activeMenu = null }
  }

  document.addEventListener("click", (e) => {
    if (activeMenu && !activeMenu.contains(e.target as Node)) closeMenu()
  }, { signal: __signal })
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu()
  }, { signal: __signal })

  document.querySelectorAll<HTMLElement>(".card-more-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation()
      closeMenu()

      const id = btn.dataset.id
      if (!id) return

      const menu = document.createElement("div")
      menu.className = "kanban-context-menu"
      menu.innerHTML = `
        <button class="ctx-item ctx-delete" data-action="delete">🗑 Delete</button>
        <button class="ctx-item ctx-archive" data-action="archive">📦 Archive</button>
      `

      // Position near button
      const rect = btn.getBoundingClientRect()
      menu.style.cssText = `position:fixed;top:${rect.bottom + 4}px;left:${rect.left - 80}px;z-index:200;`
      document.body.appendChild(menu)
      activeMenu = menu

      menu.addEventListener("click", async (ev) => {
        const action = (ev.target as HTMLElement)?.closest("[data-action]")?.getAttribute("data-action")
        if (!action) return
        closeMenu()

        if (action === "delete") {
          if (!confirm("Delete this task permanently?")) return
          try {
            const res = await fetch(buildTaskApiUrl(id), { method: "DELETE" })
            if (res.ok) {
              const card = document.querySelector(`.kanban-card[data-id="${id}"]`) as HTMLElement | null
              if (card) {
                card.style.transition = "opacity 0.2s ease, transform 0.2s ease"
                card.style.opacity = "0"
                card.style.transform = "scale(0.95)"
                setTimeout(() => { card.remove(); if (typeof window.updateAllCounts === "function") window.updateAllCounts() }, 200)
              }
              if (window.showToast) window.showToast("Task deleted", "info")
            } else {
              if (window.showToast) window.showToast("Failed to delete task", "error")
            }
          } catch {
            if (window.showToast) window.showToast("Failed to delete task", "error")
          }
        } else if (action === "archive") {
          try {
            const res = await fetch(buildTaskApiUrl(id), {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ status: "complete" }),
            })
            if (res.ok) document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "kanban-archive" } }))
            else if (window.showToast) window.showToast("Failed to archive task", "error")
          } catch {
            if (window.showToast) window.showToast("Failed to archive task", "error")
          }
        }
      })
    })
  })
}
