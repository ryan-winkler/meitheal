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

export const taskKindLayoutScopes = [
  { id: "default", label: "All Tasks (Default)", icon: "clipboard-list" },
  { id: "standard_action", label: "Task", icon: "checkbox" },
  { id: "shopping_item", label: "Shopping", icon: "shopping-cart" },
  { id: "checklist", label: "Checklist", icon: "list-check" },
  { id: "calendar_event", label: "Event", icon: "calendar-event" },
  { id: "routine_instance", label: "Routine Task", icon: "repeat" },
  { id: "quick_capture", label: "Quick Capture", icon: "bolt" },
] as const

export const entityFormLayouts = {
  routine_form: {
    id: "routine_form",
    label: "Routine Form",
    icon: "repeat",
    fields: [
      ["name", "Name"],
      ["icon", "Icon"],
      ["cadence", "Schedule"],
      ["priority", "Priority"],
      ["area", "Area"],
      ["project", "Project"],
      ["description", "Description"],
      ["checklist", "Default Checklist"],
    ] as const,
  },
  pillar_form: {
    id: "pillar_form",
    label: "Pillar Form",
    icon: "layout-grid",
    fields: [
      ["name", "Pillar Name"],
      ["manifesto", "Philosophy & Manifesto"],
      ["appearance", "Icon & Accent Color"],
      ["weight", "Priority Weight"],
    ] as const,
  },
  goal_form: {
    id: "goal_form",
    label: "Goal Form",
    icon: "target",
    fields: [
      ["title", "Goal Title"],
      ["area", "Area"],
      ["description", "Description"],
    ] as const,
  },
} as const

export type TaskDetailSection = typeof taskDetailSections[number]["id"]
export type TaskKindLayoutScope = Exclude<typeof taskKindLayoutScopes[number]["id"], "default">
export type EntityFormLayoutScope = keyof typeof entityFormLayouts
export type LayoutEditorScope = "default" | TaskKindLayoutScope | EntityFormLayoutScope

export const taskDetailLayoutKey = "meitheal:task-detail-layout:v1"
export const taskDetailServerSettingKey = "task_detail_layout_default"
export const taskDetailLayoutChange = "meitheal:task-detail-layout-changed"

export interface TaskDetailLayoutBaseConfig {
  orders: Record<string, string[]>
  hidden: Record<string, string[]>
  labels: Record<string, string>
}

export interface EntityFormLayoutConfig {
  order: string[]
  hidden: string[]
  labels: Record<string, string>
}

