export type TaskNavTypeId = "standard" | "shopping_item" | "checklist" | "calendar_event"

export type TaskNavDisplayMode = "all" | "none" | "custom"

export interface TaskNavTypeEntry {
  id: TaskNavTypeId
  filterKind: "standard_action" | "shopping_item" | "checklist" | "calendar_event"
  label: string
  shortLabel: string
  href: string
  icon: "inbox" | "shopping-cart" | "checklist" | "calendar-event"
}

export interface TaskNavPrefs {
  mode: TaskNavDisplayMode
  expanded: boolean
  visible: Record<TaskNavTypeId, boolean>
  pinned: TaskNavTypeId[]
}

export const TASK_NAV_PREFS_KEY = "meitheal-task-nav-prefs"
export const TASK_NAV_PREFS_EVENT = "meitheal:task-nav-prefs-changed"

export const TASK_NAV_TYPES: readonly TaskNavTypeEntry[] = [
  {
    id: "standard",
    filterKind: "standard_action",
    label: "Standard Tasks",
    shortLabel: "Tasks",
    href: "/tasks?types=standard",
    icon: "inbox",
  },
  {
    id: "shopping_item",
    filterKind: "shopping_item",
    label: "Shopping",
    shortLabel: "Shopping",
    href: "/tasks?types=shopping_item",
    icon: "shopping-cart",
  },
  {
    id: "checklist",
    filterKind: "checklist",
    label: "Checklists",
    shortLabel: "Checklists",
    href: "/tasks?types=checklist",
    icon: "checklist",
  },
  {
    id: "calendar_event",
    filterKind: "calendar_event",
    label: "Events",
    shortLabel: "Events",
    href: "/tasks?types=calendar_event",
    icon: "calendar-event",
  },
] as const

const VALID_TYPE_IDS = new Set<TaskNavTypeId>(TASK_NAV_TYPES.map((item) => item.id))

export function defaultTaskNavPrefs(): TaskNavPrefs {
  return {
    mode: "all",
    expanded: false,
    visible: {
      standard: true,
      shopping_item: true,
      checklist: true,
      calendar_event: true,
    },
    pinned: [],
  }
}

export function normalizeTaskTypeFilterValue(value: string | null | undefined): string {
  if (!value) return ""
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part === "standard" ? "standard_action" : part))
  return Array.from(new Set(parts)).sort().join(",")
}

export function normalizeTaskNavPrefs(input: unknown): TaskNavPrefs {
  const defaults = defaultTaskNavPrefs()
  if (!input || typeof input !== "object") return defaults
  const raw = input as Record<string, unknown>
  const mode: TaskNavDisplayMode =
    raw.mode === "all" || raw.mode === "none" || raw.mode === "custom" ? raw.mode : "all"
  const expanded = typeof raw.expanded === "boolean" ? raw.expanded : defaults.expanded

  const visibleRaw = raw.visible && typeof raw.visible === "object" ? (raw.visible as Record<string, unknown>) : {}
  const visible: Record<TaskNavTypeId, boolean> = {
    standard: typeof visibleRaw.standard === "boolean" ? visibleRaw.standard : true,
    shopping_item: typeof visibleRaw.shopping_item === "boolean" ? visibleRaw.shopping_item : true,
    checklist: typeof visibleRaw.checklist === "boolean" ? visibleRaw.checklist : true,
    calendar_event: typeof visibleRaw.calendar_event === "boolean" ? visibleRaw.calendar_event : true,
  }

  const pinned = Array.isArray(raw.pinned)
    ? Array.from(new Set(raw.pinned.filter((id): id is TaskNavTypeId => typeof id === "string" && VALID_TYPE_IDS.has(id as TaskNavTypeId))))
    : []

  return { mode, expanded, visible, pinned }
}

export function readTaskNavPrefs(): TaskNavPrefs {
  if (typeof window === "undefined") return defaultTaskNavPrefs()
  try {
    const raw = window.localStorage.getItem(TASK_NAV_PREFS_KEY)
    if (!raw) return defaultTaskNavPrefs()
    return normalizeTaskNavPrefs(JSON.parse(raw))
  } catch {
    return defaultTaskNavPrefs()
  }
}

export function writeTaskNavPrefs(next: TaskNavPrefs, dispatch = true): TaskNavPrefs {
  const normalized = normalizeTaskNavPrefs(next)
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(TASK_NAV_PREFS_KEY, JSON.stringify(normalized))
    } catch {
      // Ignore storage quota/privacy mode failures
    }
    if (dispatch) {
      window.dispatchEvent(new CustomEvent(TASK_NAV_PREFS_EVENT, { detail: normalized }))
    }
  }
  return normalized
}

export function isTaskNavTypeVisible(prefs: TaskNavPrefs, id: TaskNavTypeId): boolean {
  if (prefs.mode === "none") return false
  if (prefs.mode === "all") return true
  return prefs.visible[id] !== false
}

export function setTaskNavMode(prefs: TaskNavPrefs, mode: TaskNavDisplayMode): TaskNavPrefs {
  if (mode === "all") {
    return writeTaskNavPrefs({
      ...prefs,
      mode: "all",
      expanded: true,
      visible: {
        standard: true,
        shopping_item: true,
        checklist: true,
        calendar_event: true,
      },
    })
  }
  if (mode === "none") {
    return writeTaskNavPrefs({
      ...prefs,
      mode: "none",
      expanded: false,
      visible: {
        standard: false,
        shopping_item: false,
        checklist: false,
        calendar_event: false,
      },
    })
  }
  return writeTaskNavPrefs({ ...prefs, mode: "custom" })
}

export function toggleTaskNavExpanded(prefs: TaskNavPrefs, force?: boolean): TaskNavPrefs {
  const expanded = typeof force === "boolean" ? force : !prefs.expanded
  return writeTaskNavPrefs({ ...prefs, expanded })
}

export function toggleTaskNavChild(prefs: TaskNavPrefs, id: TaskNavTypeId): TaskNavPrefs {
  const current = isTaskNavTypeVisible(prefs, id)
  const visible: Record<TaskNavTypeId, boolean> = {
    standard: isTaskNavTypeVisible(prefs, "standard"),
    shopping_item: isTaskNavTypeVisible(prefs, "shopping_item"),
    checklist: isTaskNavTypeVisible(prefs, "checklist"),
    calendar_event: isTaskNavTypeVisible(prefs, "calendar_event"),
    [id]: !current,
  }
  const allOn = TASK_NAV_TYPES.every((item) => visible[item.id])
  const allOff = TASK_NAV_TYPES.every((item) => !visible[item.id])
  const mode: TaskNavDisplayMode = allOn ? "all" : allOff ? "none" : "custom"
  return writeTaskNavPrefs({
    ...prefs,
    mode,
    expanded: allOff ? false : prefs.expanded,
    visible,
  })
}

export function toggleTaskNavPin(prefs: TaskNavPrefs, id: TaskNavTypeId, force?: boolean): TaskNavPrefs {
  const isPinned = prefs.pinned.includes(id)
  const shouldPin = typeof force === "boolean" ? force : !isPinned
  const pinned = shouldPin
    ? isPinned
      ? prefs.pinned
      : [...prefs.pinned, id]
    : prefs.pinned.filter((entry) => entry !== id)
  return writeTaskNavPrefs({ ...prefs, pinned })
}

export function getTaskNavTypeById(id: string): TaskNavTypeEntry | undefined {
  return TASK_NAV_TYPES.find((item) => item.id === id)
}
