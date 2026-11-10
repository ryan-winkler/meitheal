import { INACTIVITY_TASK_CHANGED, InactivityRequestError, requestInactivity } from "@lib/inactivity-client"

export function initKanbanInactivity(board: HTMLElement, signal: AbortSignal) {
  if (!window.isSecureContext || board.dataset.inactivityEnabled !== "true") return
  const cards = Array.from(board.querySelectorAll<HTMLElement>(".kanban-card[data-id]"))
  const displayed = new Map(cards.map(card => [card.dataset.id!, card]))
  const versions = new Map<string, number>()
  let generation = 0
  let requests = new AbortController()

  function clear() {
    requests.abort()
    requests = new AbortController()
    board.querySelectorAll("[data-inactivity-cue]").forEach(cue => cue.remove())
  }

  function addCue(card: HTMLElement, label: string | undefined) {
    if (!label) return
    const cue = document.createElement("span")
    cue.dataset.inactivityCue = ""
    cue.className = "kanban-inactivity-cue"
    cue.textContent = label
    card.querySelector("[data-inactivity-slot]")?.append(cue)
  }

  function refresh(taskId?: string) {
    if (signal.aborted || !navigator.onLine) return
    const ids = taskId ? (displayed.has(taskId) ? [taskId] : []) : [...displayed.keys()]
    if (!taskId) clear()
    const current = ++generation
    const lifetime = AbortSignal.any([signal, requests.signal])
    for (const id of ids) {
      versions.set(id, current)
      displayed.get(id)?.querySelectorAll("[data-inactivity-cue]").forEach(cue => cue.remove())
    }
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100)
      void requestInactivity({ action: "board", ids: chunk }, lifetime).then(({ now, cues, stalled }) => {
        if (lifetime.aborted) return
        for (const id of chunk) {
          if (versions.get(id) !== current) continue
          const card = displayed.get(id)!
          const deadline = cues[id]
          if (typeof deadline === "number") addCue(card, deadline <= now ? board.dataset.inactivityReady : board.dataset.inactivityUpcoming)
          if (typeof stalled?.[id] === "number") addCue(card, board.dataset.inactivityStalled)
        }
      }).catch(error => {
        const denied = error instanceof InactivityRequestError && (error.status === 401 || error.status === 403)
        if (!lifetime.aborted && (denied || chunk.some(id => versions.get(id) === current))) clear()
      })
    }
  }

  window.addEventListener("pagehide", clear, { signal })
  window.addEventListener("offline", clear, { signal })
  signal.addEventListener("abort", clear, { once: true })
  let lastForeground = -Infinity
  function onForeground() {
    if (document.visibilityState !== "visible" || performance.now() - lastForeground < 50) return
    lastForeground = performance.now()
    refresh()
  }
  window.addEventListener("focus", onForeground, { signal })
  window.addEventListener("online", () => refresh(), { signal })
  document.addEventListener("visibilitychange", onForeground, { signal })
  window.addEventListener(INACTIVITY_TASK_CHANGED, event => refresh((event as CustomEvent<string | undefined>).detail), { signal })
  refresh()
}
