const taskAndLaneApiPath = /^\/api\/(?:tasks|lanes)(?:\/|$)/
const ticketPagePath = /^\/tickets\/[^/]+$/
const supportedApiPath = /^\/api\/(?:lanes|gamification|tasks|areas|projects|goals|templates|habits|labels|pillars|task-drafts|task-pins|task-inactivity|reminders|mention-inbox|pomodoro|review)(?:\/|$)/
const supportedPagePath = /^\/(?:boards|tasks|task|tickets|areas|projects|goals|planning|progress|habits|today|upcoming|deferred|inactivity|triage|eisenhower|review|activity)(?:\/|$)/

/** @param {string} path */
export function isBoardTaskApiPath(path) {
  return taskAndLaneApiPath.test(path) || path === "/api/search"
}

/** @param {string} path @param {URLSearchParams} params */
export function boardRouteSelection(path, params) {
  if (params.has("board_name")) return path === "/api/tasks" ? "bulk" : "api"
  if (supportedApiPath.test(path) || supportedPagePath.test(path)) return
  const boardId = params.has("board_id")
  if ((path === "/tasks" || ticketPagePath.test(path)) && (boardId || params.has("board"))) return "page"
  if (path === "/api/tasks" && (boardId || params.has("board_name"))) return "bulk"
  if (boardId && isBoardTaskApiPath(path)) return "api"
}
