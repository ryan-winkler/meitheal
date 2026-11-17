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
export const taskDetailLayoutChange = "meitheal:task-detail-layout-changed"

export const taskDetailDefaultOrder = new Map<string, readonly string[]>([
  ["sections", taskDetailSections.map(section => section.id)],
  ...taskDetailSections.flatMap(section => "fields" in section
    ? [[section.id, section.fields.map(([id]) => id)] as const]
    : []),
])

export function normalizeTaskDetailOrder(raw: unknown, defaults: readonly string[]): string[] {
  const known = new Set(defaults)
  const saved = Array.isArray(raw) ? raw.filter(id => known.has(id)) : []
  return [...new Set<string>([...saved, ...defaults])]
}

export function readTaskDetailLayout(): Map<string, string[]> {
  let stored: Record<string, unknown> = {}
  try {
    const value = JSON.parse(localStorage.getItem(taskDetailLayoutKey) ?? "null")
    if (value && typeof value === "object" && !Array.isArray(value)) stored = value
  } catch {
    // Defaults also cover unavailable storage and malformed previous values.
  }
  return new Map(Array.from(taskDetailDefaultOrder, ([group, ids]) =>
    [group, normalizeTaskDetailOrder(stored[group], ids)],
  ))
}

export function saveTaskDetailOrder(group: string, ids: string[]): void {
  const defaults = taskDetailDefaultOrder.get(group)
  if (!defaults) return

  const orders = readTaskDetailLayout()
  orders.set(group, normalizeTaskDetailOrder(ids, defaults))
  localStorage.setItem(taskDetailLayoutKey, JSON.stringify(Object.fromEntries(orders)))
  window.dispatchEvent(new Event(taskDetailLayoutChange))
}

export function resetTaskDetailLayout(): void {
  localStorage.removeItem(taskDetailLayoutKey)
  window.dispatchEvent(new Event(taskDetailLayoutChange))
}
