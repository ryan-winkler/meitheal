import { boardWorkspaceHref } from "../board-workspace"
import { safeIngressHref } from "../ingress-navigation"
import { safeFetch } from "../safe-fetch"

type Routine = { id: string; name: string; boardId: string; boardName: string; period: string; cadence: string; complete: boolean; canComplete: boolean }

export function setupBoardRoutineCheckins(signal: AbortSignal) {
  const section = document.querySelector<HTMLElement>("[data-board-routine-checkins]")
  const list = section?.querySelector<HTMLElement>("[data-board-routine-list]")
  const feedback = section?.querySelector<HTMLElement>("[data-board-routine-feedback]")
  const more = section?.querySelector<HTMLElement>("[data-board-routine-more]")
  if (!section || !list || !feedback || !more) return
  let pending: AbortController | undefined
  let session = ""
  let items: Routine[] = []
  let saving = false
  let uncertain: { item: Routine; proof: string } | undefined
  const showUnconfirmed = () => {
    feedback.replaceChildren(document.createTextNode("Could not confirm the check-in. "))
    if (!uncertain || uncertain.proof !== session) return
    const retry = document.createElement("button")
    retry.type = "button"
    retry.className = "btn btn-ghost"
    retry.dataset.boardRoutineRetry = ""
    retry.textContent = "Retry the same check-in"
    feedback.append(retry)
  }
  const clear = () => {
    pending?.abort()
    items = []
    session = ""
    section.hidden = true
    list.replaceChildren()
    feedback.textContent = ""
  }
  const refresh = async () => {
    if (signal.aborted || document.hidden || !navigator.onLine || saving) return
    pending?.abort()
    const request = new AbortController()
    pending = request
    const active = AbortSignal.any([signal, request.signal])
    try {
      const response = await safeFetch("/api/boards/routines", { cache: "no-store", signal: active })
      if (!response.ok) throw new Error("Unavailable")
      const data: { items: Routine[]; hasMore: boolean } = await response.json()
      if (active.aborted || document.hidden) return
      session = response.headers.get("x-meitheal-board-session") ?? ""
      items = data.items
      if (uncertain && uncertain.proof !== session) uncertain = undefined
      if (uncertain && items.some(item => item.id === uncertain!.item.id && item.period === uncertain!.item.period && item.complete)) {
        uncertain = undefined
        feedback.textContent = "Saved"
      }
      list.replaceChildren(...items.map(item => {
        const row = document.createElement("li")
        row.className = "list-group-item"
        const link = document.createElement("a")
        link.href = safeIngressHref(boardWorkspaceHref(item.boardId, { groups: true }, "routines"))
        link.textContent = item.name
        const context = document.createElement("p")
        context.className = "text-muted"
        context.textContent = `${item.boardName} · ${item.cadence}${item.complete ? " · Done" : ""}`
        row.append(link, context)
        if (item.canComplete && !item.complete && session && uncertain?.item.id !== item.id) {
          const button = document.createElement("button")
          button.type = "button"
          button.className = "btn btn-ghost"
          button.textContent = "Mark done"
          button.setAttribute("aria-label", `Mark ${item.name} done`)
          button.dataset.boardRoutineId = item.id
          row.append(button)
        }
        return row
      }))
      more.hidden = !data.hasMore
      section.hidden = items.length === 0 && !uncertain
      if (uncertain) showUnconfirmed()
    } catch {
      if (!active.aborted) {
        clear()
        section.hidden = false
        feedback.textContent = "Board check-ins are unavailable. Reconnect and refresh to review them."
      }
    }
  }
  section.addEventListener("click", async event => {
    const target = event.target as Element
    const button = target.closest<HTMLButtonElement>("[data-board-routine-id], [data-board-routine-retry]")
    const retry = button?.hasAttribute("data-board-routine-retry")
    const item = retry ? uncertain?.item : items.find(row => row.id === button?.dataset.boardRoutineId)
    const proof = retry ? uncertain?.proof : session
    if (!button || !item || saving || !proof || proof !== session) return
    saving = true
    button.disabled = true
    feedback.textContent = "Saving…"
    try {
      const response = await safeFetch(`/api/boards/${encodeURIComponent(item.boardId)}/planning`, {
        method: "POST", signal, headers: { "content-type": "application/json", "x-meitheal-board-session": proof },
        body: JSON.stringify({ action: "routine-complete", id: item.id, period: item.period }),
      })
      uncertain = undefined
      if (session === proof) feedback.textContent = response.ok ? "Saved" : "The check-in is unavailable. Refresh to review its current period and permissions."
    } catch {
      uncertain = { item, proof }
      if (session === proof) showUnconfirmed()
    } finally {
      saving = false
      await refresh()
    }
  }, { signal })
  const recheck = () => { clear(); void refresh() }
  document.addEventListener("visibilitychange", recheck, { signal })
  window.addEventListener("focus", recheck, { signal })
  window.addEventListener("offline", clear, { signal })
  window.addEventListener("online", recheck, { signal })
  window.addEventListener("pagehide", clear, { signal })
  window.addEventListener("pageshow", event => { if (event.persisted) recheck() }, { signal })
  const timer = setInterval(() => { void refresh() }, 10_000)
  signal.addEventListener("abort", () => { clearInterval(timer); clear() }, { once: true })
  void refresh()
}
