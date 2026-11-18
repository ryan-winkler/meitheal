/**
 * Page-local Kanban swimlanes and collapse preferences.
 * @domain kanban
 */

function collapseKey(board: HTMLElement, group: HTMLElement): string {
  const column = group.closest<HTMLElement>(".kanban-column")
  return `meitheal-swimlane-v2-${JSON.stringify([board.dataset.groupBy, column?.dataset.laneId, group.dataset.swimlaneType])}`
}

function setCollapsed(group: HTMLElement, collapsed: boolean): void {
  const header = group.querySelector<HTMLButtonElement>(".swimlane-header")
  const cards = group.querySelector<HTMLElement>(".swimlane-cards")
  if (!header || !cards) return

  if (collapsed && cards.contains(document.activeElement)) header.focus({ preventScroll: true })
  cards.hidden = collapsed
  group.classList.toggle("swimlane-collapsed", collapsed)
  header.setAttribute("aria-expanded", String(!collapsed))
}

function initCollapse(board: HTMLElement, signal: AbortSignal): void {
  const mode = board.dataset.groupBy
  const groups = board.querySelectorAll<HTMLElement>(".swimlane-group:not([hidden])")
  groups.forEach((group, index) => {
    const header = group.querySelector<HTMLButtonElement>(".swimlane-header")
    const cards = group.querySelector<HTMLElement>(".swimlane-cards")
    if (!header || !cards) return

    cards.id = `kanban-swimlane-cards-${index}`
    header.setAttribute("aria-controls", cards.id)
    const key = collapseKey(board, group)
    try {
      const legacy = mode === "assigned" || mode === "project"
        ? null : `meitheal-swimlane-${group.dataset.swimlaneType}`
      const stored = localStorage.getItem(key) ?? (legacy && localStorage.getItem(legacy))
      setCollapsed(group, stored === "collapsed")
    } catch {
      setCollapsed(group, false)
    }
    header.addEventListener("click", () => {
      const collapsed = !cards.hidden
      setCollapsed(group, collapsed)
      try { localStorage.setItem(key, collapsed ? "collapsed" : "expanded") } catch { /* Storage is optional. */ }
    }, { signal })
  })
}

