/**
 * Page-local Kanban swimlanes and collapse preferences.
 * @domain kanban
 */

import { createSpriteIconElement } from "../../generated/icon-registry"
import { getGroupKey } from "../filter-state"
import { CANONICAL_STATUSES, getStatusDef, normalizeStatus, STATUS } from "../status-config"

const riceGroupOrder = ["high", "medium", "low", "none"]
const riceGroupLabels: Record<string, string> = {
  high: "High (≥15)",
  medium: "Medium (8–14)",
  low: "Low (<8)",
  none: "Needs a score",
}

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

function groupOrderKey(board: HTMLElement, lane: HTMLElement): string {
  const boardId = board.closest<HTMLElement>("[data-board-id]")?.dataset.boardId
  return `meitheal-swimlane-order-${JSON.stringify([
    document.documentElement.dataset.workspaceScope, boardId, board.dataset.groupBy, lane.dataset.laneId,
  ])}`
}

function visibleGroups(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>(":scope > .swimlane-group:not([hidden])"))
}

function storedGroupOrder(key: string): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]")
    return Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === "string") : []
  } catch {
    return []
  }
}

function restoreGroupOrder(list: HTMLElement, key: string): void {
  const order = new Map(storedGroupOrder(key).map((value, index) => [value, index]))
  if (!order.size) return
  const rank = (group: HTMLElement) => order.get(group.dataset.swimlaneType ?? "") ?? Infinity
  for (const group of visibleGroups(list).sort((a, b) => rank(a) - rank(b))) list.append(group)
}

export function storeSwimlaneOrder(board: HTMLElement, list: HTMLElement): void {
  const lane = list.closest<HTMLElement>(".kanban-column")
  if (!lane) return
  const key = groupOrderKey(board, lane)
  const current = visibleGroups(list).map(group => group.dataset.swimlaneType ?? "")
  const currentKeys = new Set(current)
  let index = 0
  // The current page may omit groups that also have a saved position.
  const order = storedGroupOrder(key).map(value => currentKeys.has(value) ? current[index++]! : value)
  try { localStorage.setItem(key, JSON.stringify([...order, ...current.slice(index)])) } catch { /* Storage is optional. */ }
}

function attachGroupOrderControl(board: HTMLElement, group: HTMLElement, header: HTMLButtonElement, signal: AbortSignal) {
  const toolbar = document.createElement("div")
  toolbar.className = "swimlane-toolbar"
  header.replaceWith(toolbar)
  const disclosure = document.createElement("details")
  disclosure.className = "swimlane-order"
  const grip = document.createElement("summary")
  grip.className = "btn btn-icon btn-ghost swimlane-grip"
  grip.setAttribute("aria-label", `Reorder ${header.querySelector(".swimlane-label")?.textContent?.trim() || "group"}`)
  grip.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown")
  grip.append(createSpriteIconElement("grip-vertical", { size: 16 }))
  const menu = document.createElement("div")
  menu.className = "dropdown-menu show swimlane-order-menu"
  const move = (offset: number) => {
    const list = group.parentElement
    if (!list) return
    const groups = visibleGroups(list)
    const target = groups[groups.indexOf(group) + offset]
    if (target) {
      if (offset < 0) target.before(group)
      else target.after(group)
      storeSwimlaneOrder(board, list)
    }
    disclosure.open = false
    grip.focus({ preventScroll: true })
  }
  for (const [offset, label] of [[-1, "Move up"], [1, "Move down"]] as const) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "dropdown-item"
    button.textContent = label
    button.addEventListener("click", () => move(offset), { signal })
    menu.append(button)
  }
  grip.addEventListener("keydown", event => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return
    event.preventDefault()
    event.stopPropagation()
    move(event.key === "ArrowUp" ? -1 : 1)
  }, { signal })
  disclosure.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !disclosure.open) return
    event.preventDefault()
    event.stopPropagation()
    disclosure.open = false
    grip.focus({ preventScroll: true })
  }, { signal })
  disclosure.append(grip, menu)
  toolbar.append(header, disclosure)
}

