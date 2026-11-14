const BATCH_SIZE = 100

export function initKanbanReactionCounts(board: HTMLElement, signal: AbortSignal): void {
  const badges = new Map<string, HTMLElement[]>()
  for (const card of board.querySelectorAll<HTMLElement>(".kanban-card[data-id]")) {
    const badge = card.querySelector<HTMLElement>("[data-kanban-reaction-count]")
    const id = card.dataset.id
    if (!badge || !id) continue
    const current = badges.get(id)
    if (current) current.push(badge)
    else badges.set(id, [badge])
  }
  if (badges.size === 0) return
  const ids = [...badges.keys()]
  let pending: AbortController | undefined

  async function loadBatch(batch: string[], request: AbortSignal): Promise<void> {
    try {
      const params = new URLSearchParams({ ids: batch.join(",") })
      const response = await fetch(`/api/tasks/reaction-counts?${params}`, { // nosemgrep
        signal: AbortSignal.any([request, AbortSignal.timeout(10_000)]),
        cache: "no-store",
      })
      let counts: Record<string, number> = {}
      if (response.ok) {
        counts = (await response.json()).counts
      } else {
        void response.body?.cancel().catch(() => {})
        if (response.status !== 401 && response.status !== 403) return
      }
      if (request.aborted || !board.isConnected) return
      for (const id of batch) {
        const count = Object.hasOwn(counts, id) ? counts[id] ?? 0 : 0
        for (const badge of badges.get(id) ?? []) {
          badge.hidden = count <= 0
          badge.textContent = count > 0 ? String(count) : ""
          if (count > 0) badge.setAttribute("aria-label", board.dataset.reactionCountLabel?.replace("{count}", String(count)) ?? "")
          else badge.removeAttribute("aria-label")
        }
      }
    } catch {
      // Leave the board usable when the optional counts are unavailable.
    }
  }

  function refresh(): void {
    pending?.abort()
    pending = new AbortController()
    const request = AbortSignal.any([signal, pending.signal])
    for (let start = 0; start < ids.length; start += BATCH_SIZE) {
      void loadBatch(ids.slice(start, start + BATCH_SIZE), request)
    }
  }

  document.addEventListener("meitheal:task-reactions-changed", event => {
    if (badges.has((event as CustomEvent<string>).detail)) refresh()
  }, { signal })
  refresh()
}
