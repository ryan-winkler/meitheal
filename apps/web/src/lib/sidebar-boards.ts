import { currentTaskApiContext, taskApiHeaders } from "./task-api"
import { sameTaskApiContext } from "./task-api-client"
import { bindSidebarHierarchyActions } from "./sidebar-hierarchy-actions"
import { boardWorkspaceHref } from "./board-workspace"
import { safeIngressHref } from "./ingress-navigation"
import { createTablerSvgElement } from "./tabler-svg"
import { SIDEBAR_CONFIG_UPDATED_EVENT, SIDEBAR_TOGGLE_SHORTCUT_PIN_EVENT } from "./sidebar-order"

interface BoardShortcut { id: string; name: string; hidden: boolean; state: string }
interface GroupChoice { id: string; name: string; icon?: string; color?: string }
interface GroupPage { items: GroupChoice[]; selected?: GroupChoice | null; next_cursor: string | null; actions?: string[] }

export function bindSidebarBoards(pageSignal: AbortSignal) {
  const runtime = window as typeof window & { __meithealSidebarBoards?: AbortController }
  runtime.__meithealSidebarBoards?.abort()
  const localController = new AbortController()
  runtime.__meithealSidebarBoards = localController
  const signal = AbortSignal.any([pageSignal, localController.signal])

  const hierarchyList = document.querySelector<HTMLUListElement>("[data-sidebar-boards]")
  hierarchyList?.classList.add("stree")
  // The action popup handles Escape before the enclosing Boards disclosure.
  const actions = hierarchyList && bindSidebarHierarchyActions(hierarchyList, signal)
  const children = document.querySelector<HTMLElement>("[data-sidebar-board-children]")
  const parentToggle = document.querySelector<HTMLButtonElement>("[data-sidebar-boards-toggle]")
  let triggerRefresh: (() => void) | undefined
  if (children && parentToggle) {
    const navbar = () => innerWidth > 768 && document.documentElement.dataset.appearanceNavigation === "navbar"
    const popup = () => navbar() && !children.closest("[data-nav-overflow-menu]")
    const positionBoardPopup = () => {
      if (children.hidden || !popup()) {
        children.style.removeProperty("--board-menu-top")
        children.style.removeProperty("--board-menu-left")
        return
      }
      const rect = parentToggle.getBoundingClientRect()
      const menuWidth = children.offsetWidth || 240
      const menuHeight = children.offsetHeight || 180
      const left = Math.max(12, Math.min(rect.left - 80, innerWidth - menuWidth - 12))
      const top = Math.max(8, Math.min(rect.bottom + 8, innerHeight - menuHeight - 12))
      children.style.setProperty("--board-menu-top", `${Math.round(top)}px`)
      children.style.setProperty("--board-menu-left", `${Math.round(left)}px`)
    }
    const setCollapsed = (collapsed: boolean) => {
      children.hidden = collapsed
      parentToggle.setAttribute("aria-expanded", String(!children.hidden))
      if (!collapsed) {
        if (popup()) window.dispatchEvent(new CustomEvent("meitheal:nav-submenu-open", { detail: { id: "boards" } }))
        positionBoardPopup()
        requestAnimationFrame(positionBoardPopup)
        if (hierarchyList && !hierarchyList.querySelector(":scope > [data-named-board-shortcut]")) triggerRefresh?.()
      }
      if (!navbar()) {
        try { sessionStorage.setItem("meitheal-boards-collapsed", String(children.hidden)) } catch { /* Optional preference */ }
      }
    }
    try {
      const remembered = sessionStorage.getItem("meitheal-boards-collapsed")
      children.hidden = navbar() ? true : remembered === "true"
    } catch { children.hidden = navbar() }
    parentToggle.setAttribute("aria-expanded", String(!children.hidden))
    if (!children.hidden && popup()) {
      positionBoardPopup()
      requestAnimationFrame(positionBoardPopup)
    }
    parentToggle.addEventListener("click", event => {
      event.stopPropagation()
      setCollapsed(!children.hidden)
    }, { signal })
    window.addEventListener("meitheal:nav-submenu-open", event => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      if (id !== "boards" && popup() && !children.hidden) setCollapsed(true)
    }, { signal })
    window.addEventListener("resize", positionBoardPopup, { signal })
    window.addEventListener("scroll", positionBoardPopup, { signal, passive: true })
    window.addEventListener("meitheal:appearance-changed", () => {
      if (navbar() && !children.hidden && !children.contains(document.activeElement)) setCollapsed(true)
    }, { signal })
    const escapePopup = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape" || !popup() || children.hidden) return
      event.preventDefault()
      event.stopPropagation()
      setCollapsed(true)
      parentToggle.focus({ preventScroll: true })
    }
    children.addEventListener("keydown", escapePopup, { signal })
    parentToggle.addEventListener("keydown", escapePopup, { signal })
    document.addEventListener("click", event => {
      if (event.target instanceof Element && event.target.closest<HTMLElement>("[data-sidebar-board-owner]")?.dataset.sidebarBoardOwner === children.id) {
        if (event.target.closest("a[href]")) {
          setCollapsed(true)
          parentToggle.focus({ preventScroll: true })
        }
        return
      }
      if (!popup() || children.hidden || !(event.target instanceof Node)) return
      if (!children.contains(event.target) && !parentToggle.contains(event.target)) setCollapsed(true)
    }, { signal })
    children.addEventListener("click", event => {
      if (!popup() || !(event.target instanceof Element) || !event.target.closest("a[href]")) return
      setCollapsed(true)
      parentToggle.focus({ preventScroll: true })
    }, { signal })
  }
  if (!hierarchyList) return
  const list = hierarchyList
  let directoryRequest: AbortController | undefined
  let directoryKey = ""
  let loadedSession = ""
  const groupRequests = new Map<HTMLElement, AbortController>()
  const openBoards = new Set<string>()
  const openAreas = new Set<string>()
  const areasEnabled = list.dataset.areasEnabled === "true" && Boolean(actions)
  const projectsEnabled = list.dataset.projectsEnabled === "true"
  const areaLabel = list.dataset.boardGroupLabel ?? "Areas"
  const projectLabel = list.dataset.boardProjectLabel ?? "Projects"

  function collapseGroups(row: HTMLElement, container: HTMLElement) {
    groupRequests.get(row)?.abort()
    container.setAttribute("aria-busy", "false")
    container.replaceChildren()
    row.querySelector(":scope > [data-board-group-notice]")?.remove()
  }

  function clear() {
    directoryRequest?.abort()
    directoryKey = ""
    for (const request of groupRequests.values()) request.abort()
    groupRequests.clear()
    list.querySelectorAll(":scope > [data-named-board-shortcut]").forEach(item => item.remove())
  }

  async function loadGroups(row: HTMLElement, boardId: string, after: string | null = null, areaId?: string) {
    groupRequests.get(row)?.abort()
    const request = new AbortController()
    groupRequests.set(row, request)
    const groups = row.querySelector<HTMLUListElement>(areaId ? "[data-board-projects]" : "[data-board-groups]")!
    const previousStatus = groups.querySelector<HTMLElement>(":scope > [data-board-group-status]")
    if (!after) groups.querySelectorAll(":scope > [data-group-choice]").forEach(item => item.remove())
    row.querySelector(":scope > [data-board-group-notice]")?.remove()
    previousStatus?.querySelector("button")?.setAttribute("aria-disabled", "true")
    const loading = document.createElement("div")
    loading.dataset.boardGroupNotice = ""
    loading.setAttribute("role", "status")
    loading.textContent = `Loading ${areaId ? projectLabel : areaLabel}…`
    groups.after(loading)
    groups.setAttribute("aria-busy", "true")
    const query = new URLSearchParams({ view: "groups" })
    if (after) query.set("after", after)
    if (areaId) query.set("area", areaId)
    const current = new URL(location.href)
    const activeGroup = current.pathname.endsWith(boardWorkspaceHref(boardId))
      ? current.searchParams.get(areaId ? "project" : "area") ?? (!areaId ? current.searchParams.get("from") : null) : null
    if (!after && activeGroup) query.set("selected", activeGroup)
    try {
      const requestContext = currentTaskApiContext()
      if (!requestContext) throw new Error("Board context unavailable")
      const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}?${query}`, {
        headers: taskApiHeaders({ ...requestContext, boardId }),
        cache: "no-store",
        signal: AbortSignal.any([signal, request.signal, AbortSignal.timeout(4_000)]),
      })
      if (request.signal.aborted || signal.aborted || !row.isConnected || groups.hidden || !sameTaskApiContext(requestContext, currentTaskApiContext())) {
        if (groupRequests.get(row) === request) loading.remove()
        return
      }
      if ([401, 403, 404].includes(response.status)) { clear(); return }
      if (!response.ok) throw new Error("Could not load choices.")
      const data = await response.json() as GroupPage
      if (request.signal.aborted || signal.aborted || !row.isConnected || groups.hidden || !sameTaskApiContext(requestContext, currentTaskApiContext())) {
        if (groupRequests.get(row) === request) loading.remove()
        return
      }
      const moveFocus = previousStatus?.contains(document.activeElement)
      previousStatus?.remove()
      loading.remove()
      const choices = data.selected && !data.items.some(item => item.id === data.selected?.id)
        ? [data.selected, ...data.items] : data.items
      const displayed = new Set([...groups.querySelectorAll<HTMLElement>(":scope > [data-group-choice]")].map(item => item.dataset.groupChoice))
      let firstNewLink: HTMLAnchorElement | undefined
      for (const group of choices) {
        if (displayed.has(group.id)) continue
        displayed.add(group.id)
        const child = document.createElement("li")
        child.dataset.groupChoice = group.id
        child.dataset.workBoard = boardId
        child.dataset.workActions = (data.actions ?? []).join(" ")
        groups.append(child)
        if (!areaId && projectsEnabled) {
          actions?.insertAreaNode(child, group.id, group.name, group.icon ?? "📁", group.color ?? "#146C4E")
          const area = child.querySelector<HTMLElement>("[data-area-group]")!
          const controls = area.querySelector<HTMLElement>(".stree__area-row")!
          const toggle = controls.querySelector<HTMLButtonElement>("[data-area-toggle]")!
          toggle.dataset.peerAreaToggle = ""
          const link = document.createElement("a")
          link.className = "nav-link stree__area-link"
          link.href = safeIngressHref(boardWorkspaceHref(boardId, { area: group.id }))
          link.append(...toggle.querySelectorAll(".stree__area-icon, .stree__area-name"))
          if (current.pathname.endsWith(boardWorkspaceHref(boardId)) && current.searchParams.get("area") === group.id) link.setAttribute("aria-current", "page")
          toggle.setAttribute("aria-label", `${projectLabel} in ${group.name}`)
          controls.insertBefore(link, toggle)
          firstNewLink ??= link
          const projects = document.createElement("ul")
          projects.id = toggle.getAttribute("aria-controls")!
          projects.dataset.boardProjects = group.id
          projects.dataset.areaProjects = group.id
          projects.className = "stree__children"
          area.querySelector(".stree__children")!.replaceWith(projects)
          const key = `${boardId}:${group.id}`
          const selected = current.pathname.endsWith(boardWorkspaceHref(boardId)) && current.searchParams.get("from") === group.id
          if (selected) openAreas.add(key)
          projects.hidden = !openAreas.has(key)
          projects.inert = projects.hidden
          projects.dataset.collapsed = String(projects.hidden)
          toggle.setAttribute("aria-expanded", String(!projects.hidden))
          toggle.title = `${projects.hidden ? "Expand" : "Collapse"} ${toggle.dataset.areaNameLabel ?? group.name}`
          toggle.addEventListener("click", event => {
            event.stopPropagation()
            projects.hidden = !projects.hidden
            projects.inert = projects.hidden
            projects.dataset.collapsed = String(projects.hidden)
            toggle.setAttribute("aria-expanded", String(!projects.hidden))
            toggle.title = `${projects.hidden ? "Expand" : "Collapse"} ${toggle.dataset.areaNameLabel ?? group.name}`
            if (projects.hidden) { openAreas.delete(key); collapseGroups(child, projects) }
            else { openAreas.add(key); void loadGroups(child, boardId, null, group.id) }
            savePreference()
          }, { signal })
          if (!projects.hidden) void loadGroups(child, boardId, null, group.id)
        } else {
          actions?.insertProjectNode(child, group.id, group.name, group.icon ?? "📋", group.color ?? "#146C4E", areaId ?? "")
          const link = child.querySelector<HTMLAnchorElement>("a[data-project-id]")!
          firstNewLink ??= link
          if (current.pathname.endsWith(boardWorkspaceHref(boardId)) && current.searchParams.get("project") === group.id) link.setAttribute("aria-current", "page")
        }
      }
      actions?.refresh()
      const boardRow = row.closest<HTMLElement>("[data-named-board-shortcut]")
      if (!areaId && boardRow) {
        boardRow.dataset.workActions = (data.actions ?? []).join(" ")
        const create = boardRow.querySelector<HTMLButtonElement>("[data-board-new-area]")
        if (create) create.hidden = !data.actions?.includes("area/create")
      }
      if (data.next_cursor || !groups.childElementCount) {
        addStatus(data.next_cursor ? `Show more ${areaId ? projectLabel : areaLabel}` : `No ${areaId ? projectLabel : areaLabel} yet`, data.next_cursor)
      }
      if (moveFocus) (firstNewLink
        ?? groups.querySelector<HTMLButtonElement>(":scope > [data-board-group-status] button")
        ?? row.querySelector<HTMLButtonElement>(areaId ? "[data-peer-area-toggle]" : ":scope > .sidebar-board-row > .sidebar-board-toggle"))?.focus()
    } catch {
      if (!request.signal.aborted && !signal.aborted && row.isConnected && !groups.hidden) {
        const moveFocus = previousStatus?.contains(document.activeElement)
        previousStatus?.remove()
        loading.textContent = `Could not load ${areaId ? projectLabel : areaLabel}. Try again.`
        addStatus(`Try loading ${areaId ? projectLabel : areaLabel} again`, after ?? "")
        if (moveFocus) groups.querySelector<HTMLButtonElement>(":scope > [data-board-group-status] button")?.focus()
      } else if (groupRequests.get(row) === request) {
        loading.remove()
      }
    } finally {
      if (groupRequests.get(row) === request) {
        groupRequests.delete(row)
        groups.setAttribute("aria-busy", "false")
      }
    }

    function addStatus(label: string, cursor: string | null) {
      const item = document.createElement("li")
      item.dataset.boardGroupStatus = ""
      if (cursor === null) item.textContent = label
      else {
        const button = document.createElement("button")
        button.type = "button"
        button.className = "btn btn-ghost"
        button.textContent = label
        button.addEventListener("click", () => {
          if (!groupRequests.has(row)) void loadGroups(row, boardId, cursor || null, areaId)
        }, { signal })
        item.append(button)
      }
      groups.append(item)
    }
  }

  function render(board: BoardShortcut) {
    const item = document.createElement("li")
    item.dataset.namedBoardShortcut = board.id
    item.dataset.workBoard = board.id
    const controls = document.createElement("div")
    controls.className = "sidebar-board-row"
    const link = document.createElement("a")
    link.className = "nav-link"
    link.href = safeIngressHref(boardWorkspaceHref(board.id))
    link.textContent = board.name
    const toggle = document.createElement("button")
    toggle.className = "btn btn-ghost sidebar-board-toggle"
    toggle.type = "button"
    toggle.textContent = "›"
    toggle.setAttribute("aria-label", `${areaLabel} in ${board.name}`)
    const groups = document.createElement("ul")
    groups.id = `board-shortcut-groups-${board.id}`
    groups.dataset.boardGroups = board.id
    toggle.setAttribute("aria-controls", groups.id)
    toggle.setAttribute("aria-expanded", String(openBoards.has(board.id)))
    groups.hidden = !openBoards.has(board.id)
    toggle.addEventListener("click", event => {
      event.stopPropagation()
      groups.hidden = !groups.hidden
      toggle.setAttribute("aria-expanded", String(!groups.hidden))
      if (groups.hidden) {
        openBoards.delete(board.id)
        savePreference()
        collapseGroups(item, groups)
      } else {
        openBoards.add(board.id)
        savePreference()
        void loadGroups(item, board.id)
      }
    }, { signal })
    const pinId = `board-${board.id}`
    const pinBtn = document.createElement("button")
    pinBtn.type = "button"
    pinBtn.className = "sidebar-board-pin"
    pinBtn.dataset.sidebarPinBoard = board.id
    pinBtn.setAttribute("aria-pressed", String(isBoardPinned(pinId)))
    pinBtn.setAttribute("aria-label", isBoardPinned(pinId) ? `Unpin ${board.name} from sidebar` : `Pin ${board.name} to sidebar`)
    pinBtn.title = isBoardPinned(pinId) ? `Unpin ${board.name}` : `Pin ${board.name} to sidebar`
    pinBtn.append(createTablerSvgElement("pin", 14))
    pinBtn.addEventListener("click", event => {
      event.preventDefault()
      event.stopPropagation()
      window.dispatchEvent(new CustomEvent(SIDEBAR_TOGGLE_SHORTCUT_PIN_EVENT, {
        detail: {
          id: pinId,
          label: board.name,
          href: boardWorkspaceHref(board.id),
          icon: "layout-kanban",
          section: "boards",
        },
      }))
    }, { signal })

    controls.append(link, pinBtn)
    if (areasEnabled) controls.append(toggle)
    item.append(controls)
    const pinned = document.createElement("div")
    pinned.dataset.boardPinned = ""
    pinned.className = "stree__pinned"
    pinned.hidden = true
    const pinnedList = document.createElement("div")
    pinnedList.dataset.boardPinnedList = ""
    pinnedList.className = "stree__pinned-list"
    pinned.append(pinnedList)
    item.append(pinned)
    if (areasEnabled) item.append(groups)
    const create = document.createElement("button")
    create.type = "button"
    create.className = "stree__new-area"
    create.dataset.boardNewArea = ""
    create.textContent = `+ New ${areaLabel.replace(/s$/, "")}`
    create.hidden = true
    create.addEventListener("click", () => actions?.newArea(item, () => { groups.hidden = false; openBoards.add(board.id); toggle.setAttribute("aria-expanded", "true"); void loadGroups(item, board.id) }), { signal })
    item.append(create)
    return item
  }

  function savePreference() {
    if (!loadedSession) return
    try {
      sessionStorage.setItem(`meitheal-board-disclosure-${loadedSession}`, JSON.stringify([...openBoards]))
      sessionStorage.setItem(`meitheal-board-project-disclosure-${loadedSession}`, JSON.stringify([...openAreas]))
    } catch { /* Optional preference */ }
  }

  function loadPreference(value: string, boards: BoardShortcut[]) {
    if (loadedSession === value) return
    openBoards.clear()
    openAreas.clear()
    loadedSession = value
    if (!value) return
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(`meitheal-board-disclosure-${value}`) ?? "[]")
      if (Array.isArray(saved)) for (const board of boards) if (saved.includes(board.id)) openBoards.add(board.id)
      const areas: unknown = JSON.parse(sessionStorage.getItem(`meitheal-board-project-disclosure-${value}`) ?? "[]")
      if (Array.isArray(areas)) for (const key of areas) if (typeof key === "string" && boards.some(board => key.startsWith(`${board.id}:`))) openAreas.add(key)
    } catch { /* Optional preference */ }
  }

  async function refresh() {
    if (document.hidden || !navigator.onLine) { clear(); return }
    directoryRequest?.abort()
    const request = new AbortController()
    directoryRequest = request
    let boards: BoardShortcut[] = []
    let key = ""
    let session = ""
    try {
      const response = await fetch("/api/boards", {
        cache: "no-store",
        signal: AbortSignal.any([signal, request.signal, AbortSignal.timeout(4_000)]),
      })
      if (response.ok) {
        const data = await response.json() as { boards?: BoardShortcut[] }
        boards = (data.boards ?? []).filter(board => !board.hidden && board.state === "active")
        const headerKey = response.headers.get("x-meitheal-board-view")?.trim() ?? ""
        key = headerKey || JSON.stringify(boards.map(board => [board.id, board.name]))
        session = response.headers.get("x-meitheal-board-session") ?? ""
      }
    } catch {
      // No cached Board is shown while the current directory cannot be verified.
    }
    if (request.signal.aborted || signal.aborted || document.hidden) return
    const needsRender = key !== directoryKey || (boards.length > 0 && !list.querySelector(":scope > [data-named-board-shortcut]"))
    if (needsRender) {
      loadPreference(session, boards)
      const active = boards.find(board => location.pathname.endsWith(boardWorkspaceHref(board.id)))
      if (active && (new URL(location.href).searchParams.has("area") || new URL(location.href).searchParams.has("from"))) openBoards.add(active.id)
      for (const pending of groupRequests.values()) pending.abort()
      groupRequests.clear()
      list.querySelectorAll(":scope > [data-named-board-shortcut], :scope > [data-board-empty]").forEach(item => item.remove())
      if (boards.length > 0) {
        list.append(...boards.map(render))
      } else {
        const empty = document.createElement("li")
        empty.dataset.boardEmpty = ""
        empty.className = "sidebar-board-empty"
        empty.textContent = "No boards yet"
        list.append(empty)
      }
      directoryKey = key
      for (const groupList of list.querySelectorAll<HTMLElement>("[data-board-groups]:not([hidden])")) {
        const row = groupList.closest("li")
        const id = groupList.dataset.boardGroups
        if (row && id) void loadGroups(row, id)
      }
    }
  }

  function readPinnedIds(): Set<string> {
    const raw = document.getElementById("sidebar")?.dataset.sidebarConfig
    if (!raw) return new Set()
    try {
      const parsed = JSON.parse(raw) as { customItems?: Array<{ id?: string }> }
      return new Set((parsed.customItems ?? []).map(entry => entry.id ?? "").filter(Boolean))
    } catch {
      return new Set()
    }
  }

  function isBoardPinned(pinId: string): boolean {
    return readPinnedIds().has(pinId)
  }

  function syncBoardPinButtons() {
    const pinnedIds = readPinnedIds()
    list.querySelectorAll<HTMLButtonElement>("[data-sidebar-pin-board]").forEach(btn => {
      const boardId = btn.dataset.sidebarPinBoard
      if (!boardId) return
      const pinned = pinnedIds.has(`board-${boardId}`)
      const boardName = btn.closest(".sidebar-board-row")?.querySelector<HTMLElement>(".nav-link")?.textContent?.trim() || "board"
      btn.setAttribute("aria-pressed", String(pinned))
      btn.setAttribute("aria-label", pinned ? `Unpin ${boardName} from sidebar` : `Pin ${boardName} to sidebar`)
      btn.title = pinned ? `Unpin ${boardName}` : `Pin ${boardName} to sidebar`
    })
  }

  const resume = () => { if (!document.hidden) void refresh() }
  triggerRefresh = resume
  const timer = setInterval(() => { void refresh() }, 10_000)
  signal.addEventListener("abort", () => {
    clearInterval(timer)
    directoryRequest?.abort()
    for (const request of groupRequests.values()) request.abort()
    groupRequests.clear()
    actions?.dispose()
  }, { once: true })
  window.addEventListener(SIDEBAR_CONFIG_UPDATED_EVENT, syncBoardPinButtons, { signal })
  document.addEventListener("visibilitychange", resume, { signal })
  window.addEventListener("focus", resume, { signal })
  window.addEventListener("offline", clear, { signal })
  window.addEventListener("online", resume, { signal })
  window.addEventListener("pagehide", clear, { signal })
  window.addEventListener("pageshow", event => { if (event.persisted) resume() }, { signal })
  resume()
}