/** Group the server-selected page without replacing authoritative lane totals. */
export function initKanbanGrouping(board: HTMLElement, signal: AbortSignal, canEdit: boolean) {
  const mode = board.dataset.groupBy ?? "none"
  if (mode === "none") return destinationList
  let nextGroupId = 0

  function initGroup(group: HTMLElement) {
    const header = group.querySelector<HTMLButtonElement>(".swimlane-header")
    const cards = group.querySelector<HTMLElement>(".swimlane-cards")
    if (!header || !cards) return
    cards.id = `kanban-swimlane-cards-${nextGroupId++}`
    header.setAttribute("aria-controls", cards.id)
    const key = collapseKey(board, group)
    try {
      const legacy = mode === "type" || mode === "area" || mode === "priority"
        ? `meitheal-swimlane-${group.dataset.swimlaneType}` : null
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
    if (canEdit) attachGroupOrderControl(board, group, header, signal)
  }

  if (mode === "type") {
    // Use the pre-rendered type swimlane groups
    board.querySelectorAll(".kanban-column").forEach((col) => {
      const cardsContainer = col.querySelector(".kanban-cards")
      if (!cardsContainer) return
      cardsContainer.querySelectorAll<HTMLElement>(".flat-card").forEach((card) => {
        const type = ["epic", "story"].includes(card.dataset.taskType ?? "") ? card.dataset.taskType! : "task"
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
  } else if (mode === "area" || mode === "priority" || mode === "epic" || mode === "status" || mode === "assigned" || mode === "project" || mode === "rice") {
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
    const areaLabel = (card: HTMLElement | undefined) => card?.dataset.areaName || board.dataset.noAreaLabel || "No area"

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
        let val = mode === "status" ? normalizeStatus(value || STATUS.PENDING)
          : byAssignee || mode === "area" ? value ?? "" : value || (mode === "priority" ? "3" : mode === "epic" ? "epic:none" : "default")
        if (byProject) val = card.dataset.projectGroup || "unavailable-project"
        if (mode === "rice") val = getGroupKey(card, "rice")
        if (byAssignee && card.dataset.assigneeKey) {
          try {
            const key: unknown = JSON.parse(card.dataset.assigneeKey)
            if (typeof key === "string") val = key
          } catch { /* Keep the unencoded identity when metadata is malformed. */ }
        }
        // Unfiled and masked placement share a neutral label; visible real Areas retain their identity.
        const key = mode === "area" && !card.dataset.areaName ? "" : val
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(card)
      })

      const statusRank = (key: string) => {
        const index = CANONICAL_STATUSES.indexOf(key)
        return index < 0 ? CANONICAL_STATUSES.length : index
      }
      const groupLabel = (key: string) => {
        const card = groups.get(key)?.[0]
        if (byProject) return card?.dataset.projectLabel ?? window.mI18n?.get("kanban.unknown_project") ?? "Unknown Project"
        if (mode === "epic") return card?.dataset.epicLabel || board.dataset.noEpicLabel || "No Epic"
        if (byAssignee) return key ? window.mI18n?.get("tasks.assignee_loading") ?? "Loading assignee…"
          : window.mI18n?.get("tasks.unassigned") ?? "Unassigned"
        if (mode === "area") return areaLabel(card)
        if (mode === "rice") {
          const labelKey = key === "none" ? "planning_rice.unscored" : `tasks.rice_${key}`
          return window.mI18n?.get(labelKey) ?? riceGroupLabels[key]
        }
        if (mode === "status") {
          const status = getStatusDef(key)
          return status ? window.mI18n?.get(status.i18nKey) ?? status.label : key
        }
        return icons[key] || "🟡 P3 — Medium"
      }
      const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
        if (mode === "priority") return Number(a) - Number(b)
        if (mode === "rice") return riceGroupOrder.indexOf(a) - riceGroupOrder.indexOf(b)
        if (mode === "status") return statusRank(a) - statusRank(b) || a.localeCompare(b)
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
        toggleSpan.append(createSpriteIconElement("chevron-down", { size: 14 }))

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
        if (mode === "status") labelSpan.title = label
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
  for (const lane of board.querySelectorAll<HTMLElement>(".kanban-column")) {
    const list = lane.querySelector<HTMLElement>(".kanban-cards")
    if (!list) continue
    for (const group of visibleGroups(list)) initGroup(group)
    restoreGroupOrder(list, groupOrderKey(board, lane))
  }

  return destinationList

  function destinationList(
    lane: HTMLElement, sourceGroup?: HTMLElement | null, typeGroup?: HTMLElement,
  ): HTMLElement | null {
    if (typeGroup) return typeGroup.querySelector<HTMLElement>(".swimlane-cards")
    const list = lane.querySelector<HTMLElement>(".kanban-cards")
    if (!list || !sourceGroup) return list
    const key = mode === "status" ? normalizeStatus(lane.dataset.status ?? STATUS.PENDING) : sourceGroup.dataset.swimlaneType
    const existing = visibleGroups(list).find(group => group.dataset.swimlaneType === key)
    if (existing) return existing.querySelector<HTMLElement>(".swimlane-cards")
    const sourceHeader = sourceGroup.querySelector<HTMLButtonElement>(".swimlane-header")
    if (!sourceHeader || !sourceGroup.classList.contains("dynamic-group")) return list

    // A group with no cards on this lane's page is created when its first card arrives.
    const group = sourceGroup.cloneNode(false) as HTMLElement
    group.classList.remove("swimlane-collapsed")
    group.dataset.swimlaneType = key ?? ""
    group.dataset.temporarySwimlane = ""
    const header = sourceHeader.cloneNode(true) as HTMLButtonElement
    if (mode === "status") {
      const def = getStatusDef(key ?? "")
      const label = def ? window.mI18n?.get(def.i18nKey) ?? def.label : key ?? ""
      const heading = header.querySelector<HTMLElement>(".swimlane-label")
      if (heading) {
        heading.textContent = label
        heading.title = label
      }
    }
    const cards = document.createElement("div")
    cards.className = "swimlane-cards"
    group.append(header, cards)
    list.append(group)
    initGroup(group)
    restoreGroupOrder(list, groupOrderKey(board, lane))
    return cards
  }
}
