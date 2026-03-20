/**
 * kanban-grouping.ts — Group-by/swimlane logic, filter integration, counts
 *
 * @domain kanban
 * @kcs Extracted from kanban-controller.ts for decomposition.
 *      Manages filter toolbar integration, group-by (type/area/priority),
 *      swimlane creation, column counts, and collapse persistence.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Initialise the unified filtering, grouping, count updates, and collapse persistence.
 */
export function initGroupingAndFilters(): void {
  // Restore group-by state
  const groupBySelect = document.getElementById("kanban-group-by")
  const savedGroupBy = localStorage.getItem("meitheal-kanban-group-by") || "none"
  if (groupBySelect && savedGroupBy !== "none") {
    ;(groupBySelect as HTMLInputElement).value = savedGroupBy
    // Don't auto-dispatch here; FilterToolbar handles initialization and emits meitheal:filter-change
  }

  // We share isCardVisible with the global scope for updateAllCounts
  let currentFilterState: Record<string, any> = {}

  window.isCardVisible = function (card: HTMLElement) {
    if (!window.__filterStateLoaded) return true // Show all before first filter event
    if (typeof window.__isTaskVisible === "function") {
      return (window.__isTaskVisible as any)?.(card, currentFilterState) ?? true
    }
    return true
  }

  // Listen for unified filter events from FilterToolbar
  document.addEventListener("meitheal:filter-change", (e) => {
    if ((e as CustomEvent).detail?.view !== "kanban") return
    currentFilterState = (e as CustomEvent).detail

    // Apply groupBy
    const mode = (currentFilterState as any).groupBy || "none"
    if (mode !== (localStorage.getItem("meitheal-kanban-group-by") || "none")) {
      // Sync select element if needed
      if (groupBySelect && (groupBySelect as HTMLInputElement).value !== mode) (groupBySelect as HTMLInputElement).value = mode
      applyGroupBy(mode)
    }

    // Apply visibility to all cards
    if (typeof window.__isTaskVisible === "function") {
      document.querySelectorAll(".kanban-card").forEach(card => {
        if ((window.__isTaskVisible as any)?.(card as HTMLElement, currentFilterState)) {
          ;(card as HTMLElement).style.display = ""
        } else {
          ;(card as HTMLElement).style.display = "none"
        }
      })
    }

    window.updateAllCounts?.()
  })

  // Unified count updater — column headers + swimlane badges
  window.updateAllCounts = function () {
    // 1. Column header counts
    document.querySelectorAll(".kanban-column").forEach((col) => {
      const count = col.querySelector(".kanban-count")
      const visible = Array.from(
        col.querySelectorAll(".kanban-card"),
      ).filter(c => (c as HTMLElement).style.display !== "none")
      if (count) count.textContent = String(visible.length)
    })

    // 2. Swimlane group counts (both static + dynamic)
    document.querySelectorAll(".swimlane-group").forEach((group) => {
      const countEl = group.querySelector(".swimlane-count-val") || group.querySelector(".swimlane-count")
      if (!countEl) return
      const visible = Array.from(
        group.querySelectorAll(".kanban-card"),
      ).filter(c => (c as HTMLElement).style.display !== "none")
      countEl.textContent = String(visible.length)
    })

    // Hide clear button (handled internally by FilterToolbar UI, but we can sync)
    const filterClearBtn = document.getElementById("kanban-clear-filters")
    if (filterClearBtn) {
      filterClearBtn.classList.toggle("hidden",
        Object.values(currentFilterState).every(v => v === "" || v === "none" || (Array.isArray(v) && v.length === 0))
      )
    }
  }

  // Group-by implementation
  async function applyGroupBy(mode: string) {
    localStorage.setItem("meitheal-kanban-group-by", mode)

    const areaTitleMap: Record<string, string> = {}
    if (mode === "area") {
      try {
        const res = await fetch("/api/areas")
        if (res.ok) {
          const data = await res.json()
          ;(data.areas || []).forEach((b: any) => { areaTitleMap[b.id] = `${b.icon || '📋'} ${b.name}` })
        }
      } catch { /* use raw IDs as fallback */ }
      areaTitleMap["default"] = "📋 Default"
    }

    // Ungroup everything first
    document.querySelectorAll(".kanban-column").forEach((col) => {
      const cardsContainer = col.querySelector(".kanban-cards")
      if (!cardsContainer) return

      // Move all cards back to flat
      cardsContainer
        .querySelectorAll(".swimlane-group")
        .forEach((group) => {
          const swimlaneCards = group.querySelector(".swimlane-cards")
          if (swimlaneCards) {
            swimlaneCards
              .querySelectorAll(".kanban-card")
              .forEach((card) => {
                card.classList.remove("grouped-card")
                card.classList.add("flat-card")
                cardsContainer.insertBefore(card, group)
              })
          }
        })

      // Remove dynamic swimlane groups
      cardsContainer
        .querySelectorAll(".swimlane-group.dynamic-group")
        .forEach((g) => g.remove())
      // Hide static type swimlane groups
      cardsContainer
        .querySelectorAll(".swimlane-group:not(.dynamic-group)")
        .forEach((g) => {
          ;(g as HTMLElement).style.display = "none"
        })
    })

    if (mode === "none") {
      window.updateAllCounts?.()
      return
    }

    if (mode === "type") {
      // Use the pre-rendered type swimlane groups
      document.querySelectorAll(".kanban-column").forEach((col) => {
        const cardsContainer = col.querySelector(".kanban-cards")
        if (!cardsContainer) return
        cardsContainer.querySelectorAll<HTMLElement>(".flat-card").forEach((card) => {
          const type = card.dataset.taskType || "task"
          const swimlane = cardsContainer.querySelector(
            `.swimlane-group[data-swimlane-type="${type}"] .swimlane-cards`,
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
            ;(group as HTMLElement).style.display = "" // Show all type swimlanes
            const countEl = group.querySelector(".swimlane-count")
            const cards = group.querySelectorAll(".kanban-card")
            if (countEl) countEl.textContent = String(Array.from(cards).filter(c => window.isCardVisible?.(c as HTMLElement) ?? true).length)
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
      const defaultAccent = cs.getPropertyValue("--accent").trim() || "#6366F1"

      document.querySelectorAll(".kanban-column").forEach((col) => {
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
          countSpan.textContent = String(cards.filter((card: any) => window.isCardVisible?.(card) ?? true).length)
          header.append(toggleSpan, dotSpan, labelSpan, countSpan)

          // Collapse toggle — matches static swimlane CSS class pattern
          header.style.cursor = "pointer"

          const swimlaneCards = document.createElement("div")
          swimlaneCards.className = "swimlane-cards"
          cards.forEach((card: any) => {
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
  } // end applyGroupBy

  // Swimlane header collapse toggle — CSS animation + localStorage persistence
  document.querySelectorAll(".swimlane-header").forEach((header) => {
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
