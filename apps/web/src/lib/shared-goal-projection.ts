/** Expire a protected projection in an open document when its viewer or data changes. */
export function bindSharedGoalProjection(root: HTMLElement, signal: AbortSignal): void {
  const projection = root.dataset.projectionKey
  const status = root.querySelector<HTMLElement>("#shared-goal-projection-status")
  if (!projection || !status) return

  const nodes = [...document.querySelectorAll<HTMLElement>("[data-board-goal-projection]")]
  const scope = new URLSearchParams()
  if (root.dataset.areaId) scope.set("area_id", root.dataset.areaId)
  if (root.dataset.projectionProject) scope.set("project_id", root.dataset.projectionProject)
  const endpoint = `/api/goals${scope.size ? `?${scope}` : ""}`
  let request: AbortController | undefined
  let expired = false

  function hide() {
    for (const node of nodes) {
      node.hidden = true
      node.inert = true
    }
  }

  function expire() {
    expired = true
    request?.abort()
    for (const node of nodes) node.replaceChildren()
    hide()
    status!.hidden = false
  }

  async function recheck(hideUntilVerified = false) {
    if (expired || signal.aborted) return
    request?.abort()
    if (hideUntilVerified || document.hidden) hide()
    if (document.hidden) return
    const current = new AbortController()
    request = current
    try {
      const result = await fetch(endpoint, {
        method: "HEAD",
        headers: { "X-Meitheal-Goal-Projection": projection! },
        cache: "no-store",
        signal: AbortSignal.any([signal, current.signal, AbortSignal.timeout(4_000)]),
      })
      if (signal.aborted || current.signal.aborted || expired || document.hidden) return
      if (result.status !== 204) expire()
      else for (const node of nodes) {
        node.hidden = false
        node.inert = false
      }
    } catch {
      if (!signal.aborted && !current.signal.aborted) expire()
    }
  }

  const interval = setInterval(() => { void recheck() }, 10_000)
  signal.addEventListener("abort", () => clearInterval(interval), { once: true })
  status.querySelector("button")?.addEventListener("click", () => window.location.reload(), { signal })
  document.addEventListener("visibilitychange", () => { void recheck(true) }, { signal })
  window.addEventListener("focus", () => { void recheck(true) }, { signal })
  window.addEventListener("offline", expire, { signal })
  window.addEventListener("pagehide", () => { request?.abort(); hide() }, { signal })
  window.addEventListener("pageshow", event => { if (event.persisted) void recheck(true) }, { signal })
}
