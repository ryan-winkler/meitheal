import { boardWorkspaceHref } from "./board-workspace"
import { safeIngressHref } from "./ingress-navigation"

interface BoardShortcut { id: string; name: string; hidden: boolean; state: string }
interface GroupChoice { id: string; name: string; icon?: string }
interface GroupPage { items: GroupChoice[]; selected?: GroupChoice | null; next_cursor: string | null }

export function bindSidebarBoards(signal: AbortSignal) {
  const root = document.querySelector<HTMLUListElement>("[data-sidebar-boards]")
  if (!root) return
  const list = root
  let directoryRequest: AbortController | undefined
  let directoryKey = ""
  let loadedSession = ""
  const groupRequests = new Map<HTMLElement, AbortController>()
  const openBoards = new Set<string>()

  function clear() {
    directoryRequest?.abort()
    directoryKey = ""
    for (const request of groupRequests.values()) request.abort()
    groupRequests.clear()
    list.replaceChildren()
    list.hidden = true
  }

  async function loadGroups(row: HTMLElement, boardId: string, after: string | null = null) {
    groupRequests.get(row)?.abort()
    const request = new AbortController()
    groupRequests.set(row, request)
    const groups = row.querySelector<HTMLUListElement>("[data-board-groups]")!
    if (!after) groups.replaceChildren()
    const query = new URLSearchParams({ view: "groups" })
    if (after) query.set("after", after)
    const current = new URL(location.href)
    const activeGroup = current.pathname.endsWith(boardWorkspaceHref(boardId)) ? current.searchParams.get("area") : null
    if (!after && activeGroup) query.set("selected", activeGroup)
    try {
      const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}?${query}`, {
        cache: "no-store",
        signal: AbortSignal.any([signal, request.signal, AbortSignal.timeout(4_000)]),
      })
      if (!response.ok) throw new Error("Could not load groups.")
      const data = await response.json() as GroupPage
      if (request.signal.aborted || signal.aborted || !row.isConnected || groups.hidden) return
      groups.querySelector("[data-board-group-status]")?.remove()
      const choices = data.selected && !data.items.some(item => item.id === data.selected?.id)
        ? [data.selected, ...data.items] : data.items
      const displayed = new Set([...groups.querySelectorAll<HTMLElement>("[data-group-choice]")].map(item => item.dataset.groupChoice))
      for (const group of choices) {
        if (displayed.has(group.id)) continue
        const child = document.createElement("li")
        const link = document.createElement("a")
        link.className = "nav-link"
        link.href = safeIngressHref(boardWorkspaceHref(boardId, { area: group.id }))
        link.textContent = group.name
        child.dataset.groupChoice = group.id
        if (current.pathname.endsWith(boardWorkspaceHref(boardId)) && current.searchParams.get("area") === group.id) {
          link.setAttribute("aria-current", "page")
        }
        child.append(link)
        groups.append(child)
      }
      if (data.next_cursor || !groups.childElementCount) {
        addStatus(data.next_cursor ? "Show more groups" : "No groups yet", data.next_cursor)
      }
    } catch {
      if (!request.signal.aborted && !signal.aborted && row.isConnected && !groups.hidden) {
        groups.replaceChildren()
        addStatus("Try loading groups again", "")
      }
    } finally {
      if (groupRequests.get(row) === request) groupRequests.delete(row)
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
        button.addEventListener("click", () => { void loadGroups(row, boardId, cursor || null) }, { signal })
        item.append(button)
      }
      groups.append(item)
    }
  }

  function render(board: BoardShortcut) {
    const item = document.createElement("li")
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
    toggle.setAttribute("aria-label", `${list.dataset.boardGroupLabel ?? "Groups"} in ${board.name}`)
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
        groupRequests.get(item)?.abort()
        groups.replaceChildren()
      } else {
        openBoards.add(board.id)
        savePreference()
        void loadGroups(item, board.id)
      }
    }, { signal })
    controls.append(link, toggle)
    item.append(controls, groups)
    return item
  }

  function savePreference() {
    if (!loadedSession) return
    try { sessionStorage.setItem(`meitheal-board-disclosure-${loadedSession}`, JSON.stringify([...openBoards])) } catch { /* Optional preference */ }
  }

  function loadPreference(value: string, boards: BoardShortcut[]) {
    if (loadedSession === value) return
    openBoards.clear()
    loadedSession = value
    if (!value) return
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(`meitheal-board-disclosure-${value}`) ?? "[]")
      if (Array.isArray(saved)) for (const board of boards) if (saved.includes(board.id)) openBoards.add(board.id)
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
        const data = await response.json() as { boards?: BoardShortcut[] }
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
      if (active && new URL(location.href).searchParams.has("area")) openBoards.add(active.id)
      for (const pending of groupRequests.values()) pending.abort()
      groupRequests.clear()
      list.replaceChildren(...boards.map(render))
      list.hidden = boards.length === 0
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
