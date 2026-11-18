import { readTaskAreaParam } from "./filter-state"
import { getSelectedAreaId } from "./area-selector-controller"
import { taskBackgroundUrl } from "./task-page-url"

/** Freeze the current Household context when capture opens, including a filtered Project. */
export function taskCapturePlacement(): { areaId: string | null; projectId: string | null } | undefined {
  const params = taskBackgroundUrl().searchParams
  const projectId = params.get("project") || null
  const explicitArea = readTaskAreaParam(params)
  const areaId = explicitArea !== null ? explicitArea || null : projectId ? null : getSelectedAreaId() || null
  return areaId || projectId ? { areaId, projectId } : undefined
}
