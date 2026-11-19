import { boardWorkspaceHref } from "./board-workspace"
import { safeIngressHref } from "./ingress-navigation"

interface BoardShortcut { id: string; name: string; hidden: boolean; state: string }
interface GroupChoice { id: string; name: string; icon?: string }
interface GroupPage { items: GroupChoice[]; selected?: GroupChoice | null; next_cursor: string | null }

export function bindSidebarBoards(signal: AbortSignal) {
  const children = document.querySelector<HTMLElement>("[data-sidebar-board-children]")
  const parentToggle = document.querySelector<HTMLButtonElement>("[data-sidebar-boards-toggle]")
  if (children && parentToggle) {
    const navbar = () => innerWidth > 768 && document.documentElement.dataset.appearanceNavigation === "navbar"
    const popup = () => navbar() && !children.closest("[data-nav-overflow-menu]")
    const setCollapsed = (collapsed: boolean) => {
      children.hidden = collapsed
      parentToggle.setAttribute("aria-expanded", String(!children.hidden))
      try { sessionStorage.setItem("meitheal-boards-collapsed", String(children.hidden)) } catch { /* Optional preference */ }
    }
    try {
      const remembered = sessionStorage.getItem("meitheal-boards-collapsed")
      children.hidden = remembered === null ? navbar() : remembered === "true"
    } catch { children.hidden = navbar() }
    parentToggle.setAttribute("aria-expanded", String(!children.hidden))
    parentToggle.addEventListener("click", () => setCollapsed(!children.hidden), { signal })
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
  const root = document.querySelector<HTMLUListElement>("[data-sidebar-boards]")
  if (!root) return
  const list = root
  let directoryRequest: AbortController | undefined
  let directoryKey = ""
  let loadedSession = ""
  const groupRequests = new Map<HTMLElement, AbortController>()
  const openBoards = new Set<string>()
  const openAreas = new Set<string>()
  const areasEnabled = list.dataset.areasEnabled === "true"
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
      const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}?${query}`, {
        cache: "no-store",
        signal: AbortSignal.any([signal, request.signal, AbortSignal.timeout(4_000)]),
      })
      if (request.signal.aborted || signal.aborted || !row.isConnected || groups.hidden) {
        if (groupRequests.get(row) === request) loading.remove()
        return
      }
      if ([401, 403, 404].includes(response.status)) { clear(); return }
      if (!response.ok) throw new Error("Could not load choices.")
      const data = await response.json() as GroupPage
      if (request.signal.aborted || signal.aborted || !row.isConnected || groups.hidden) {
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
        const link = document.createElement("a")
        link.className = "nav-link"
        link.href = safeIngressHref(boardWorkspaceHref(boardId, areaId ? { project: group.id, fromArea: areaId } : { area: group.id }))
        link.textContent = group.name
        firstNewLink ??= link
        child.dataset.groupChoice = group.id
        if (current.pathname.endsWith(boardWorkspaceHref(boardId)) && current.searchParams.get(areaId ? "project" : "area") === group.id) {
          link.setAttribute("aria-current", "page")
        }
        if (!areaId && projectsEnabled) {
          const controls = document.createElement("div")
          controls.className = "sidebar-board-row"
          const projects = document.createElement("ul")
          projects.id = `board-shortcut-projects-${boardId}-${group.id}`
          projects.dataset.boardProjects = group.id
          const key = `${boardId}:${group.id}`
          const selected = current.pathname.endsWith(boardWorkspaceHref(boardId)) && current.searchParams.get("from") === group.id
          if (selected) openAreas.add(key)
          projects.hidden = !openAreas.has(key)
          const toggle = document.createElement("button")
          toggle.className = "btn btn-ghost sidebar-board-toggle"
          toggle.type = "button"
          toggle.textContent = "›"
          toggle.setAttribute("aria-label", `${projectLabel} in ${group.name}`)
          toggle.setAttribute("aria-controls", projects.id)
          toggle.setAttribute("aria-expanded", String(!projects.hidden))
          toggle.addEventListener("click", () => {
            projects.hidden = !projects.hidden
            toggle.setAttribute("aria-expanded", String(!projects.hidden))
            if (projects.hidden) {
              openAreas.delete(key)
              collapseGroups(child, projects)
            } else {
              openAreas.add(key)
              void loadGroups(child, boardId, null, group.id)
            }
            savePreference()
          }, { signal })
          controls.append(link, toggle)
          child.append(controls, projects)
          groups.append(child)
          if (!projects.hidden) void loadGroups(child, boardId, null, group.id)
        } else {
          child.append(link)
          groups.append(child)
        }
      }
      if (data.next_cursor || !groups.childElementCount) {
        addStatus(data.next_cursor ? `Show more ${areaId ? projectLabel : areaLabel}` : `No ${areaId ? projectLabel : areaLabel} yet`, data.next_cursor)
      }
      if (moveFocus) (firstNewLink
        ?? groups.querySelector<HTMLButtonElement>(":scope > [data-board-group-status] button")
        ?? row.querySelector<HTMLButtonElement>(":scope > .sidebar-board-row > button"))?.focus()
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
    toggle.addEventListener("click", () => {
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
    controls.append(link)
    if (areasEnabled) controls.append(toggle)
    item.append(controls)
    if (areasEnabled) item.append(groups)
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
    let key = "household"
    let session = ""
    try {
      const response = await fetch("/api/boards", {
        cache: "no-store",
        signal: AbortSignal.any([signal, request.signal, AbortSignal.timeout(4_000)]),
      })
      if (response.ok) {
        const data = await response.json() as { boards?: BoardShortcut[]; household?: { state: string } }
        const household = document.querySelector<HTMLElement>("[data-sidebar-household]")
        if (household && data.household) household.hidden = data.household.state !== "active"
        boards = (data.boards ?? []).filter(board => !board.hidden && board.state === "active")
        key = response.headers.get("x-meitheal-board-view") ?? key
        session = response.headers.get("x-meitheal-board-session") ?? ""
      }
    } catch {
      // The shared Board is available even without a private Home Assistant session.
    }
    if (request.signal.aborted || signal.aborted || document.hidden) return
    if (key !== directoryKey) {
      loadPreference(session, boards)
      const active = boards.find(board => location.pathname.endsWith(boardWorkspaceHref(board.id)))
      if (active && (new URL(location.href).searchParams.has("area") || new URL(location.href).searchParams.has("from"))) openBoards.add(active.id)
      for (const pending of groupRequests.values()) pending.abort()
      groupRequests.clear()
      list.querySelectorAll(":scope > [data-named-board-shortcut]").forEach(item => item.remove())
      list.append(...boards.map(render))
      directoryKey = key
      for (const groupList of list.querySelectorAll<HTMLElement>("[data-board-groups]:not([hidden])")) {
        const row = groupList.closest("li")
        const id = groupList.dataset.boardGroups
        if (row && id) void loadGroups(row, id)
      }
    }
  }

  const resume = () => { clear(); void refresh() }
  const timer = setInterval(() => { void refresh() }, 10_000)
  signal.addEventListener("abort", () => { clearInterval(timer); clear() }, { once: true })
  document.addEventListener("visibilitychange", resume, { signal })
  window.addEventListener("focus", resume, { signal })
  window.addEventListener("offline", clear, { signal })
  window.addEventListener("online", resume, { signal })
  window.addEventListener("pagehide", clear, { signal })
  window.addEventListener("pageshow", event => { if (event.persisted) resume() }, { signal })
  resume()
}
