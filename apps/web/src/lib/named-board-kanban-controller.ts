import { getSelectedAreaId, initAreaSelector } from "./area-selector-controller"
import { safeFetch } from "./safe-fetch"
import { isDoneStatus } from "./status-config"
import { safeIngressHref } from "./ingress-navigation"
import { updateKanbanFilters } from "./kanban-query"
import { initUnifiedBarSearchLauncher } from "./unified-bar-controller"

function namedCaptureCapabilities(canCreate: boolean, signal: AbortSignal) {
  const previous = new Map<HTMLButtonElement, boolean>()
  const primary = document.getElementById("sidebar-rail-new-task") as HTMLButtonElement | null
  if (primary) { previous.set(primary, primary.disabled); primary.disabled = !canCreate }
  document.querySelectorAll<HTMLButtonElement>("[data-create-task-kind]").forEach(button => {
    previous.set(button, button.disabled)
    button.disabled = !canCreate || button.dataset.createTaskKind !== "standard_action"
    if (button.disabled) button.title = "This action is unavailable on this Board."
  })
  signal.addEventListener("abort", () => previous.forEach((disabled, button) => { button.disabled = disabled }), { once: true })
}

/** Planning capture opens the existing scoped inspector, keeping the selected Board, Area and Project. */
export function bindNamedBoardPlanningCapture(signal: AbortSignal) {
  const root = document.querySelector<HTMLElement>("[data-board-directory][data-board-id]:not([data-task-workspace])")
  if (!root || root.dataset.namedCaptureBound) return
  root.dataset.namedCaptureBound = "true"
  const canCreate = root.dataset.boardCanCreate === "true"
  namedCaptureCapabilities(canCreate, signal)
  const create = () => {
    if (!canCreate || !root.isConnected || !root.childElementCount) return
    const url = new URL(location.href)
    for (const key of ["view", "planning", "ticket"]) url.searchParams.delete(key)
    if (!url.searchParams.has("area") && !url.searchParams.has("project")) url.searchParams.set("area", "")
    url.searchParams.set("capture", "1")
    url.hash = "kanban"
    location.href = safeIngressHref(url.pathname + url.search + url.hash)
  }
  window.openNewTaskModal = create
  signal.addEventListener("abort", () => {
    delete root.dataset.namedCaptureBound
    if (window.openNewTaskModal === create) delete window.openNewTaskModal
  }, { once: true })
}