/** Group the server-selected page without replacing authoritative lane totals. */
export function initKanbanGrouping(board: HTMLElement, signal: AbortSignal): void {
  const mode = board.dataset.groupBy ?? "none"

  if (mode === "type") {
    // Use the pre-rendered type swimlane groups
    board.querySelectorAll(".kanban-column").forEach((col) => {
      const cardsContainer = col.querySelector(".kanban-cards")
      if (!cardsContainer) return
      cardsContainer.querySelectorAll<HTMLElement>(".flat-card").forEach((card) => {
        const type = card.dataset.taskType || "task"
        const swimlane = cardsContainer.querySelector(
          `.swimlane-group[data-swimlane-type="${CSS.escape(type)}"] .swimlane-cards`,
        )
        if (swimlane) {
          card.classList.remove("flat-card")
          card.classList.add("grouped-card")
          swimlane.appendChild(card)
        }
      })
      cardsContainer
        .querySelectorAll(".swimlane-group:not(.dynamic-group)")
        .forEach((group) => {
          group.removeAttribute("hidden") // Show all type swimlanes
          const countEl = group.querySelector(".swimlane-count")
          const cards = group.querySelectorAll(".kanban-card")
          if (countEl) countEl.textContent = String(cards.length)
        })
    })
  } else if (mode === "area" || mode === "priority" || mode === "epic" || mode === "assigned" || mode === "project") {
    const byProject = mode === "project"
    const byAssignee = mode === "assigned"
    const icons: Record<string, string> =
      mode === "priority"
        ? {
            "1": "🔴 P1 — Critical",
            "2": "🟠 P2 — High",
            "3": "🟡 P3 — Medium",
            "4": "🟢 P4 — Low",
            "5": "⚪ P5 — Minimal",
          }
        : {}
    const areaLabel = (key: string, card: HTMLElement | undefined) => card?.dataset.areaName || (key === "default"
      ? board.dataset.defaultAreaLabel ?? "Default Area"
      : board.dataset.unavailableAreaLabel ?? "Unavailable Area")

    // O1: Hoist getComputedStyle outside column loop
    const cs = getComputedStyle(document.documentElement)
    const colorMap: Record<string, string> = mode === "priority"
      ? {
          "1": cs.getPropertyValue("--prio-critical").trim() || "#ef4444",
          "2": cs.getPropertyValue("--prio-high").trim() || "#f97316",
          "3": cs.getPropertyValue("--prio-medium").trim() || "#eab308",
          "4": cs.getPropertyValue("--prio-low").trim() || "#22c55e",
          "5": cs.getPropertyValue("--prio-none").trim() || "#64748b",
        }
      : {}
    const defaultAccent = cs.getPropertyValue("--accent").trim() || "#146C4E"

    board.querySelectorAll(".kanban-column").forEach((col) => {
      const cardsContainer = col.querySelector(".kanban-cards")
      if (!cardsContainer) return
      const flatCards = Array.from(
        cardsContainer.querySelectorAll<HTMLElement>(".flat-card"),
      )

      // Collect unique values
      const groups = new Map<string, HTMLElement[]>()
      flatCards.forEach((card) => {
        const value = card.dataset[mode]
        let val = byAssignee ? value ?? "" : value || (mode === "priority" ? "3" : mode === "epic" ? "epic:none" : "default")
        if (byProject) val = card.dataset.projectGroup || "unavailable-project"
        if (byAssignee && card.dataset.assigneeKey) {
          try {
            const key: unknown = JSON.parse(card.dataset.assigneeKey)
            if (typeof key === "string") val = key
          } catch { /* Keep the unencoded identity when metadata is malformed. */ }
        }
        // Empty Area IDs map to Default, leaving the empty key for unavailable Areas.
        const key = mode === "area" && val !== "default" && !card.dataset.areaName ? "" : val
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(card)
      })

      const groupLabel = (key: string) => {
        const card = groups.get(key)?.[0]
        if (byProject) return card?.dataset.projectLabel ?? window.mI18n?.get("kanban.unknown_project") ?? "Unknown Project"
        if (mode === "epic") return card?.dataset.epicLabel || board.dataset.noEpicLabel || "No Epic"
        if (byAssignee) return key ? window.mI18n?.get("tasks.assignee_loading") ?? "Loading assignee…"
          : window.mI18n?.get("tasks.unassigned") ?? "Unassigned"
        if (mode === "area") return areaLabel(key, card)
        return icons[key] || "🟡 P3 — Medium"
      }
      const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
        if (mode === "priority") return Number(a) - Number(b)
        if (byAssignee) return Number(!a) - Number(!b) || a.localeCompare(b)
        return groupLabel(a).localeCompare(groupLabel(b), document.documentElement.lang || undefined) || a.localeCompare(b)
      })

      sortedKeys.forEach((key) => {
        const cards = groups.get(key)!
        const group = document.createElement("div")
        group.className = "swimlane-group dynamic-group"
        group.dataset.swimlaneType = key

        const accentColor = colorMap[key] || defaultAccent
        group.style.borderTop = `3px solid ${accentColor}`

        const header = document.createElement("button")
        header.type = "button"
        header.className = "swimlane-header"
        const label = groupLabel(key)
        const toggleSpan = document.createElement("span")
        toggleSpan.className = "swimlane-toggle"
        toggleSpan.setAttribute("aria-hidden", "true")
        toggleSpan.textContent = "▼"

        // Color dot (matches static .swimlane-type-dot)
        const dotSpan = document.createElement("span")
        dotSpan.className = "swimlane-type-dot"
        dotSpan.style.background = accentColor

        const labelSpan = document.createElement("span")
        labelSpan.className = "swimlane-label"
        labelSpan.textContent = mode === "area" ? `${cards[0]?.dataset.areaIcon || "📋"} ${label}` : label
        let heading = labelSpan
        if (byProject) {
          heading = document.createElement("span")
          heading.className = "swimlane-heading"
          heading.appendChild(labelSpan)
          const qualifier = cards[0]?.dataset.projectQualifier
          if (qualifier) {
            const detail = document.createElement("span")
            detail.className = "swimlane-qualifier"
            detail.textContent = qualifier
            heading.appendChild(detail)
            header.setAttribute("aria-label", `${label} · ${qualifier}`)
          }
          heading.title = qualifier ? `${label} · ${qualifier}` : label
        } else if (byAssignee) {
          labelSpan.dataset.assigneeGroup = ""
          labelSpan.dir = "auto"
          if (key) labelSpan.dataset.taskAssignee = key
        }
        const countSpan = document.createElement("span")
        countSpan.className = "swimlane-count"
        countSpan.textContent = String(cards.length)
        header.append(toggleSpan, dotSpan, heading, countSpan)

        const swimlaneCards = document.createElement("div")
        swimlaneCards.className = "swimlane-cards"
        cards.forEach((card) => {
          card.classList.remove("flat-card")
          card.classList.add("grouped-card")
          swimlaneCards.appendChild(card)
        })

        group.appendChild(header)
        group.appendChild(swimlaneCards)
        cardsContainer.appendChild(group)
      }) // end sortedKeys.forEach
    }) // end col.forEach
  } // end else if
  initCollapse(board, signal)
}
