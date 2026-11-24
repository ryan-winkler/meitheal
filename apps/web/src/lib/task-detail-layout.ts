export const taskDetailSections = [
  { id: "description", label: "Description", icon: "file-text" },
  { id: "properties", label: "Properties", icon: "adjustments-horizontal", fields: [
    ["status", "Status"], ["type", "Type"], ["priority", "Priority"], ["urgency", "Urgency"],
    ["importance", "Importance"], ["assignee", "Assignee"], ["area", "Group"], ["home-assistant-area", "Home Assistant Area"], ["project", "Project"],
    ["pillar", "Pillar"], ["principle", "Principle"],
  ] },
  { id: "scheduling", label: "Scheduling", icon: "clock", fields: [
    ["due", "Due"], ["progress", "Progress"], ["tracked", "Tracked (min)"],
    ["recurrence", "Recurrence Pattern"], ["reminder", "Reminder Time"],
  ] },
  { id: "metadata", label: "Metadata", icon: "tag", fields: [
    ["labels", "Labels"], ["color", "Task Color"], ["custom-fields", "Custom Fields"],
  ] },
  { id: "scoring", label: "Scoring & frameworks", icon: "calculator" },
  { id: "checklists", label: "Checklists", icon: "list-check" },
  { id: "attachments", label: "Attachments", icon: "paperclip" },
  { id: "relationships", label: "Relationships", icon: "link" },
  { id: "comments", label: "Comments", icon: "message-circle" },
  { id: "activity", label: "Activity Log", icon: "clock" },
] as const

export type TaskDetailSection = typeof taskDetailSections[number]["id"]
export const taskDetailLayoutKey = "meitheal:task-detail-layout:v1"
export const taskDetailServerSettingKey = "task_detail_layout_default"
export const taskDetailLayoutChange = "meitheal:task-detail-layout-changed"

export interface TaskDetailLayoutConfig {
  orders: Record<string, string[]>
  hidden: Record<string, string[]>
  labels: Record<string, string>
}

export const taskDetailDefaultOrder = new Map<string, readonly string[]>([
  ["sections", taskDetailSections.map(section => section.id)],
  ...taskDetailSections.flatMap(section => "fields" in section
    ? [[section.id, section.fields.map(([id]) => id)] as const]
    : []),
])

const ALL_KNOWN_IDS = new Set<string>([
  ...taskDetailSections.map(s => s.id),
  ...taskDetailSections.flatMap(s => "fields" in s ? s.fields.map(([id]) => id) : []),
])

export function normalizeTaskDetailOrder(raw: unknown, defaults: readonly string[]): string[] {
  const known = new Set(defaults)
  const saved = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string" && known.has(id)) : []
  return [...new Set<string>([...saved, ...defaults])]
}

export function createDefaultTaskDetailLayoutConfig(): TaskDetailLayoutConfig {
  const orders: Record<string, string[]> = {}
  for (const [group, ids] of taskDetailDefaultOrder) {
    orders[group] = [...ids]
  }
  return { orders, hidden: {}, labels: {} }
}

/**
 * Normalizes both the new structured config (`{ orders, hidden, labels }`) and the legacy
 * flat format (`{ sections: [...], properties: [...] }`) into a canonical TaskDetailLayoutConfig.
 */
