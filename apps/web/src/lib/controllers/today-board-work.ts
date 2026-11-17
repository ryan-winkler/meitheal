import { boardWorkspaceHref } from "../board-workspace"
import { safeIngressHref } from "../ingress-navigation"
import { safeFetch } from "../safe-fetch"

interface BoardWork {
  id: string
  title: string
  dueDate: string
  boardId: string
  boardName: string
}

export function setupTodayBoardWork(signal: AbortSignal) {
  const section = document.querySelector<HTMLElement>("[data-today-board-work]")
  const list = section?.querySelector<HTMLElement>("[data-today-board-links]")
  const more = section?.querySelector<HTMLElement>("[data-today-board-more]")
  if (!section || !list || !more) return
  let pending: AbortController | undefined

  const clear = () => {
    pending?.abort()
    section.hidden = true
    list.replaceChildren()
  }
  const refresh = async () => {
    if (document.hidden || !navigator.onLine || signal.aborted) return
    pending?.abort()
    const request = new AbortController()
    pending = request
    const active = AbortSignal.any([signal, request.signal])
    try {
      const response = await safeFetch("/api/boards/due-today", { cache: "no-store", signal: active })
      if (!response.ok) throw new Error("Board work is unavailable")
      const { items, hasMore }: { items: BoardWork[]; hasMore: boolean } = await response.json()
      if (active.aborted || document.hidden) return
      list.replaceChildren(...items.map(item => {
        const row = document.createElement("li")
        row.className = "list-group-item"
        const link = document.createElement("a")
        link.href = safeIngressHref(boardWorkspaceHref(item.boardId, { ticket: item.id }))
        link.textContent = item.title
        const context = document.createElement("div")
        context.className = "text-muted"
        context.append(item.boardName, " · ")
        const date = document.createElement("time")
        date.dateTime = item.dueDate
        date.textContent = item.dueDate
        context.append(date)
        row.append(link, context)
        return row
      }))
      more.hidden = !hasMore
      section.hidden = items.length === 0
    } catch {
      if (!active.aborted) clear()
    }
  }
  const recheck = () => {
    clear()
    if (!document.hidden) void refresh()
  }
  document.addEventListener("visibilitychange", recheck, { signal })
  window.addEventListener("focus", recheck, { signal })
  window.addEventListener("offline", clear, { signal })
  window.addEventListener("online", recheck, { signal })
  window.addEventListener("pagehide", clear, { signal })
  window.addEventListener("pageshow", event => { if (event.persisted) recheck() }, { signal })
  const timer = setInterval(() => { void refresh() }, 10_000)
  signal.addEventListener("abort", () => {
    clearInterval(timer)
    clear()
  }, { once: true })
  void refresh()
}
