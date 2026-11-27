import { taskBackgroundUrl } from "@lib/task-page-url"
import { showToast } from "@lib/toast"

/** Read the current protected score view without starting a document navigation. */
export function createScoringPageRefresh(root: HTMLElement, lifetime: AbortSignal, apply: (html: Document) => void): () => void {
  const board = root.closest<HTMLElement>("[data-board-scope-root][data-board-authority]")
  let pending: AbortController | undefined

  return () => {
    if (lifetime.aborted || !root.isConnected || !board) return
    pending?.abort()
    const request = new AbortController()
    pending = request
    const signal = AbortSignal.any([lifetime, request.signal])
    const route = taskBackgroundUrl()
    const url = new URL(route)
    url.hash = ""
    const abort = () => request.abort()
    board.addEventListener("meitheal:board-hidden", abort, { signal })
    document.addEventListener("astro:before-preparation", abort, { signal })
    window.addEventListener("pagehide", abort, { signal })

    void (async () => {
      try {
        const response = await fetch(url, { // nosemgrep
          cache: "no-store", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          headers: { "x-meitheal-refresh": "1" },
        })
        if (!response.ok) throw new Error("Scoring view unavailable")
        const html = new DOMParser().parseFromString(await response.text(), "text/html")
        const fresh = html.querySelector<HTMLElement>("[data-board-scope-root][data-board-authority]")
        const current = taskBackgroundUrl()
        if (signal.aborted || !root.isConnected || route.pathname !== current.pathname || route.search !== current.search) return
        if (!fresh || fresh.dataset.boardId !== board.dataset.boardId || fresh.dataset.boardAuthority !== board.dataset.boardAuthority) return
        apply(html)
      } catch {
        if (!signal.aborted && root.isConnected) showToast("Scores saved. Refresh the page to see the updated results.", "warning")
      } finally {
        request.abort()
        if (pending === request) pending = undefined
      }
    })()
  }
}
