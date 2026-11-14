/**
 * Page-local Kanban swimlanes and collapse preferences.
 * @domain kanban
 */

/** Group the server-selected page without replacing authoritative lane totals. */
export function initKanbanGrouping(board: HTMLElement): void {
  const mode = board.dataset.groupBy ?? "none"
  const areaTitleMap: Record<string, string> = { default: "📋 Default" }
  for (const option of document.querySelectorAll<HTMLElement>("#area-selector-dropdown [data-area-id]")) {
    if (option.dataset.areaId) areaTitleMap[option.dataset.areaId] = `${option.dataset.areaIcon ?? "📋"} ${option.dataset.areaName ?? ""}`
  }

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
  } else if (mode === "area" || mode === "priority") {
    // Dynamic swimlane generation for board/priority
    const dataAttr = mode === "area" ? "area" : "priority"
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
    const defaultLabel =
      mode === "priority" ? "🟡 P3 — Medium" : "📋 Default"

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
        cardsContainer.querySelectorAll(".flat-card"),
      )

      // Collect unique values
      const groups = new Map<string, Element[]>()
      flatCards.forEach((card) => {
        const val =
          (card as HTMLElement).dataset[dataAttr] ||
          (mode === "priority" ? "3" : "default")
        if (!groups.has(val)) groups.set(val, [])
        groups.get(val)!.push(card)
      })

      // Sort: priority by number, board alphabetically
      const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
        if (mode === "priority") return Number(a) - Number(b)
        return a.localeCompare(b)
      })

      sortedKeys.forEach((key) => {
        const cards = groups.get(key)!
        const group = document.createElement("div")
        group.className = "swimlane-group dynamic-group"
        group.dataset.swimlaneType = key

        const accentColor = colorMap[key] || defaultAccent
        group.style.borderTop = `3px solid ${accentColor}`

        const header = document.createElement("div")
        header.className = "swimlane-header"
        const label =
          icons[key] || (mode === "area" ? (areaTitleMap[key] || `📋 ${key}`) : defaultLabel)
        const toggleSpan = document.createElement("span")
        toggleSpan.className = "swimlane-toggle"
        toggleSpan.textContent = "▼"

        // Color dot (matches static .swimlane-type-dot)
        const dotSpan = document.createElement("span")
        dotSpan.className = "swimlane-type-dot"
        dotSpan.style.background = accentColor

        const labelSpan = document.createElement("span")
        labelSpan.className = "swimlane-label"
        labelSpan.textContent = label
        const countSpan = document.createElement("span")
        countSpan.className = "swimlane-count"
        countSpan.textContent = String(cards.length)
        header.append(toggleSpan, dotSpan, labelSpan, countSpan)

        // Collapse toggle — matches static swimlane CSS class pattern
        header.style.cursor = "pointer"

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

        // Restore saved collapse state for dynamic swimlane
        const collapseKey = `meitheal-swimlane-${key}`
        if (localStorage.getItem(collapseKey) === "collapsed") {
          swimlaneCards.classList.add("collapsed")
          toggleSpan.classList.add("collapsed")
          toggleSpan.textContent = "▶"
          group.classList.add("swimlane-collapsed")
        }
      }) // end sortedKeys.forEach
    }) // end col.forEach
  } // end else if
  // Swimlane header collapse toggle — CSS animation + localStorage persistence
  board.querySelectorAll(".swimlane-header[data-type]").forEach((header) => {
    const group = header.closest(".swimlane-group")
    if (!group) return
    const cards = group.querySelector(".swimlane-cards")
    const toggle = header.querySelector(".swimlane-toggle")
    const type = (header as HTMLElement).dataset.type || "unknown"
    const storageKey = `meitheal-swimlane-${type}`

    // Restore saved collapse state
    const saved = localStorage.getItem(storageKey)
    if (saved === "collapsed" && cards) {
      cards.classList.add("collapsed")
      if (toggle) {
        toggle.classList.add("collapsed")
        toggle.textContent = "▶"
      }
      group.classList.add("swimlane-collapsed")
    }
  })
}
