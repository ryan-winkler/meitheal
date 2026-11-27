import { taskBackgroundUrl } from "@lib/task-page-url"
import { showToast } from "@lib/toast"

interface RefreshIntent {
  route: URL
  request?: AbortController
}

/** Read the current protected score view without starting a document navigation. */
export function createScoringPageRefresh(root: HTMLElement, lifetime: AbortSignal,
  apply: (html: Document) => void, onUnavailable?: () => void): () => void {
  const board = root.closest<HTMLElement>("[data-board-scope-root][data-board-authority]")
  if (!board) return () => {}
  const { boardId, boardAuthority } = board.dataset
  let intent: RefreshIntent | undefined
  let concealed = false

  const matchesBoard = (element: HTMLElement) => element.dataset.boardId === boardId && element.dataset.boardAuthority === boardAuthority
  const current = (pending: RefreshIntent) => {
    const route = taskBackgroundUrl()
    return !lifetime.aborted && matchesBoard(board) && board.dataset.boardExpired !== "true" &&
      pending.route.pathname === route.pathname && pending.route.search === route.search
  }
  const cancel = () => {
    const abandoned = intent
    intent = undefined
    abandoned?.request?.abort()
  }
  const invalidate = () => {
    cancel()
    onUnavailable?.()
  }
  board.addEventListener("meitheal:board-hidden", event => {
    if (event.target !== board) return
    concealed = true
    if (intent) {
      const request = intent.request
      delete intent.request
      request?.abort()
    }
  }, { signal: lifetime })
  board.addEventListener("meitheal:board-verified", event => {
    if (event.target !== board) return
    concealed = false
    queueMicrotask(() => { if (intent && !intent.request) void read(intent) })
  }, { signal: lifetime })
  document.addEventListener("meitheal:board-revoked", event => {
    if ((event as CustomEvent<{ boardId?: string }>).detail?.boardId === boardId) invalidate()
  }, { signal: lifetime })
  document.addEventListener("astro:before-preparation", invalidate, { signal: lifetime })
  window.addEventListener("pagehide", invalidate, { signal: lifetime })
  lifetime.addEventListener("abort", cancel, { once: true })

  async function read(pending: RefreshIntent): Promise<void> {
    if (!current(pending)) { invalidate(); return }
    if (concealed || !root.isConnected) return
    const request = new AbortController()
    pending.request = request
    const url = new URL(pending.route)
    url.hash = ""
    try {
      const response = await fetch(url, { // nosemgrep
        cache: "no-store", redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
        headers: { "x-meitheal-refresh": "1", "x-meitheal-session-recovery": "manual" },
      })
      if (!response.ok) throw new Error("Scoring view unavailable")
      const html = new DOMParser().parseFromString(await response.text(), "text/html")
      if (intent !== pending || pending.request !== request || !current(pending) || !root.isConnected) return
      const fresh = html.querySelector<HTMLElement>("[data-board-scope-root][data-board-authority]")
      if (!fresh || !matchesBoard(fresh)) throw new Error("Original Board context unavailable")
      apply(html)
    } catch {
      if (intent === pending && pending.request === request && current(pending) && root.isConnected) {
        showToast("Scores may have changed. Refresh the page to see the latest results.", "warning")
        onUnavailable?.()
      }
    } finally {
      if (intent === pending && pending.request === request) intent = undefined
    }
  }

  return () => {
    if (lifetime.aborted) return
    cancel()
    intent = { route: taskBackgroundUrl() }
    void read(intent)
  }
}
