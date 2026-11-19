export interface TaskApiContext { boardId: string, session: string, actorKey?: string, boardName?: string }

const workRoute = /^\/api\/(?:agent-tokens(?:\/|$)|todo(?:\/|$)|saved-filters(?:\/|$)|search(?:\/|$)|users(?:\/|$)|lanes(?:\/|$)|gamification(?:\/|$)|tasks(?:\/|$)|areas(?:\/|$)|projects(?:\/|$)|goals(?:\/|$)|templates(?:\/|$)|habits(?:\/|$)|labels(?:\/|$)|pillars(?:\/|$)|task-drafts(?:\/|$)|task-pins(?:\/|$)|task-inactivity(?:\/|$)|reminders(?:\/|$)|mention-inbox(?:\/|$)|pomodoro(?:\/|$)|review(?:\/|$)|export\/tasks\.)/

/** One explicit context adapter for existing rich task controls and all views. */
export function taskApiHeaders(context: TaskApiContext, existing?: HeadersInit): Headers {
  const headers = new Headers(existing)
  if (!headers.has("X-Meitheal-Board-Id")) headers.set("X-Meitheal-Board-Id", context.boardId)
  if (!headers.has("X-Meitheal-Board-Session")) headers.set("X-Meitheal-Board-Session", context.session)
  return headers
}

export function isTaskApiRoute(pathname: string): boolean { return workRoute.test(pathname) }

export function currentTaskApiContext(): TaskApiContext | null {
  const boardId = document.querySelector<HTMLMetaElement>('meta[name="meitheal-work-board"]')?.content
  const session = document.querySelector<HTMLMetaElement>('meta[name="meitheal-work-session"]')?.content
  const actorKey = document.querySelector<HTMLMetaElement>('meta[name="meitheal-work-actor"]')?.content
  const boardName = document.querySelector<HTMLMetaElement>('meta[name="meitheal-work-board-name"]')?.content
  return boardId && session ? { boardId, session, ...(actorKey ? { actorKey } : {}), ...(boardName ? { boardName } : {}) } : null
}

/** Installed once; consult current DOM on each request so Astro navigation cannot retain an old Board. */
export function installTaskApiContext(): void {
  const state = window as typeof window & { __meithealTaskApiInstalled?: boolean }
  if (state.__meithealTaskApiInstalled) return
  state.__meithealTaskApiInstalled = true
  const previous = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const context = currentTaskApiContext()
    if (!context) return previous(input, init)
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href)
    const ingress = window.__ingress_path || ""
    const pathname = ingress && url.pathname.startsWith(ingress + "/") ? url.pathname.slice(ingress.length) : url.pathname
    if (url.origin !== window.location.origin || !isTaskApiRoute(pathname)) return previous(input, init)
    const explicitBoard = url.searchParams.get("board_id")
    const headers = taskApiHeaders({ ...context, boardId: explicitBoard || context.boardId }, init?.headers ?? (input instanceof Request ? input.headers : undefined))
    return previous(input, { ...init, headers })
  }
}

if (typeof window !== "undefined") installTaskApiContext()
