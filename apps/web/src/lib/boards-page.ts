import { browserUuid } from "./browser-uuid"
import { confirmDialog } from "./confirm-dialog"
import { safeIngressHref, syncIngressDestination } from "./ingress-navigation"
import { safeFetch } from "./safe-fetch"

class BoardRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export function bindBoardPage(signal: AbortSignal) {
  const root = document.querySelector<HTMLElement>("[data-board-directory]")
  const status = document.querySelector<HTMLElement>("[data-board-expired]")
  if (!root || !status || root.dataset.bound) return
  const { boardKey, boardVerify, boardSession } = root.dataset
  if (!boardKey || !boardVerify || !boardSession) return
  root.dataset.bound = "true"

  let expired = false
  let checking: AbortController | undefined
  const placeholder = document.createComment("")
  const detach = () => {
    root.dispatchEvent(new Event("meitheal:board-hidden"))
    if (root.isConnected) root.replaceWith(placeholder)
  }
  const restore = () => { if (placeholder.isConnected) placeholder.replaceWith(root) }
  const expire = () => {
    expired = true
    detach()
    root.replaceChildren()
    status.hidden = false
  }
  async function recheck(beforeRevealing = false) {
    if (expired || signal.aborted) return
    checking?.abort()
    if (beforeRevealing || document.hidden) detach()
    if (document.hidden) return
    const active = new AbortController()
    checking = active
    try {
      const response = await fetch(boardVerify!, {
        method: "HEAD", cache: "no-store",
        signal: AbortSignal.any([signal, active.signal, AbortSignal.timeout(4_000)]),
      })
      if (active.signal.aborted || signal.aborted || document.hidden) return
      if (response.ok && response.headers.get("x-meitheal-board-view") === boardKey) restore()
      else if (response.ok || response.status === 403 || response.status === 404) expire()
      else detach()
    } catch {
      if (!active.signal.aborted && !signal.aborted) detach()
    }
  }
  const timer = setInterval(() => { void recheck() }, 10_000)
  signal.addEventListener("abort", () => {
    clearInterval(timer)
    delete root.dataset.bound
  }, { once: true })
  document.addEventListener("visibilitychange", () => { void recheck(true) }, { signal })
  window.addEventListener("focus", () => { void recheck(true) }, { signal })
  window.addEventListener("offline", () => { checking?.abort(); detach() }, { signal })
  window.addEventListener("online", () => { void recheck(true) }, { signal })
  window.addEventListener("pagehide", () => { checking?.abort(); detach() }, { signal })
  window.addEventListener("pageshow", event => { if (event.persisted) void recheck(true) }, { signal })
  status.querySelector("[data-board-refresh]")?.addEventListener("click", () => window.location.reload(), { signal })

  const dest = root.querySelector<HTMLSelectElement>('[name="destination"]')
  const recipient = root.querySelector<HTMLElement>("[data-board-recipient]")
  let submission: { id: string; content: string } | undefined
  const showAssignment = () => {
    if (recipient) recipient.hidden = dest?.selectedOptions[0]?.dataset.recipient !== "true"
  }
  showAssignment()
  dest?.addEventListener("change", showAssignment, { signal })

