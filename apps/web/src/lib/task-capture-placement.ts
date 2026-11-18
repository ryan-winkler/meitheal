import { getSelectedAreaId } from "./area-selector-controller"
import { taskBackgroundUrl } from "./task-page-url"

/** Freeze the current Household context when capture opens, including a filtered Project. */
export function taskCapturePlacement(): { areaId: string | null; projectId: string | null } | undefined {
  const params = taskBackgroundUrl().searchParams
  const areaId = params.get("area") || getSelectedAreaId() || null
  const projectId = params.get("project") || null
  return areaId || projectId ? { areaId, projectId } : undefined
}
