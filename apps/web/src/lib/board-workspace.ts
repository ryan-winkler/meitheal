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
  context: { area?: string | undefined; project?: string | undefined; ticket?: string; groups?: boolean; offset?: number; fromArea?: string | undefined } = {},
  fragment = "",
): string {
  const query = new URLSearchParams()
  if (context.groups) query.set("view", "groups")
  if (context.area) query.set("area", context.area)
  if (context.project) query.set("project", context.project)
  if (context.fromArea) query.set("from", context.fromArea)
  if (context.ticket) query.set("ticket", context.ticket)
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
