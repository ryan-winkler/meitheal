/** Expire a protected projection in an open document when its viewer or data changes. */
export function bindSharedGoalProjection(root: HTMLElement, signal: AbortSignal): void {
  const projection = root.dataset.projectionKey
  const status = root.querySelector<HTMLElement>("#shared-goal-projection-status")
  if (!projection || !status) return

  const lines = [...document.querySelectorAll<HTMLElement>("[data-board-goal-projection]")]
    .map(node => ({ node, place: document.createComment("") }))
  const fallback = [...document.querySelectorAll<HTMLElement>("[data-board-goal-fallback]")]
  const scope = new URLSearchParams()
  if (root.dataset.areaId) scope.set("area_id", root.dataset.areaId)
  if (root.dataset.projectionProject) scope.set("project_id", root.dataset.projectionProject)
  if (root.dataset.projectionLabels) scope.set("scope_labels", "1")
  const endpoint = `/api/goals${scope.size ? `?${scope}` : ""}`
  const headers = { "X-Meitheal-Goal-Projection": projection }
  let request: AbortController | undefined
  let expired = false

  function detach() {
    for (const { node, place } of lines) if (node.isConnected) node.replaceWith(place)
    for (const node of fallback) node.hidden = false
  }

  function restore() {
    for (const { node, place } of lines) if (place.isConnected) place.replaceWith(node)
    for (const node of fallback) node.hidden = true
  }

  function expire() {
    expired = true
    detach()
    for (const { place } of lines.splice(0)) place.remove()
    status!.hidden = false
  }

  async function recheck(hideUntilVerified = false) {
    if (expired || signal.aborted) return
    request?.abort()
    if (hideUntilVerified || document.hidden) detach()
    if (document.hidden) return
    const current = new AbortController()
    request = current
    try {
      const result = await fetch(endpoint, {
        method: "HEAD", headers, cache: "no-store",
        signal: AbortSignal.any([signal, current.signal, AbortSignal.timeout(4_000)]),
      })
      if (signal.aborted || current.signal.aborted || expired || document.hidden) return
      if (result.status === 204) restore()
      else if (result.status === 409 || result.status === 403 || result.status === 401) expire()
      else detach()
    } catch {
      if (!signal.aborted && !current.signal.aborted) detach()
    }
  }

  const interval = setInterval(() => { void recheck() }, 10_000)
  signal.addEventListener("abort", () => clearInterval(interval), { once: true })
  status.querySelector("button")?.addEventListener("click", () => window.location.reload(), { signal })
  document.addEventListener("visibilitychange", () => { void recheck(true) }, { signal })
  window.addEventListener("focus", () => { void recheck(true) }, { signal })
  window.addEventListener("offline", () => { request?.abort(); detach() }, { signal })
  window.addEventListener("online", () => { void recheck(true) }, { signal })
  window.addEventListener("pagehide", () => { request?.abort(); detach() }, { signal })
  window.addEventListener("pageshow", event => { if (event.persisted) void recheck(true) }, { signal })
}
