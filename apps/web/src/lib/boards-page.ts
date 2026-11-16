import { confirmDialog } from "./confirm-dialog"
import { safeIngressHref } from "./ingress-navigation"

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
  const detach = () => { if (root.isConnected) root.replaceWith(placeholder) }
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
  const retry = root.querySelector<HTMLButtonElement>("[data-new-submission]")
  let permit: { destination: string; token: string; expiresAt: number } | undefined
  const showAssignment = () => {
    if (recipient) recipient.hidden = dest?.selectedOptions[0]?.dataset.recipient !== "true"
  }
  showAssignment()
  dest?.addEventListener("change", () => { permit = undefined; showAssignment() }, { signal })
  retry?.addEventListener("click", () => {
    permit = undefined
    retry.hidden = true
    retry.closest("form")?.querySelector<HTMLElement>('[name="title"]')?.focus()
  }, { signal })

  async function jsonRequest(path: string, method: string, body: object) {
    const response = await fetch(path, {
      method, body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "X-Meitheal-Board-Session": boardSession! },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    })
    const data = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) {
      const message = typeof data.error === "string" ? data.error : (typeof data.detail === "string" ? data.detail : "")
      if (response.status === 409 && retry) retry.hidden = false
      throw new Error(message || "Could not save. Refresh your Board and try again.")
    }
    return data
  }

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
    const api = boardId ? `/api/boards/${encodeURIComponent(boardId)}` : "/api/boards"
    const ticket = ticketId ? `${api}/tickets/${encodeURIComponent(ticketId)}` : api
    const feedback = form.querySelector<HTMLElement>("[data-board-feedback]")
    const button = form.querySelector<HTMLButtonElement>('[type="submit"]')
    if (!button || button.disabled) return
    if (boardForm === "task-delete" && !await confirmDialog({ message: "Delete this task?" })) return
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
        case "sidebar":
          await jsonRequest(api, "PATCH", { action: "sidebar", hidden: value("hidden") === "true" })
          break
        case "member":
          await jsonRequest(api, "PATCH", {
            action: "member", memberId: value("memberId"), role: value("role") === "remove" ? null : value("role"),
            denyCompletion: data.has("denyCompletion"), denyDeletion: data.has("denyDeletion"),
          })
          break
        case "policy":
          await jsonRequest(api, "PATCH", {
            action: "policy", denyCompletion: data.has("denyCompletion"),
            denyDeletion: data.has("denyDeletion"), denyAgentDeletion: data.has("denyAgentDeletion"),
          })
          break
        case "task-create":
          await jsonRequest(api + "/tickets", "POST", { ...content, laneId: value("laneId") })
          break
        case "task-edit":
          await jsonRequest(ticket, "PATCH", { ...content, version: Number(version) })
          break
        case "task-move":
          await jsonRequest(ticket, "PATCH", { laneId: value("laneId"), version: Number(version) })
          break
        case "task-delete":
          await jsonRequest(ticket, "DELETE", { version: Number(version) })
          break
        case "intake-create":
          await jsonRequest(api + "/intakes", "POST", {
            label: value("label"), laneId: value("laneId"), senderIds: data.getAll("senderIds"), recipientId: value("recipientId"),
          })
          break
        case "send": {
          const destination = value("destination")
          if (!permit || permit.destination !== destination || permit.expiresAt <= Date.now()) {
            const prepared = await jsonRequest("/api/board-intake", "POST", { action: "prepare", id: destination })
            if (typeof prepared.token !== "string" || typeof prepared.expiresAt !== "number") throw new Error("Could not prepare this submission.")
            permit = { destination, token: prepared.token, expiresAt: prepared.expiresAt }
          }
          await jsonRequest("/api/board-intake", "POST", {
            action: "send", token: permit.token, ...content, assignToRecipient: !recipient?.hidden && data.has("assign"),
          })
          permit = undefined
          form.reset()
          showAssignment()
          if (retry) retry.hidden = true
          if (feedback) feedback.textContent = "Task sent."
          return
        }
        default:
          return
      }
      if (!signal.aborted) window.location.reload()
    } catch (error) {
      if (!signal.aborted && feedback) {
        feedback.textContent = error instanceof Error && error.name === "Error" ? error.message : "Could not save. Your input is still here."
      }
    } finally {
      button.disabled = false
    }
  }, { signal })
}
