import { HierarchyRepository, getPersistenceClient, type BoardScope } from "@domains/tasks"

export interface BoardPagePlacement { areaId?: string | null; projectId?: string | null }
export type BoardPagePlacementResult = {
  ok: true
  placement: BoardPagePlacement
  area?: { id: string; name: string }
  project?: { id: string; name: string }
} | { ok: false; errorCode: "unavailable" }

/** These selectors filter an already authorized Board; they never grant work authority. */
export async function readBoardPagePlacement(scope: BoardScope, url: URL): Promise<BoardPagePlacementResult> {
  const read = (names: string[]) => {
    const values = names.flatMap(name => url.searchParams.getAll(name))
    if (names.some(name => url.searchParams.getAll(name).length > 1) || new Set(values).size > 1
      || values.some(value => value.length > 150 || value.includes("\0"))) return { ok: false as const }
    return { ok: true as const, value: values[0] }
  }
  const selectedArea = read(["area", "area_id"])
  const selectedProject = read(["project", "project_id"])
  if (!selectedArea.ok || !selectedProject.ok) return { ok: false, errorCode: "unavailable" }
  const hierarchy = new HierarchyRepository(getPersistenceClient(), scope)
  const project = selectedProject.value ? await hierarchy.findProjectById(selectedProject.value) : null
  if (selectedProject.value && !project) return { ok: false, errorCode: "unavailable" }
  if (project && selectedArea.value !== undefined && (selectedArea.value || null) !== project.area_id) return { ok: false, errorCode: "unavailable" }
  const areaId = project?.area_id ?? selectedArea.value
  const area = areaId ? await hierarchy.findAreaById(areaId) : null
  if (areaId && !area) return { ok: false, errorCode: "unavailable" }
  return {
    ok: true,
    placement: project ? { projectId: project.id } : {
      ...(selectedArea.value !== undefined ? { areaId: selectedArea.value || null } : {}),
      ...(selectedProject.value !== undefined ? { projectId: selectedProject.value || null } : {}),
    },
    ...(area ? { area: { id: area.id, name: area.name } } : {}),
    ...(project ? { project: { id: project.id, name: project.title } } : {}),
  }
}
