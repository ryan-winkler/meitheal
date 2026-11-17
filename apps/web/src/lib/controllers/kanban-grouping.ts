/**
 * Page-local Kanban swimlanes and collapse preferences.
 * @domain kanban
 */

export function swimlanePreferenceKey(board: HTMLElement, group: HTMLElement): string {
  const key = group.dataset.swimlaneType || group.dataset.swimlaneValue || "dynamic"
  if (board.dataset.groupBy !== "project") return `meitheal-swimlane-${key}`
  const column = group.closest<HTMLElement>(".kanban-column")
  return `meitheal-swimlane-v2-${JSON.stringify(["project", column?.dataset.laneId, key])}`
}

export function setSwimlaneCollapsed(group: HTMLElement, collapsed: boolean): void {
  const header = group.querySelector<HTMLElement>(".swimlane-header")
  const cards = group.querySelector<HTMLElement>(".swimlane-cards")
  if (!header || !cards) return

  const toggle = header.querySelector(".swimlane-toggle")
  if (toggle) {
    toggle.classList.toggle("collapsed", collapsed)
    toggle.textContent = collapsed ? "▶" : "▼"
  }
  cards.classList.toggle("collapsed", collapsed)
  group.classList.toggle("swimlane-collapsed", collapsed)
  if (header instanceof HTMLButtonElement) {
    if (collapsed && cards.contains(document.activeElement)) header.focus({ preventScroll: true })
    cards.hidden = collapsed
    header.setAttribute("aria-expanded", String(!collapsed))
  }
}

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
  } else if (mode === "area" || mode === "priority" || mode === "project") {
    const byProject = mode === "project"
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

    board.querySelectorAll(".kanban-column").forEach((col, columnIndex) => {
      const cardsContainer = col.querySelector(".kanban-cards")
      if (!cardsContainer) return
      const flatCards = Array.from(
        cardsContainer.querySelectorAll<HTMLElement>(".flat-card"),
      )

      // Collect unique values
      const groups = new Map<string, Element[]>()
      flatCards.forEach((card) => {
        const value = byProject ? card.dataset.projectGroup : card.dataset[mode]
        const val = byProject ? value || "unavailable-project"
          : value || (mode === "priority" ? "3" : "default")
        if (!groups.has(val)) groups.set(val, [])
        groups.get(val)!.push(card)
      })

      const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
        if (mode === "priority") return Number(a) - Number(b)
        const label = (key: string) => groups.get(key)?.[0]?.getAttribute("data-project-label") ?? key
        return (byProject ? label(a).localeCompare(label(b)) : 0) || a.localeCompare(b)
      })

      sortedKeys.forEach((key, groupIndex) => {
        const cards = groups.get(key)!
        const group = document.createElement("div")
        group.className = "swimlane-group dynamic-group"
        group.dataset.swimlaneType = key

        const accentColor = (!byProject && colorMap[key]) || defaultAccent
        group.style.borderTop = `3px solid ${accentColor}`

        const header = document.createElement(byProject ? "button" : "div")
        header.className = "swimlane-header"
        const first = cards[0] as HTMLElement
        const label = byProject
          ? first.dataset.projectLabel ?? "Unknown Project"
          : icons[key] || (mode === "area" ? (areaTitleMap[key] || `📋 ${key}`) : defaultLabel)
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
        const heading = document.createElement("span")
        heading.className = "swimlane-heading"
        heading.appendChild(labelSpan)
        const qualifier = byProject && first.dataset.projectQualifier
        if (qualifier) {
          const detail = document.createElement("span")
          detail.className = "swimlane-qualifier"
          detail.textContent = qualifier
          heading.appendChild(detail)
          header.setAttribute("aria-label", `${label} · ${qualifier}`)
        }
        const countSpan = document.createElement("span")
        countSpan.className = "swimlane-count"
        countSpan.textContent = String(cards.length)
        header.append(toggleSpan, dotSpan, byProject ? heading : labelSpan, countSpan)

        // Collapse toggle — matches static swimlane CSS class pattern
        header.style.cursor = "pointer"

        const swimlaneCards = document.createElement("div")
        swimlaneCards.className = "swimlane-cards"
        if (header instanceof HTMLButtonElement) {
          header.type = "button"
          header.setAttribute("aria-expanded", "true")
          toggleSpan.setAttribute("aria-hidden", "true")
          swimlaneCards.id = `project-swimlane-${columnIndex}-${groupIndex}`
          header.setAttribute("aria-controls", swimlaneCards.id)
          heading.title = qualifier ? `${label} · ${qualifier}` : label
        }
        cards.forEach((card) => {
          card.classList.remove("flat-card")
          card.classList.add("grouped-card")
          swimlaneCards.appendChild(card)
        })

        group.appendChild(header)
        group.appendChild(swimlaneCards)
        cardsContainer.appendChild(group)

      })
    })
  }
  for (const group of board.querySelectorAll<HTMLElement>(".swimlane-group:not([hidden])")) {
    try {
      if (localStorage.getItem(swimlanePreferenceKey(board, group)) === "collapsed") {
        setSwimlaneCollapsed(group, true)
      }
    } catch { /* Storage is optional. */ }
  }
}