  async function jsonRequest(path: string, method: string, body: object) {
    const response = await safeFetch("/api/" + path, {
      method, body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "X-Meitheal-Board-Session": boardSession! },
      mode: "same-origin", redirect: "error", timeoutMs: 10_000, signal,
    })
    const data = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) {
      const message = typeof data.error === "string" ? data.error : (typeof data.detail === "string" ? data.detail : "")
      throw new BoardRequestError(message || "Could not save. Refresh your Board and try again.", response.status)
    }
    return data
  }

  const fragment = location.hash.slice(1)
  const current = new URL(location.href)
  if (root.dataset.boardId && ["groups", "projects", "goals", "routines", "group-settings", "project-settings"].includes(fragment)
      && current.searchParams.get("view") !== "groups") {
    current.searchParams.set("view", "groups")
    const target = current.pathname + current.search + current.hash
    syncIngressDestination(target)
    location.replace(target)
    return
  }
  const panel = document.getElementById(fragment)
  if (panel instanceof HTMLDetailsElement) {
    panel.open = true
    panel.querySelector("summary")?.focus()
  }

  root.addEventListener("toggle", async event => {
    const disclosure = event.target
    if (!(disclosure instanceof HTMLDetailsElement) || !disclosure.matches("[data-board-filing]") ||
        !disclosure.open || disclosure.dataset.loaded || !root.dataset.boardId) return
    const form = disclosure.querySelector<HTMLFormElement>("form")!
    const areas = form.querySelector<HTMLSelectElement>('[name="areaId"]')!
    const projects = form.querySelector<HTMLSelectElement>('[name="projectId"]')!
    const status = form.querySelector<HTMLElement>("[data-board-feedback]")!
    const save = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
    disclosure.dataset.loaded = "loading"
    try {
      const response = await fetch(`/api/boards/${encodeURIComponent(root.dataset.boardId)}?view=tasks&planning=1&ticket=${encodeURIComponent(form.dataset.ticketId ?? "")}`, {
        cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]),
      })
      if (!response.ok) throw new Error("Could not load placement choices.")
      const { planning, tasks } = await response.json() as {
        tasks?: Array<{ placement?: { areaId?: string; projectId?: string } }>
        planning?: {
          areas: Array<{ id: string; name: string }>
          projects: Array<{ id: string; title: string; status: string; areaId: string | null }>
        }
      }
      if (signal.aborted || expired) return
      if (!planning) throw new Error("Could not load placement choices.")
      const placement = tasks?.[0]?.placement
      const placedProject = planning.projects.find(project => project.id === placement?.projectId)
      const currentGroup = placedProject?.areaId ?? placement?.areaId
      for (const area of planning.areas) areas.add(new Option(area.name, area.id, false, currentGroup === area.id))
      const renderProjects = () => {
        const selected = projects.value
        projects.replaceChildren(new Option("No Project", ""))
        for (const project of planning.projects) {
          if (project.status !== "active" || (areas.value && project.areaId !== areas.value)) continue
          projects.add(new Option(project.title, project.id, false, selected === project.id))
        }
      }
      renderProjects()
      if (placedProject) projects.value = placedProject.id
      areas.addEventListener("change", renderProjects, { signal })
      areas.disabled = projects.disabled = save.disabled = false
      disclosure.dataset.loaded = "true"
      status.textContent = ""
    } catch {
      delete disclosure.dataset.loaded
      if (!signal.aborted && !expired) status.textContent = "Could not load placement choices. Close and reopen to try again."
    }
  }, { capture: true, signal })

  root.addEventListener("submit", async event => {
    const form = event.target
    if (!(form instanceof HTMLFormElement) || !form.dataset.boardForm) return
    event.preventDefault()
    if (expired || signal.aborted) return
    const { boardForm, ticketId, version } = form.dataset
    const data = new FormData(form)
    const value = (name: string) => String(data.get(name) ?? "")
    const content = { title: value("title"), description: value("description") }
    const boardId = form.dataset.boardId || root.dataset.boardId
    const api = boardId ? `boards/${encodeURIComponent(boardId)}` : "boards"
    const ticket = ticketId ? `${api}/tickets/${encodeURIComponent(ticketId)}` : api
    const feedback = form.querySelector<HTMLElement>("[data-board-feedback]")
    const button = form.querySelector<HTMLButtonElement>('[type="submit"]')
    if (!button || button.disabled) return
    if (boardForm === "task-delete" && !await confirmDialog({ message: "Delete this task?" })) return
    if (boardForm === "planning" && value("action") === "retire" && !await confirmDialog({ message: "Remove this item from active planning?" })) return
    if (boardForm === "lifecycle" && value("action") === "retire" && !await confirmDialog({
      message: `Delete ${value("boardName") || "this Board"}? Its work stays saved in Deleted Boards. Incoming work and Routines pause until you restore it.`,
    })) return
    button.disabled = true
    if (feedback) feedback.textContent = ""

    try {
      switch (boardForm) {
        case "create": {
          const result = await jsonRequest(api, "POST", { name: value("name") })
          if (typeof result.id === "string" && !result.accessPending) {
            window.location.href = safeIngressHref(`/boards/${encodeURIComponent(result.id)}`)
            return
          }
          if (feedback) feedback.textContent = "Board saved. Its access is still being verified."
          return
        }
        case "lifecycle": {
          const result = await jsonRequest(api, "PATCH", { action: value("action"), revision: Number(value("revision")) })
          if (result.accessPending) {
            if (feedback) feedback.textContent = "Board saved. Access is still being verified. Refresh Boards to check the result."
            return
          }
          window.location.href = safeIngressHref("/boards")
          return
        }
        case "sidebar":
          await jsonRequest(api, "PATCH", { action: "sidebar", hidden: value("hidden") === "true" })
          break
        case "member":
          await jsonRequest(api, "PATCH", {
            action: "member", memberId: value("memberId"), role: value("role") === "remove" ? null : value("role"),
            denyCompletion: data.has("denyCompletion"), denyDeletion: data.has("denyDeletion"),
          })
          break
        case "agent":
          await jsonRequest(api, "PATCH", { action: "agent", tokenId: value("tokenId").trim(), enabled: value("enabled") === "true" })
          break
        case "policy":
          await jsonRequest(api, "PATCH", {
            action: "policy", denyCompletion: data.has("denyCompletion"),
            denyDeletion: data.has("denyDeletion"), denyAgentDeletion: data.has("denyAgentDeletion"),
          })
          break
        case "task-create":
          await jsonRequest(api + "/tickets", "POST", {
            ...content, laneId: value("laneId"), ...(value("due_date") ? { due_date: value("due_date") } : {}),
            ...(value("home_assistant_area_id") ? { home_assistant_area_id: value("home_assistant_area_id") } : {}),
            placement: { areaId: value("areaId") || null, projectId: value("projectId") || null },
          })
          break
        case "task-edit":
          await jsonRequest(ticket, "PATCH", { ...content, version: Number(version), ...(data.has("due_date") ? { due_date: value("due_date") || null } : {}) })
          break
        case "task-file":
          await jsonRequest(ticket, "PATCH", {
            action: "file", version: Number(version), areaId: value("areaId") || null, projectId: value("projectId") || null,
          })
          break
        case "task-move":
          await jsonRequest(ticket, "PATCH", { laneId: value("laneId"), version: Number(version) })
          break
        case "task-delete":
          await jsonRequest(ticket, "DELETE", { version: Number(version) })
          break
        case "planning": {
          const linkedEntity = value("linkedEntity")
          const [entityType, linkedId] = linkedEntity.split("/", 2)
          const result = await jsonRequest(api + "/planning", "POST", {
            action: value("action"), ...content, areaId: value("areaId"), goalId: value("goalId") || null,
            ...(linkedId ? { id: linkedId, entityType } : data.has("id") ? { id: value("id") } : {}),
            ...(data.has("entityType") ? { entityType: value("entityType") } : {}),
            ...(data.has("pillarId") ? { pillarId: value("pillarId"), nonNegotiable: data.has("nonNegotiable") } : {}),
            ...(data.has("enabled") ? { enabled: value("enabled") === "true" } : {}),
            ...(data.has("entity") ? { entity: value("entity") } : {}),
            ...(data.has("status") ? { status: value("status") } : {}),
            ...(data.has("icon") ? { icon: value("icon") } : {}),
            ...(data.has("color") ? { color: value("color") } : {}),
            ...(data.has("cadence") ? { cadence: value("cadence") } : {}),
            ...(data.has("projectId") ? { projectId: value("projectId") || null } : {}),
            ...(data.has("period") ? { period: value("period") } : {}),
          })
          if (result.accessPending && feedback) {
            feedback.textContent = "Saved. Board access is still being verified."
            return
          }
          break
        }
        case "intake-create":
          await jsonRequest(api + "/intakes", "POST", {
            label: value("label"), laneId: value("laneId"), senderIds: data.getAll("senderIds"), recipientId: value("recipientId"),
          })
          break
        case "intake-toggle":
          await jsonRequest(api + "/intakes", "PATCH", { id: value("id"), enabled: value("enabled") === "true" })
          break
        case "send": {
          if (!content.title.trim()) throw new Error("Enter a task title.")
          const payload = { ...content, id: value("destination"), assignToRecipient: !recipient?.hidden && data.has("assign") }
          const signature = JSON.stringify(payload)
          if (submission && submission.content !== signature) {
            throw new Error("Retry the original submission or refresh Boards to review it before starting another.")
          }
          submission ??= { id: browserUuid(), content: signature }
          try {
            await jsonRequest("board-intake", "POST", { action: "prepare", ...payload, resumeId: submission.id })
          } catch (error) {
            if (error instanceof BoardRequestError && [400, 403, 404, 429].includes(error.status)) submission = undefined
            throw error
          }
          const result = await jsonRequest("board-intake", "POST", { action: "retry", resumeId: submission.id })
          submission = undefined
          form.reset()
          showAssignment()
          if (feedback) feedback.textContent = "Task sent. Receipt " + String(result.acknowledgement)
          return
        }
        case "retry-send": {
          const result = await jsonRequest("board-intake", "POST", { action: "retry", resumeId: value("resumeId") })
          if (feedback) feedback.textContent = "Task sent. Receipt " + String(result.acknowledgement)
          button.hidden = true
          return
        }
        default:
          return
      }
      if (!signal.aborted) window.location.reload()
    } catch (error) {
      if (!signal.aborted && feedback) {
        feedback.textContent = error instanceof Error ? error.message : "Could not save. Your input is still here."
      }
    } finally {
      button.disabled = false
    }
  }, { signal })
}
