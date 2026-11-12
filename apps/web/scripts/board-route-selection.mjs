const taskAndLaneApiPath = /^\/api\/(?:tasks|lanes)(?:\/|$)/
const ticketPagePath = /^\/tickets\/[^/]+$/

/** @param {string} path */
export function isBoardTaskApiPath(path) {
  return taskAndLaneApiPath.test(path) || path === "/api/search"
}

/** @param {string} path @param {URLSearchParams} params */
export function boardRouteSelection(path, params) {
  const boardId = params.has("board_id")
  if ((path === "/tasks" || ticketPagePath.test(path)) && (boardId || params.has("board"))) return "page"
  if (path === "/api/tasks" && (boardId || params.has("board_name"))) return "bulk"
  if (boardId && isBoardTaskApiPath(path)) return "api"
}