export interface TaskDetailLayoutConfig extends TaskDetailLayoutBaseConfig {
  kinds?: Partial<Record<TaskKindLayoutScope, TaskDetailLayoutBaseConfig>>
  forms?: Partial<Record<EntityFormLayoutScope, EntityFormLayoutConfig>>
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

const VALID_TASK_KINDS = new Set<string>(
  taskKindLayoutScopes.map(scope => scope.id).filter(id => id !== "default"),
)

const VALID_ENTITY_FORMS = new Set<string>(Object.keys(entityFormLayouts))

export function isTaskKindLayoutScope(value: unknown): value is TaskKindLayoutScope {
  return typeof value === "string" && VALID_TASK_KINDS.has(value)
}

export function isEntityFormLayoutScope(value: unknown): value is EntityFormLayoutScope {
  return typeof value === "string" && VALID_ENTITY_FORMS.has(value)
}

export function normalizeTaskDetailOrder(raw: unknown, defaults: readonly string[]): string[] {
  const known = new Set(defaults)
  const saved = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string" && known.has(id)) : []
  return [...new Set<string>([...saved, ...defaults])]
}

export function createDefaultTaskDetailBaseConfig(): TaskDetailLayoutBaseConfig {
  const orders: Record<string, string[]> = {}
  for (const [group, ids] of taskDetailDefaultOrder) {
    orders[group] = [...ids]
  }
  return { orders, hidden: {}, labels: {} }
}

const curatedTaskKindPresets: Partial<
  Record<
    TaskKindLayoutScope,
    {
      orders?: Record<string, string[]>
      hidden?: Record<string, string[]>
      labels?: Record<string, string>
    }
  >
> = {
  shopping_item: {
    orders: {
      sections: [
        "checklists", "properties", "metadata", "description", "scheduling",
        "comments", "attachments", "scoring", "relationships", "activity",
      ],
      properties: [
        "status", "priority", "assignee", "area", "project",
        "type", "urgency", "importance", "home-assistant-area", "pillar", "principle",
      ],
      scheduling: ["due", "reminder", "recurrence", "progress", "tracked"],
      metadata: ["labels", "color", "custom-fields"],
    },
    hidden: {
      sections: ["scoring", "relationships", "attachments", "activity"],
      properties: ["type", "urgency", "importance", "pillar", "principle", "home-assistant-area"],
      scheduling: ["progress", "tracked", "recurrence", "reminder"],
      metadata: ["color", "custom-fields"],
    },
    labels: {
      checklists: "Shopping Items",
    },
  },
  checklist: {
    orders: {
      sections: [
        "checklists", "description", "properties", "scheduling", "metadata",
        "comments", "attachments", "activity", "scoring", "relationships",
      ],
      properties: [
        "status", "priority", "assignee", "area", "project",
        "type", "urgency", "importance", "home-assistant-area", "pillar", "principle",
      ],
      scheduling: ["due", "recurrence", "reminder", "progress", "tracked"],
    },
    hidden: {
      sections: ["scoring", "relationships"],
      properties: ["type", "urgency", "importance", "pillar", "principle"],
      scheduling: ["tracked"],
    },
    labels: {
      checklists: "Checklist Items",
    },
  },
  calendar_event: {
    orders: {
      sections: [
        "scheduling", "description", "properties", "metadata", "attachments",
        "comments", "activity", "checklists", "scoring", "relationships",
      ],
      properties: [
        "status", "assignee", "area", "project", "priority",
        "type", "urgency", "importance", "home-assistant-area", "pillar", "principle",
      ],
      scheduling: ["due", "recurrence", "reminder", "progress", "tracked"],
    },
    hidden: {
      sections: ["scoring", "checklists", "relationships"],
      properties: ["type", "urgency", "importance", "pillar", "principle"],
      scheduling: ["progress", "tracked"],
    },
    labels: {
      scheduling: "Date & Recurrence",
    },
  },
  routine_instance: {
    orders: {
      sections: [
        "scheduling", "checklists", "description", "properties", "metadata",
        "comments", "activity", "attachments", "scoring", "relationships",
      ],
      properties: [
        "status", "priority", "assignee", "area", "project", "pillar",
        "principle", "type", "urgency", "importance", "home-assistant-area",
      ],
      scheduling: ["recurrence", "due", "reminder", "progress", "tracked"],
    },
    hidden: {
      sections: ["scoring", "relationships"],
      properties: ["type", "urgency", "importance"],
      scheduling: ["tracked"],
    },
  },
  quick_capture: {
    orders: {
      sections: [
        "description", "properties", "scheduling", "metadata", "checklists",
        "comments", "attachments", "scoring", "relationships", "activity",
      ],
      properties: [
        "status", "priority", "assignee", "area", "project",
        "type", "urgency", "importance", "home-assistant-area", "pillar", "principle",
      ],
      scheduling: ["due", "reminder", "recurrence", "progress", "tracked"],
      metadata: ["labels", "color", "custom-fields"],
    },
    hidden: {
      sections: ["scoring", "attachments", "relationships", "activity"],
      properties: ["type", "urgency", "importance", "home-assistant-area", "pillar", "principle"],
      scheduling: ["progress", "tracked", "recurrence", "reminder"],
      metadata: ["color", "custom-fields"],
    },
  },
}

export function hasCuratedTaskKindDefault(kind: TaskKindLayoutScope): boolean {
  return Boolean(curatedTaskKindPresets[kind])
}

export function createDefaultTaskDetailBaseConfigForKind(kind: TaskKindLayoutScope): TaskDetailLayoutBaseConfig {
  const preset = curatedTaskKindPresets[kind]
  if (!preset) return createDefaultTaskDetailBaseConfig()
  return normalizeTaskDetailBaseConfig(preset)
}

export function createDefaultTaskDetailLayoutConfig(): TaskDetailLayoutConfig {
  return createDefaultTaskDetailBaseConfig()
}

export function createDefaultEntityFormLayoutConfig(scope: EntityFormLayoutScope): EntityFormLayoutConfig {
  return {
    order: entityFormLayouts[scope].fields.map(([id]) => id),
    hidden: [],
    labels: {},
  }
}

export function normalizeEntityFormLayoutConfig(
  scope: EntityFormLayoutScope,
  raw: unknown,
): EntityFormLayoutConfig {
  const defaults = entityFormLayouts[scope].fields.map(([id]) => id)
  const known = new Set<string>(defaults)
  const base = createDefaultEntityFormLayoutConfig(scope)
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base
  const record = raw as Record<string, unknown>

  base.order = normalizeTaskDetailOrder(record.order, defaults)

  if (Array.isArray(record.hidden)) {
    base.hidden = [...new Set(record.hidden.filter((id): id is string => typeof id === "string" && known.has(id)))]
  }

  if (record.labels && typeof record.labels === "object" && !Array.isArray(record.labels)) {
    for (const [id, val] of Object.entries(record.labels as Record<string, unknown>)) {
      if (!known.has(id) || typeof val !== "string") continue
      const clean = val.trim().slice(0, 60)
      if (clean) base.labels[id] = clean
    }
  }

  return base
}

function normalizeTaskDetailBaseConfig(raw: unknown): TaskDetailLayoutBaseConfig {
  const base = createDefaultTaskDetailBaseConfig()
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

/**
 * Normalizes both the structured config (`{ orders, hidden, labels, kinds?, forms? }`) and
 * the legacy flat format (`{ sections: [...], properties: [...] }`) into a canonical TaskDetailLayoutConfig.
 */
export function normalizeTaskDetailLayoutConfig(raw: unknown): TaskDetailLayoutConfig {
  const base: TaskDetailLayoutConfig = normalizeTaskDetailBaseConfig(raw)
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base
  const record = raw as Record<string, unknown>

  if (record.kinds && typeof record.kinds === "object" && !Array.isArray(record.kinds)) {
    const kinds: Partial<Record<TaskKindLayoutScope, TaskDetailLayoutBaseConfig>> = {}
    for (const [kind, kindRaw] of Object.entries(record.kinds as Record<string, unknown>)) {
      if (!isTaskKindLayoutScope(kind)) continue
      kinds[kind] = normalizeTaskDetailBaseConfig(kindRaw)
    }
    if (Object.keys(kinds).length > 0) base.kinds = kinds
  }

  if (record.forms && typeof record.forms === "object" && !Array.isArray(record.forms)) {
    const forms: Partial<Record<EntityFormLayoutScope, EntityFormLayoutConfig>> = {}
    for (const [formKey, formRaw] of Object.entries(record.forms as Record<string, unknown>)) {
      if (!isEntityFormLayoutScope(formKey)) continue
      forms[formKey] = normalizeEntityFormLayoutConfig(formKey, formRaw)
    }
    if (Object.keys(forms).length > 0) base.forms = forms
  }

  return base
}

export function isTaskDetailBaseLayoutEqual(a: TaskDetailLayoutBaseConfig, b: TaskDetailLayoutBaseConfig): boolean {
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

export function isEntityFormLayoutEqual(a: EntityFormLayoutConfig, b: EntityFormLayoutConfig): boolean {
  if (a.order.length !== b.order.length || a.order.some((id, i) => id !== b.order[i])) return false
  const ha = [...a.hidden].sort()
  const hb = [...b.hidden].sort()
  if (ha.length !== hb.length || ha.some((id, i) => id !== hb[i])) return false
  const laKeys = Object.keys(a.labels).sort()
  const lbKeys = Object.keys(b.labels).sort()
  if (laKeys.length !== lbKeys.length) return false
  return laKeys.every((key, i) => key === lbKeys[i] && a.labels[key] === b.labels[key])
}

export function isTaskDetailLayoutEqual(a: TaskDetailLayoutConfig, b: TaskDetailLayoutConfig): boolean {
  if (!isTaskDetailBaseLayoutEqual(a, b)) return false

  const aKinds = a.kinds ?? {}
  const bKinds = b.kinds ?? {}
  const kindKeys = new Set([...Object.keys(aKinds), ...Object.keys(bKinds)])
  for (const key of kindKeys) {
    if (!isTaskKindLayoutScope(key)) continue
    const ak = aKinds[key]
    const bk = bKinds[key]
    if (!ak || !bk || !isTaskDetailBaseLayoutEqual(ak, bk)) return false
  }

  const aForms = a.forms ?? {}
  const bForms = b.forms ?? {}
  const formKeys = new Set([...Object.keys(aForms), ...Object.keys(bForms)])
  for (const key of formKeys) {
    if (!isEntityFormLayoutScope(key)) continue
    const af = aForms[key]
    const bf = bForms[key]
    if (!af || !bf || !isEntityFormLayoutEqual(af, bf)) return false
  }

  return true
}

export function resolveEffectiveTaskDetailLayout(
  personal: TaskDetailLayoutConfig | null,
  serverDefault: TaskDetailLayoutConfig | null,
): TaskDetailLayoutConfig {
  if (personal) return normalizeTaskDetailLayoutConfig(personal)
  if (serverDefault) return normalizeTaskDetailLayoutConfig(serverDefault)
  return createDefaultTaskDetailLayoutConfig()
}

export function resolveEffectiveTaskDetailLayoutForKind(
  personal: TaskDetailLayoutConfig | null,
  serverDefault: TaskDetailLayoutConfig | null,
  taskKind?: string | null,
): TaskDetailLayoutBaseConfig {
  const normalizedPersonal = personal ? normalizeTaskDetailLayoutConfig(personal) : null
  const normalizedServer = serverDefault ? normalizeTaskDetailLayoutConfig(serverDefault) : null

  if (isTaskKindLayoutScope(taskKind)) {
    if (normalizedPersonal?.kinds?.[taskKind]) {
      return normalizeTaskDetailBaseConfig(normalizedPersonal.kinds[taskKind])
    }
    if (normalizedServer?.kinds?.[taskKind]) {
      return normalizeTaskDetailBaseConfig(normalizedServer.kinds[taskKind])
    }
    if (hasCuratedTaskKindDefault(taskKind)) {
      return createDefaultTaskDetailBaseConfigForKind(taskKind)
    }
  }

  if (normalizedPersonal) return normalizeTaskDetailBaseConfig(normalizedPersonal)
  if (normalizedServer) return normalizeTaskDetailBaseConfig(normalizedServer)
  return createDefaultTaskDetailBaseConfig()
}

export function resolveEffectiveEntityFormLayout(
  personal: TaskDetailLayoutConfig | null,
  serverDefault: TaskDetailLayoutConfig | null,
  scope: EntityFormLayoutScope,
): EntityFormLayoutConfig {
  const normalizedPersonal = personal ? normalizeTaskDetailLayoutConfig(personal) : null
  const normalizedServer = serverDefault ? normalizeTaskDetailLayoutConfig(serverDefault) : null

  if (normalizedPersonal?.forms?.[scope]) {
    return normalizeEntityFormLayoutConfig(scope, normalizedPersonal.forms[scope])
  }
  if (normalizedServer?.forms?.[scope]) {
    return normalizeEntityFormLayoutConfig(scope, normalizedServer.forms[scope])
  }
  return createDefaultEntityFormLayoutConfig(scope)
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

export function readTaskDetailLayout(serverDefault?: TaskDetailLayoutConfig | null, taskKind?: string | null): Map<string, string[]> {
  const config = resolveEffectiveTaskDetailLayoutForKind(readPersonalTaskDetailLayout(), serverDefault ?? null, taskKind)
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
