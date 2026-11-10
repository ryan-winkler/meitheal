import { requestInactivity } from "@lib/inactivity-client"

export function initKanbanInactivity(board: HTMLElement, signal: AbortSignal) {
  if (!window.isSecureContext || board.dataset.inactivityEnabled !== "true") return
  const cards = Array.from(board.querySelectorAll<HTMLElement>(".kanban-card[data-id]"))
  const displayed = new Map(cards.map(card => [card.dataset.id!, card]))
  const ids = [...displayed.keys()]
  const requests = new AbortController()
  const lifetime = AbortSignal.any([signal, requests.signal])

  function clear() {
    requests.abort()
    board.querySelectorAll("[data-inactivity-cue]").forEach(cue => cue.remove())
  }

  window.addEventListener("pagehide", clear, { signal, once: true })
  window.addEventListener("offline", clear, { signal, once: true })
  signal.addEventListener("abort", clear, { once: true })
  for (let i = 0; i < ids.length; i += 100) {
    void requestInactivity({ action: "board", ids: ids.slice(i, i + 100) }, lifetime).then(({ now, cues }) => {
      if (lifetime.aborted) return
      for (const [id, deadline] of Object.entries(cues)) {
        const card = displayed.get(id)
        if (!card) continue
        const cue = document.createElement("span")
        cue.dataset.inactivityCue = ""
        cue.className = "kanban-inactivity-cue"
        cue.textContent = (deadline <= now ? board.dataset.inactivityReady : board.dataset.inactivityUpcoming) ?? ""
        card.querySelector("[data-inactivity-slot]")?.append(cue)
      }
    }).catch(() => { /* Cues are only available online. */ })
  }
}
