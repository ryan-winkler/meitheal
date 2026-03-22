/**
 * kanban-user-filter.ts — Jira-style assignee pill filter
 *
 * @domain kanban
 * @kcs Extracted from kanban-controller.ts for decomposition.
 *      Renders user avatar pills, persists filter state, and applies
 *      visibility classes to kanban cards based on assigned user.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Initialise the user filter pill bar for Kanban.
 */
export async function initUserFilter(signal: AbortSignal): Promise<void> {
  const container = document.getElementById("kanban-user-filters")
  if (!container) return

  try {
    const res = await fetch("/api/users")
    if (!res.ok) return
    const data = await res.json()
    const users: any[] = data.users || []

    // Render user pills dynamically
    users.forEach((u) => {
      const btn = document.createElement("button")
      btn.type = "button"
      btn.className = "user-filter-btn"
      btn.dataset.user = u.id
      btn.title = u.display_name || u.name || u.id

      const avatar = document.createElement("span")
      avatar.className = "user-avatar-pill"
      avatar.style.background = u.color || "var(--accent)"
      avatar.textContent = (u.display_name || u.name || "?")
        .slice(0, 2)
        .toUpperCase()
      btn.appendChild(avatar)
      // No text label — initials avatar + title tooltip is sufficient
      // (matches Teamhood/Jira/Linear initials-only pattern)

      container.appendChild(btn)
    })
  } catch {
    /* users API unavailable — filter stays with All/Unassigned */
  }

  // Restore saved filter
  const saved =
    localStorage.getItem("meitheal-kanban-user-filter") || "all"
  const savedBtn = container.querySelector(
    `[data-user="${CSS.escape(saved)}"]`,
  )
  if (savedBtn) {
    container
      .querySelector(".filter-toolbar__user-btn.active")
      ?.classList.remove("active")
    savedBtn.classList.add("active")
  }

  // Apply filter
  function applyUserFilter() {
    const activeBtn = container!.querySelector(".filter-toolbar__user-btn.active")
    const userId = (activeBtn as HTMLElement)?.dataset.user || "all"
    localStorage.setItem("meitheal-kanban-user-filter", userId)

    document
      .querySelectorAll(".kanban-card[data-assigned]")
      .forEach((el) => {
        const card = el as HTMLElement
        const assigned = card.dataset.assigned || ""

        if (userId === "all") {
          card.classList.remove("user-filtered-out")
        } else if (userId === "unassigned") {
          card.classList.toggle("user-filtered-out", assigned !== "")
        } else {
          card.classList.toggle("user-filtered-out", assigned !== userId)
        }
      })

    window.updateAllCounts?.()
  }

  // Click handlers
  container.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(".filter-toolbar__user-btn")
    if (!btn) return
    container
      .querySelectorAll(".filter-toolbar__user-btn")
      .forEach((b) => b.classList.remove("active"))
    btn.classList.add("active")
    applyUserFilter()
  }, { signal })

  // Apply on load
  applyUserFilter()
}