export function normalizeTaskDetailLayoutConfig(raw: unknown): TaskDetailLayoutConfig {
  const base = createDefaultTaskDetailLayoutConfig()
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base

  const record = raw as Record<string, unknown>
  const orderSource =
    record.orders && typeof record.orders === "object" && !Array.isArray(record.orders)
      ? (record.orders as Record<string, unknown>)
      : record

  for (const [group, defaults] of taskDetailDefaultOrder) {
    base.orders[group] = normalizeTaskDetailOrder(orderSource[group], defaults)
  }

  if (record.hidden && typeof record.hidden === "object" && !Array.isArray(record.hidden)) {
    const hiddenSource = record.hidden as Record<string, unknown>
    for (const [group, defaults] of taskDetailDefaultOrder) {
      const known = new Set(defaults)
      const list = hiddenSource[group]
      if (!Array.isArray(list)) continue
      const filtered = [...new Set(list.filter((id): id is string => typeof id === "string" && known.has(id)))]
      if (filtered.length > 0) base.hidden[group] = filtered
    }
  }

  if (record.labels && typeof record.labels === "object" && !Array.isArray(record.labels)) {
    const labelSource = record.labels as Record<string, unknown>
    for (const [id, val] of Object.entries(labelSource)) {
      if (!ALL_KNOWN_IDS.has(id) || typeof val !== "string") continue
      const clean = val.trim().slice(0, 60)
      if (clean) base.labels[id] = clean
    }
  }

  return base
}

export function isTaskDetailLayoutEqual(a: TaskDetailLayoutConfig, b: TaskDetailLayoutConfig): boolean {
  for (const [group] of taskDetailDefaultOrder) {
    const oa = a.orders[group] ?? []
    const ob = b.orders[group] ?? []
    if (oa.length !== ob.length || oa.some((id, i) => id !== ob[i])) return false
    const ha = [...(a.hidden[group] ?? [])].sort()
    const hb = [...(b.hidden[group] ?? [])].sort()
    if (ha.length !== hb.length || ha.some((id, i) => id !== hb[i])) return false
  }
  const laKeys = Object.keys(a.labels).sort()
  const lbKeys = Object.keys(b.labels).sort()
  if (laKeys.length !== lbKeys.length) return false
  return laKeys.every((key, i) => key === lbKeys[i] && a.labels[key] === b.labels[key])
}

export function resolveEffectiveTaskDetailLayout(
  personal: TaskDetailLayoutConfig | null,
  serverDefault: TaskDetailLayoutConfig | null,
): TaskDetailLayoutConfig {
  if (personal) return normalizeTaskDetailLayoutConfig(personal)
  if (serverDefault) return normalizeTaskDetailLayoutConfig(serverDefault)
  return createDefaultTaskDetailLayoutConfig()
}

export function hasPersonalTaskDetailLayout(): boolean {
  try {
    return localStorage.getItem(taskDetailLayoutKey) !== null
  } catch {
    return false
  }
}

export function readPersonalTaskDetailLayout(): TaskDetailLayoutConfig | null {
  try {
    const raw = localStorage.getItem(taskDetailLayoutKey)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return normalizeTaskDetailLayoutConfig(parsed)
  } catch {
    return null
  }
}

export function readServerTaskDetailLayoutFromJson(raw: string | undefined | null): TaskDetailLayoutConfig | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return normalizeTaskDetailLayoutConfig(parsed)
  } catch {
    return null
  }
}

export function savePersonalTaskDetailLayout(config: TaskDetailLayoutConfig): void {
  const normalized = normalizeTaskDetailLayoutConfig(config)
  localStorage.setItem(taskDetailLayoutKey, JSON.stringify(normalized))
  window.dispatchEvent(new Event(taskDetailLayoutChange))
}

export function readTaskDetailLayout(serverDefault?: TaskDetailLayoutConfig | null): Map<string, string[]> {
  const config = resolveEffectiveTaskDetailLayout(readPersonalTaskDetailLayout(), serverDefault ?? null)
  return new Map(Array.from(taskDetailDefaultOrder, ([group]) => [group, config.orders[group] ?? []]))
}

export function saveTaskDetailOrder(group: string, ids: string[]): void {
  const defaults = taskDetailDefaultOrder.get(group)
  if (!defaults) return
  const current = readPersonalTaskDetailLayout() ?? createDefaultTaskDetailLayoutConfig()
  current.orders[group] = normalizeTaskDetailOrder(ids, defaults)
  savePersonalTaskDetailLayout(current)
}

export function resetTaskDetailLayout(): void {
  localStorage.removeItem(taskDetailLayoutKey)
  window.dispatchEvent(new Event(taskDetailLayoutChange))
}
