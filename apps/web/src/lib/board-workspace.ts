export const HOUSEHOLD_BOARD_ID = "household"
export const DEFAULT_GROUP_COLOR = "#64748b"

export interface BoardWorkspaceSelection {
  areaId: string | null
  projectId: string | null
  ticketId: string | null
  planning: boolean
  fromArea?: string | null
}

export function readBoardWorkspaceSelection(params: URLSearchParams): BoardWorkspaceSelection {
  return {
    areaId: params.get("area") || null,
    projectId: params.get("project") || null,
    ticketId: params.get("ticket") || null,
    fromArea: params.get("from") || null,
    planning: params.get("view") === "groups" || params.get("planning") === "1",
  }
}

export function boardWorkspaceHref(
  board: string,
  context: { area?: string | undefined; project?: string | undefined; ticket?: string; groups?: boolean; section?: BoardPlanningSection; offset?: number; fromArea?: string | undefined; homeArea?: string | undefined } = {},
  fragment = "",
): string {
  const query = new URLSearchParams()
  if (context.groups) query.set("view", "groups")
  if (context.section) query.set("section", context.section)
  if (context.area) query.set("area", context.area)
  if (context.project) query.set("project", context.project)
  if (context.fromArea) query.set("from", context.fromArea)
  if (context.ticket) query.set("ticket", context.ticket)
  if (context.homeArea) query.set("home_assistant_area_id", context.homeArea)
  if (context.offset) query.set("offset", String(context.offset))
  const search = query.toString()
  return `/boards/${encodeURIComponent(board)}${search ? `?${search}` : ""}${fragment ? `#${fragment}` : ""}`
}

export function parseBoardPlacement(value: unknown): { areaId: string | null; projectId: string | null } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const fields = Object.entries(value)
  if (fields.some(([key, id]) => !["areaId", "projectId"].includes(key) ||
    (id !== null && (typeof id !== "string" || !id || id.length > 150)))) return null
  const { areaId, projectId } = value as { areaId?: string | null; projectId?: string | null }
  return { areaId: areaId ?? null, projectId: projectId ?? null }
}


export const BOARD_PLANNING_SECTIONS = ["planning", "goals", "routines", "pillars"] as const
export type BoardPlanningSection = (typeof BOARD_PLANNING_SECTIONS)[number]

export function readBoardPlanningSection(params: URLSearchParams): BoardPlanningSection {
  return BOARD_PLANNING_SECTIONS.find(section => section === params.get("section")) ?? "planning"
}

export function readBoardNavigationContext(url: URL) {
  const match = /^\/boards\/([^/]+)\/?$/.exec(url.pathname)
  let boardId: string | undefined
  try { boardId = match ? decodeURIComponent(match[1]!) : url.pathname === "/tasks" || url.searchParams.get("board") === HOUSEHOLD_BOARD_ID ? HOUSEHOLD_BOARD_ID : undefined } catch { return }
  if (!boardId || boardId.length > 150) return
  return {
    boardId,
    area: url.searchParams.get("area") ?? url.searchParams.get("area_id") ?? undefined,
    project: url.searchParams.get("project") ?? url.searchParams.get("project_id") ?? undefined,
    fromArea: url.searchParams.get("from") ?? undefined,
  }
}

export function boardNavigationLinks(context: { boardId: string; area?: string | undefined; project?: string | undefined; fromArea?: string | undefined }) {
  const { boardId, area, project, fromArea } = context
  const placement = { area: project ? undefined : area, project, fromArea }
  const progress = new URLSearchParams({ board: HOUSEHOLD_BOARD_ID })
  if (project) progress.set("project_id", project)
  else if (area) progress.set("area_id", area)
  return {
    tasks: boardWorkspaceHref(boardId, placement, "kanban"),
    planning: boardWorkspaceHref(boardId, { ...placement, groups: true }, "groups"),
    progress: boardId === HOUSEHOLD_BOARD_ID ? `/progress?${progress}#goals`
      : boardWorkspaceHref(boardId, { ...placement, groups: true, section: "goals" }, "groups"),
  }
}
