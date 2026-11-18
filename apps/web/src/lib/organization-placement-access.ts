import { isOrganizationFeatureAvailable as available } from "./organization-request-context"

export function organizationPlacementAvailable(body: Record<string, unknown>): boolean {
  const placement = body.placement && typeof body.placement === "object"
    ? body.placement as Record<string, unknown> : {}
  return (available("groups") || !(body.areaId || body.area_id && body.area_id !== "default" || placement.areaId)) &&
    (available("projects") || !(body.projectId || body.project_id || placement.projectId)) &&
    (available("goals") || !(body.goalId || body.goal_id))
}
