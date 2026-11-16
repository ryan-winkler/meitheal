import { safeIngressHref } from "./ingress-navigation"

export function bindSidebarBoards(signal: AbortSignal) {
  const list = document.querySelector<HTMLUListElement>("[data-sidebar-boards]")
  if (!list) return
  let active: AbortController | undefined
  let displayed = ""
  function clear() {
    active?.abort()
    displayed = ""
    list!.replaceChildren()
    list!.hidden = true
  }
  async function refresh() {
    if (document.hidden || !navigator.onLine) { clear(); return }
    active?.abort()
    const check = new AbortController()
    active = check
    try {
      const response = await fetch("/api/boards", {
        cache: "no-store",
        signal: AbortSignal.any([signal, check.signal, AbortSignal.timeout(4_000)]),
      })
      if (check.signal.aborted || signal.aborted) return
      if (!response.ok) { clear(); return }
      const key = response.headers.get("x-meitheal-board-view")
      const data = await response.json() as { boards?: Array<{ id: string; name: string; hidden: boolean; state: string }> }
      if (check.signal.aborted || signal.aborted || key === displayed) return
      const items = (data.boards ?? []).filter(board => !board.hidden && board.state === "active").map(board => {
        const item = document.createElement("li")
        const link = document.createElement("a")
        link.href = safeIngressHref(`/boards/${encodeURIComponent(board.id)}`)
        link.textContent = board.name
        item.append(link)
        return item
      })
      list!.replaceChildren(...items)
      list!.hidden = items.length === 0
      displayed = key ?? ""
    } catch {
      if (!signal.aborted && !check.signal.aborted) clear()
    }
  }
  const resume = () => { clear(); void refresh() }
  const interval = setInterval(() => { void refresh() }, 10_000)
  signal.addEventListener("abort", () => { clearInterval(interval); clear() }, { once: true })
  document.addEventListener("visibilitychange", resume, { signal })
  window.addEventListener("focus", resume, { signal })
  window.addEventListener("offline", clear, { signal })
  window.addEventListener("online", resume, { signal })
  window.addEventListener("pagehide", clear, { signal })
  window.addEventListener("pageshow", event => { if (event.persisted) resume() }, { signal })
  resume()
}