/** Named Boards use the common rendered cards, with versioned, grant-fenced Board operations. */
export function bindNamedBoardKanban(signal: AbortSignal) {
  const root = document.querySelector<HTMLElement>("[data-board-directory][data-task-workspace]")
  const board = root?.querySelector<HTMLElement>("#kanban-board")
  const overlay = root?.querySelector<HTMLElement>("#task-detail-overlay[data-named-board]")
  const panel = overlay?.querySelector<HTMLElement>("#task-detail-panel")
  if (!root || !board || !overlay || !panel || root.dataset.namedBound) return
  root.dataset.namedBound = "true"
  board.closest<HTMLElement>("#kanban-shell")!.dataset.kanbanBooted = "true"
  const canCreate = root.dataset.namedCanCreate === "true"
  const canEdit = root.dataset.namedCanEdit === "true"
  const canComplete = root.dataset.namedCanComplete === "true"
  let opener: HTMLElement | undefined
  let dragged: HTMLElement | undefined
  let pending = false
  const feedback = document.createElement("p")
  feedback.setAttribute("role", "status")
  feedback.dataset.namedKanbanFeedback = ""
  board.before(feedback)
  const newButton = document.getElementById("kanban-bar-new-task") as HTMLButtonElement | null
  if (newButton) newButton.disabled = !canCreate
  initUnifiedBarSearchLauncher("kanban-bar")
  initAreaSelector(signal)
  const entry = new URL(location.href)
  let restoringArea = !entry.searchParams.has("area") && !entry.searchParams.has("project") && Boolean(getSelectedAreaId())
  if (restoringArea) { board.style.visibility = "hidden"; if (newButton) newButton.disabled = true }
  namedCaptureCapabilities(canCreate && !restoringArea, signal)
  document.addEventListener("meitheal:area-catalog-ready", event => {
    if (!restoringArea || !root.isConnected) return
    const areaId = (event as CustomEvent<{ areaId: string }>).detail?.areaId
    const verified = typeof areaId === "string" && root.querySelector(`[data-area-id="${CSS.escape(areaId)}"]`)
    const url = new URL(location.href)
    url.searchParams.set("area", verified && typeof areaId === "string" ? areaId : "")
    location.href = safeIngressHref(url.pathname + url.search + url.hash)
  }, { signal })

  function close(restoreFocus = true) {
    overlay!.classList.remove("active")
    document.body.style.overflow = ""
    overlay!.querySelectorAll<HTMLElement>("[data-named-inspector-ticket], [data-named-inspector-create]").forEach(section => { section.hidden = true })
    if (restoreFocus && opener?.isConnected) opener.focus()
  }
  function open(id?: string, laneId?: string) {
    if (!root!.isConnected || !root!.childElementCount || signal.aborted) return
    if (restoringArea || (!id && !canCreate)) return
    close(false)
    const section = id ? overlay!.querySelector<HTMLElement>(`[data-named-inspector-ticket="${CSS.escape(id)}"]`)
      : overlay!.querySelector<HTMLElement>("[data-named-inspector-create]")
    if (!section) return
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    section.hidden = false
    if (laneId) {
      const lane = section.querySelector<HTMLSelectElement>('[name="laneId"]')
      if (lane) lane.value = laneId
    }
    overlay!.querySelector<HTMLElement>("[data-named-inspector-heading]")!.textContent = id ? "Task detail" : "New task"
    overlay!.classList.add("active")
    document.body.style.overflow = "hidden"
    section.querySelector<HTMLElement>("input, textarea, button")?.focus()
  }
  const create = () => open()
  window.openNewTaskModal = create
  const detail = (id: string) => open(id)
  window.openTaskDetail = detail
  newButton?.addEventListener("click", create, { signal })
  root.addEventListener("click", event => {
    const target = event.target
    if (!(target instanceof Element)) return
    const add = target.closest<HTMLElement>(".kanban-add-btn")
    if (add && !(add instanceof HTMLButtonElement && add.disabled)) {
      event.preventDefault()
      open(undefined, add.closest<HTMLElement>(".kanban-column")?.dataset.laneId)
      return
    }
    const card = target.closest<HTMLElement>(".kanban-card[data-named-ticket]")
    if (!card || target.closest("input, select, textarea")) return
    const link = target.closest("a")
    if (link && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0)) return
    event.preventDefault()
    open(card.dataset.namedTicket)
  }, { signal })
  overlay.querySelector("#td-close")?.addEventListener("click", () => close(), { signal })
  overlay.addEventListener("click", event => { if (event.target === overlay) close() }, { signal })
  document.addEventListener("keydown", event => {
    if (!overlay.classList.contains("active")) return
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key !== "Tab") return
    const controls = Array.from(panel.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], summary, [tabindex="0"]'))
      .filter(control => control.getClientRects().length && !control.hasAttribute("disabled"))
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }, { signal, capture: true })
  board.addEventListener("dragstart", event => {
    const card = (event.target as Element).closest<HTMLElement>(".kanban-card[data-named-ticket]")
    if (!canEdit || !card || pending) { event.preventDefault(); return }
    dragged = card
    event.dataTransfer?.setData("text/plain", card.dataset.id!)
    card.classList.add("dragging")
  }, { signal })
  board.addEventListener("dragend", () => { dragged?.classList.remove("dragging"); dragged = undefined }, { signal })
  board.addEventListener("dragover", event => { if (canEdit && dragged) event.preventDefault() }, { signal })
  board.addEventListener("drop", async event => {
    event.preventDefault()
    const card = dragged
    const lane = (event.target as Element).closest<HTMLElement>(".kanban-column")
    if (!card || !lane || !root.isConnected || pending || card.closest(".kanban-column") === lane) return
    if (!canComplete && isDoneStatus(card.dataset.status ?? "") !== isDoneStatus(lane.dataset.status ?? "")) {
      feedback.textContent = "Your Board permissions do not allow completing or reopening this task."
      return
    }
    pending = true
    card.setAttribute("aria-busy", "true")
    feedback.textContent = "Moving task…"
    try {
      const response = await safeFetch(`/api/boards/${encodeURIComponent(root.dataset.boardId!)}/tickets/${encodeURIComponent(card.dataset.id!)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", "X-Meitheal-Board-Session": root.dataset.boardSession! },
        body: JSON.stringify({ laneId: lane.dataset.laneId, version: Number(card.dataset.version) }), signal,
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || "Could not move the task. Refresh the Board and try again.")
      if (!signal.aborted && root.isConnected) location.reload()
    } catch (error) {
      if (!signal.aborted) feedback.textContent = error instanceof Error ? error.message : "Could not move the task."
    } finally { pending = false; card.removeAttribute("aria-busy") }
  }, { signal })
  document.addEventListener("meitheal:filter-change", event => {
    const { view, ...filters } = (event as CustomEvent).detail ?? {}
    if (view !== "kanban" || !root.isConnected) return
    const url = new URL(location.href)
    updateKanbanFilters(url, { ...filters, area: url.searchParams.get("area") ?? "" })
    url.searchParams.delete("ticket")
    location.href = safeIngressHref(url.pathname + url.search + "#kanban")
  }, { signal })
  document.addEventListener("meitheal:area-changed", event => {
    if (!root.isConnected) return
    const areaId = (event as CustomEvent<{ areaId: string }>).detail?.areaId
    if (typeof areaId !== "string") return
    const url = new URL(location.href)
    url.searchParams.delete("project")
    url.searchParams.delete("from")
    url.searchParams.delete("ticket")
    if (areaId) url.searchParams.set("area", areaId)
    else url.searchParams.set("area", "")
    location.href = safeIngressHref(url.pathname + url.search + "#kanban")
  }, { signal })
  root.addEventListener("meitheal:board-hidden", () => close(false), { signal })
  document.addEventListener("meitheal:home-assistant-area-saved", () => { if (root.isConnected) location.reload() }, { signal })
  signal.addEventListener("abort", () => {
    close(false)
    delete root.dataset.namedBound
    if (window.openNewTaskModal === create) delete window.openNewTaskModal
    if (window.openTaskDetail === detail) delete window.openTaskDetail
  }, { once: true })
  const initialTicket = new URL(location.href).searchParams.get("ticket")
  if (initialTicket) open(initialTicket)
  else if (new URL(location.href).searchParams.get("capture") === "1") {
    open()
    const url = new URL(location.href)
    url.searchParams.delete("capture")
    history.replaceState(history.state, "", url.pathname + url.search + url.hash)
  }
}
