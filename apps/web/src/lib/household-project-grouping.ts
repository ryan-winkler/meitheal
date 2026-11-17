// The Household catalog supplies display names. Missing assignments and
// unavailable catalog entries each have their own group.
const NO_PROJECT = "No Project"
const UNKNOWN_PROJECT = "Unknown Project"
const NO_PROJECT_GROUP = "project-"
const UNKNOWN_PROJECT_GROUP = "unavailable-project"

export type HouseholdProjectLabel = { title: string; qualifier?: string }

type CatalogProject = { id: string; title: string; area_id: string | null; goal_id?: string | null }

export function getHouseholdProjectLabels(
  projects: readonly CatalogProject[],
  areas: Readonly<Record<string, string>>,
  goalAreas?: ReadonlyMap<string, string | null>,
  fallbacks = { none: NO_PROJECT, unknown: UNKNOWN_PROJECT },
): Record<string, HouseholdProjectLabel> {
  const ordered = projects.filter(project => project.id).sort((a, b) => a.id.localeCompare(b.id))
  const counts = new Map<string, number>()
  const titleKey = (value: string) => value.normalize("NFC").trim().replace(/\s+/g, " ").toUpperCase()
  for (const { title } of ordered) {
    const key = titleKey(title)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const fallbackTitles = new Set([fallbacks.none, fallbacks.unknown].map(titleKey))
  const tokens = new Map<string, number>()
  for (const { id } of ordered) {
    const token = id.slice(-8)
    tokens.set(token, (tokens.get(token) ?? 0) + 1)
  }
  const used = new Set([...fallbackTitles, ...counts.keys()])
  const entries = ordered.map(({ id, title, area_id, goal_id }): [string, HouseholdProjectLabel] => {
    const group = `project-${id}`
    const key = titleKey(title)
    if (counts.get(key) === 1 && !fallbackTitles.has(key)) return [group, { title }]

    const areaId = area_id ?? (goal_id ? goalAreas?.get(goal_id) : null)
    const area = areaId && Object.hasOwn(areas, areaId) ? areas[areaId] : ""
    const token = tokens.get(id.slice(-8)) === 1 ? id.slice(-8) : id
    let qualifier = `#${token}${area ? ` · ${area}` : ""}`
    const displayKey = () => titleKey(`${title} · ${qualifier}`)
    while (used.has(displayKey())) qualifier += " ·"
    used.add(displayKey())
    return [group, { title, qualifier }]
  })
  return Object.fromEntries([
    [NO_PROJECT_GROUP, { title: fallbacks.none }],
    [UNKNOWN_PROJECT_GROUP, { title: fallbacks.unknown }],
    ...entries,
  ])
}

export function getHouseholdProjectGroup(
  projectId: string | null,
  labels: Readonly<Record<string, HouseholdProjectLabel>>,
  assigned = Boolean(projectId),
): string {
  if (!assigned) return NO_PROJECT_GROUP
  const key = `project-${projectId}`
  return Object.hasOwn(labels, key) ? key : UNKNOWN_PROJECT_GROUP
}
