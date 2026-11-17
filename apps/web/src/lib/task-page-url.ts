export const TASK_VIEW_LOCATION_EVENT = "meitheal:task-view-location-changed"

export function taskDetailPath(taskId: string, commentId?: number): string {
  const path = `/tickets/${encodeURIComponent(taskId)}`
  return commentId === undefined ? path : `${path}?${new URLSearchParams({ comment: String(commentId) })}`
}

export function ticketIdFromPath(pathname: string, ingressPath = ""): string | null {
  const path = ingressPath && pathname.startsWith(`${ingressPath}/`) ? pathname.slice(ingressPath.length) : pathname
  const match = /^\/tickets\/([^/]+)\/?$/.exec(path)
  if (!match?.[1]) return null
  try { return decodeURIComponent(match[1]) } catch { return null }
}

export function taskBackgroundUrl(current: URL): URL {
  if (ticketIdFromPath(current.pathname, window.__ingress_path) === null) return new URL(current)
  const returnTo = history.state?.ticketDrawer?.returnTo
  const fallback = `${window.__ingress_path || ""}/tasks#kanban`
  const url = new URL(typeof returnTo === "string" ? returnTo : fallback, current.origin)
  return url.origin === current.origin && url.pathname.startsWith(`${window.__ingress_path || ""}/`)
    ? url : new URL(fallback, current.origin)
}

export function replaceTaskBackgroundUrl(url: URL): void {
  if (ticketIdFromPath(location.pathname, window.__ingress_path) !== null) {
    history.replaceState({ ...history.state, ticketDrawer: { ...history.state?.ticketDrawer, returnTo: url.href } }, "")
    return
  }
  const current = new URLSearchParams(location.search)
  for (const key of ["open", "comment"]) {
    const value = current.get(key)
    if (value === null) url.searchParams.delete(key)
    else url.searchParams.set(key, value)
  }
  history.replaceState(history.state, "", url)
}
