import { currentTaskApiContext } from "./task-api"

export const TASK_VIEW_LOCATION_EVENT = "meitheal:task-view-location-changed"

/** A task ID, ticket key, or a task row that may carry its ticket key. */
export type TaskLocator = string | { id: string | number, ticket_key?: unknown }

/** The readable ticket key for a task row, falling back to its opaque ID. */
function taskLocator(task: TaskLocator): string {
  if (typeof task === "string") return task
  return typeof task.ticket_key === "string" && task.ticket_key ? task.ticket_key : String(task.id)
}

/** The one in-app ticket path: `/tickets/MTH-4`, or `/tickets/<id>` while the key is unknown. */
export function taskDetailPath(task: TaskLocator, commentId?: number): string {
  const path = `/tickets/${encodeURIComponent(taskLocator(task))}`
  return commentId === undefined ? path : `${path}?${new URLSearchParams({ comment: String(commentId) })}`
}

/** Ticket keys ignore case; opaque IDs compare exactly. */
export function sameTaskLocator(locator: string, id: string | null, ticketKey: string | null): boolean {
  return locator === id || (ticketKey !== null && locator.toUpperCase() === ticketKey.toUpperCase())
}

export function ticketIdFromPath(pathname: string, ingressPath = ""): string | null {
  const path = ingressPath && pathname.startsWith(`${ingressPath}/`) ? pathname.slice(ingressPath.length) : pathname
  const match = /^\/tickets\/([^/]+)\/?$/.exec(path)
  if (!match?.[1]) return null
  try { return decodeURIComponent(match[1]) } catch { return null }
}

export function taskBackgroundUrl(current = new URL(location.href)): URL {
  if (ticketIdFromPath(current.pathname, window.__ingress_path) === null) return new URL(current)
  const returnTo = history.state?.ticketDrawer?.returnTo
  const boardId = currentTaskApiContext()?.boardId
  const fallback = `${window.__ingress_path || ""}${boardId ? `/boards/${encodeURIComponent(boardId)}` : "/boards"}`
  const url = new URL(typeof returnTo === "string" ? returnTo : fallback, current.origin)
  return url.origin === current.origin && url.pathname.startsWith(`${window.__ingress_path || ""}/`)
    ? url : new URL(fallback, current.origin)
}

// Keep the last changed URL until either companion history entry becomes active.
let backgroundUpdate: { key: string; href: string } | undefined

function writeTicketReturnTo(href: string): void {
  history.replaceState({ ...history.state, ticketDrawer: { ...history.state?.ticketDrawer, returnTo: href } }, "")
}

export function restoreTaskBackgroundUrl(): void {
  if (!backgroundUpdate || history.state?.ticketBackground !== backgroundUpdate.key) return
  const { href } = backgroundUpdate
  if (ticketIdFromPath(location.pathname, window.__ingress_path) !== null) {
    if (history.state?.ticketDrawer?.returnTo === href) return
    writeTicketReturnTo(href)
  } else {
    if (location.href === href) return
    history.replaceState(history.state, "", href)
  }
  document.dispatchEvent(new Event(TASK_VIEW_LOCATION_EVENT))
}

export function replaceTaskBackgroundUrl(url: URL): void {
  const ticket = ticketIdFromPath(location.pathname, window.__ingress_path) !== null
  if (!ticket) {
    const current = new URLSearchParams(location.search)
    for (const key of ["open", "comment"]) {
      const value = current.get(key)
      if (value === null) url.searchParams.delete(key)
      else url.searchParams.set(key, value)
    }
  }
  const key = history.state?.ticketBackground
  if (key && (!ticket || history.state?.ticketDrawer?.pushed)) backgroundUpdate = { key, href: url.href }
  if (ticket) writeTicketReturnTo(url.href)
  else history.replaceState(history.state, "", url)
  document.dispatchEvent(new Event(TASK_VIEW_LOCATION_EVENT))
}
