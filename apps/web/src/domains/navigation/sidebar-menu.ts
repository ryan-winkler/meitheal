/**
 * Sidebar Menu Domain Model
 *
 * Canonical DDD aggregate for sidebar sections (built-in + custom), navigation
 * items (including independently pinnable nested views and boards), visibility,
 * custom labels, custom icons, and ordering. Shared across SSR rendering,
 * per-user live Edit Mode, and Server-wide Settings Navigation (DRY).
 */

export type BuiltinSidebarSectionId = "workspace" | "planning" | "boards" | "system"
export type SidebarSectionId = string

export interface CustomNavItem {
  id: string
  href: string
  icon: string
  label: string
}

export interface SidebarSectionSpec {
  id: BuiltinSidebarSectionId
  defaultLabel: string
  i18nKey: string
  defaultItems: readonly string[]
}

export interface SidebarMenuConfig {
  sectionOrder: SidebarSectionId[]
  hiddenSections: SidebarSectionId[]
  sectionLabels: Record<string, string>
  sectionItems: Record<string, string[]>
  hiddenItems: string[]
  itemLabels: Record<string, string>
  customItems: CustomNavItem[]
}

export interface SerializedSidebarConfig {
  [key: string]: unknown
  sections: {
    order: SidebarSectionId[]
    hidden: SidebarSectionId[]
    labels: Record<string, string>
  }
  sectionItems: Record<string, string[]>
  hiddenItems: string[]
  order: string[]
  labels: Record<string, string>
  customItems: CustomNavItem[]
}

export const SIDEBAR_PERSONAL_STORAGE_KEY = "meitheal-sidebar-personal-config"

export const CUSTOM_LINK_ICONS = [
  "link",
  "home",
  "star",
  "heart",
  "calendar",
  "checkbox",
  "shopping-cart",
  "list-check",
  "folder",
  "book",
  "bolt",
  "flame",
  "clock",
  "bell",
  "settings",
  "world",
] as const

const CUSTOM_LINK_ICON_SET: ReadonlySet<string> = new Set([
  ...CUSTOM_LINK_ICONS,
  "layout-kanban",
  "layout-dashboard",
  "layout-grid",
  "pin",
  "external-link",
  "inbox",
  "trophy",
  "table",
  "chart-bar",
  "tag",
  "target",
  "users",
  "plug",
  "sparkles",
])

export function sanitizeCustomLinkIcon(raw: unknown): string {
  if (typeof raw !== "string") return "link"
  const clean = raw.trim()
  return CUSTOM_LINK_ICON_SET.has(clean) ? clean : "link"
}

export const TASK_VIEW_ITEM_KEYS = [
  "view-calendar",
  "view-kanban",
  "view-timeline",
  "view-table",
] as const

export type TaskViewItemKey = (typeof TASK_VIEW_ITEM_KEYS)[number]

/**
 * Nested task views start hidden (unpinned) by default until the user pins them
 * from the Tasks submenu or reveals them in Sidebar Edit Mode. Once pinned/shown,
 * they behave as completely independent, movable items across any section.
 */
export const DEFAULT_HIDDEN_ITEMS: readonly string[] = [...TASK_VIEW_ITEM_KEYS]

export const DEFAULT_SIDEBAR_SECTIONS: readonly SidebarSectionSpec[] = [
  {
    id: "workspace",
    defaultLabel: "Workspace",
    i18nKey: "sidebar.section_workspace",
    defaultItems: [
      "dashboard",
      "today",
      "upcoming",
      "tasks",
      ...TASK_VIEW_ITEM_KEYS,
      "system-pinned",
      "activity",
      "mentionInbox",
    ],
  },
  {
    id: "planning",
    defaultLabel: "Planning",
    i18nKey: "sidebar.section_planning",
    defaultItems: ["progress", "planning"],
  },
  {
    id: "boards",
    defaultLabel: "Boards",
    i18nKey: "sidebar.section_boards",
    defaultItems: ["boards"],
  },
  {
    id: "system",
    defaultLabel: "System",
    i18nKey: "sidebar.section_system",
    defaultItems: ["settings"],
  },
] as const

export const DEFAULT_SECTION_IDS: readonly BuiltinSidebarSectionId[] = DEFAULT_SIDEBAR_SECTIONS.map(section => section.id)

const BUILTIN_SECTION_ID_SET: ReadonlySet<string> = new Set(DEFAULT_SECTION_IDS)
const CUSTOM_SECTION_ID_PATTERN = /^section-[a-z0-9][a-z0-9-]{0,48}$/
const DEFAULT_HIDDEN_SET: ReadonlySet<string> = new Set(DEFAULT_HIDDEN_ITEMS)

export const DEFAULT_ITEM_SECTION: Readonly<Record<string, BuiltinSidebarSectionId>> = Object.fromEntries(
  DEFAULT_SIDEBAR_SECTIONS.flatMap(section => section.defaultItems.map(item => [item, section.id])),
)

export const DEFAULT_SIDEBAR_ITEM_LABELS: Readonly<Record<string, string>> = {
  dashboard: "Dashboard",
  today: "Today",
  upcoming: "Upcoming",
  tasks: "Tasks",
  "view-calendar": "Calendar",
  "view-kanban": "Kanban",
  "view-timeline": "Timeline",
  "view-table": "Table",
  "system-pinned": "Pinned",
  activity: "Recent activity",
  mentionInbox: "Mentions",
  progress: "Progress & Growth",
  planning: "Planning",
  boards: "Boards",
  settings: "Settings",
}

export const DEFAULT_SIDEBAR_ITEM_ICONS: Readonly<Record<string, string>> = {
  dashboard: "layout-dashboard",
  today: "clock",
  upcoming: "calendar",
  tasks: "layout-kanban",
  "view-calendar": "calendar",
  "view-kanban": "layout-kanban",
  "view-timeline": "chart-bar",
  "view-table": "table",
  "system-pinned": "pin",
  activity: "bolt",
  mentionInbox: "inbox",
  progress: "trophy",
  planning: "layout-grid",
  boards: "layout-kanban",
  settings: "settings",
}

export const DEFAULT_NAV_ORDER: readonly string[] = DEFAULT_SIDEBAR_SECTIONS.flatMap(section => [...section.defaultItems])

export function isBuiltinSidebarSectionId(value: string): value is BuiltinSidebarSectionId {
  return BUILTIN_SECTION_ID_SET.has(value)
}

export function isSidebarSectionId(value: string): value is SidebarSectionId {
  return BUILTIN_SECTION_ID_SET.has(value) || CUSTOM_SECTION_ID_PATTERN.test(value)
}

export function defaultSectionForItem(key: string): BuiltinSidebarSectionId {
  if (key.startsWith("board-")) return "boards"
  return DEFAULT_ITEM_SECTION[key] ?? "workspace"
}

export function defaultSectionLabel(sectionId: SidebarSectionId): string {
  const builtin = DEFAULT_SIDEBAR_SECTIONS.find(section => section.id === sectionId)
  if (builtin) return builtin.defaultLabel
  return sectionId
    .replace(/^section-/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, ch => ch.toUpperCase()) || "Custom"
}

export function sanitizeLabel(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 64)
}

function slugifySectionId(label: string, existing: readonly string[]): string {
  const baseSlug = sanitizeLabel(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "custom"
  const taken = new Set(existing)
  let candidate = `section-${baseSlug}`
  let suffix = 2
  while (taken.has(candidate)) {
    candidate = `section-${baseSlug}-${suffix++}`
  }
  return candidate
}

function cloneSectionItems(config: SidebarMenuConfig): Record<string, string[]> {
  const next: Record<string, string[]> = {}
  for (const sectionId of config.sectionOrder) {
    next[sectionId] = [...(config.sectionItems[sectionId] ?? [])]
  }
  return next
}

function parseRawConfigObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === "string") {
    try {
      const first: unknown = JSON.parse(raw)
      if (typeof first === "string") {
        const second: unknown = JSON.parse(first)
        return second && typeof second === "object" && !Array.isArray(second)
          ? (second as Record<string, unknown>)
          : {}
      }
      return first && typeof first === "object" && !Array.isArray(first)
        ? (first as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

function parseCustomItems(raw: unknown): CustomNavItem[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: CustomNavItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const item = entry as Record<string, unknown>
    const id = typeof item.id === "string" ? item.id.trim() : ""
    const href = typeof item.href === "string" ? item.href.trim() : ""
    if (!id || id === "system-pinned" || !href || seen.has(id)) continue
    seen.add(id)
    result.push({
      id,
      href,
      icon: sanitizeCustomLinkIcon(item.icon),
      label: typeof item.label === "string" && item.label.trim() ? sanitizeLabel(item.label) : id,
    })
  }
  return result
}

function parseStringRecord(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      const clean = sanitizeLabel(value)
      if (clean) result[key] = clean
    }
  }
  return result
}

/**
 * Normalizes either legacy flat `sidebar_config` or section-aware `sidebar_config`
 * (including user-added custom sections) into a guaranteed-valid `SidebarMenuConfig`.
 */
export function normalizeSidebarConfig(
  raw: unknown,
  availableKeys?: readonly string[],
): SidebarMenuConfig {
  const source = parseRawConfigObject(raw)
  const customItems = parseCustomItems(source.customItems)
  const customIds = customItems.map(item => item.id)

  const validKeys = availableKeys
    ? [...new Set([...availableKeys, ...customIds])]
    : [...new Set([...DEFAULT_NAV_ORDER, ...customIds])]
  const validKeySet = new Set(validKeys)

  const sectionsMeta = (source.sections && typeof source.sections === "object" && !Array.isArray(source.sections))
    ? (source.sections as Record<string, unknown>)
    : {}

  const rawSectionOrder = Array.isArray(sectionsMeta.order)
    ? sectionsMeta.order.filter((id): id is SidebarSectionId => typeof id === "string" && isSidebarSectionId(id))
    : []
  const sectionOrder: SidebarSectionId[] = [...new Set([...rawSectionOrder, ...DEFAULT_SECTION_IDS])]
  const sectionOrderSet = new Set(sectionOrder)

  const hiddenSections: SidebarSectionId[] = Array.isArray(sectionsMeta.hidden)
    ? [...new Set(sectionsMeta.hidden.filter((id): id is SidebarSectionId => typeof id === "string" && sectionOrderSet.has(id)))]
    : []

  const sectionLabels = parseStringRecord(sectionsMeta.labels)
  const itemLabels = parseStringRecord(source.labels)
  for (const custom of customItems) {
    if (!itemLabels[custom.id] && custom.label) itemLabels[custom.id] = custom.label
  }

  const hasExplicitHiddenArray = Array.isArray(source.hiddenItems)
  const hiddenSet = new Set<string>()
  if (hasExplicitHiddenArray) {
    for (const key of source.hiddenItems as unknown[]) {
      if (typeof key === "string" && validKeySet.has(key)) hiddenSet.add(key)
    }
  }
  for (const key of validKeys) {
    if (source[key] === false) {
      hiddenSet.add(key)
    } else if (DEFAULT_HIDDEN_SET.has(key) && source[key] !== true) {
      const alreadyMentionedInSectionItems = Boolean(
        source.sectionItems &&
        typeof source.sectionItems === "object" &&
        Object.values(source.sectionItems as Record<string, unknown>).some(
          list => Array.isArray(list) && list.includes(key),
        ),
      )
      if (!hasExplicitHiddenArray || !alreadyMentionedInSectionItems) {
        hiddenSet.add(key)
      }
    }
  }

  const sectionItems: Record<string, string[]> = {}
  for (const sectionId of sectionOrder) sectionItems[sectionId] = []
  const assigned = new Set<string>()

  const rawSectionItems = (source.sectionItems && typeof source.sectionItems === "object" && !Array.isArray(source.sectionItems))
    ? (source.sectionItems as Record<string, unknown>)
    : null

  if (rawSectionItems) {
    for (const sectionId of sectionOrder) {
      const list = rawSectionItems[sectionId]
      if (!Array.isArray(list)) continue
      for (const rawKey of list) {
        if (typeof rawKey !== "string") continue
        const mapped = rawKey === "areas" && !validKeySet.has("areas") && validKeySet.has("boards") ? "boards" : rawKey
        if (!validKeySet.has(mapped) || assigned.has(mapped)) continue
        sectionItems[sectionId]!.push(mapped)
        assigned.add(mapped)
      }
    }
  } else if (Array.isArray(source.order) && source.order.length > 0) {
    for (const rawKey of source.order) {
      if (typeof rawKey !== "string") continue
      const mapped = rawKey === "areas" && !validKeySet.has("areas") && validKeySet.has("boards") ? "boards" : rawKey
      if (!validKeySet.has(mapped) || assigned.has(mapped)) continue
      const targetSection = defaultSectionForItem(mapped)
      sectionItems[targetSection]!.push(mapped)
      assigned.add(mapped)
    }
  }

  for (const key of validKeys) {
    if (assigned.has(key)) continue
    const targetSection = defaultSectionForItem(key)
    sectionItems[targetSection]!.push(key)
    assigned.add(key)
  }

  return {
    sectionOrder,
    hiddenSections,
    sectionLabels,
    sectionItems,
    hiddenItems: [...hiddenSet],
    itemLabels,
    customItems,
  }
}

export function isSectionHidden(config: SidebarMenuConfig, sectionId: SidebarSectionId): boolean {
  return config.hiddenSections.includes(sectionId)
}

export function isItemHidden(config: SidebarMenuConfig, key: string): boolean {
  return config.hiddenItems.includes(key)
}

/**
 * Reads a stored hidden flag for a key that is no longer a navigation item,
 * such as legacy `areas`, which now controls Board Areas visibility.
 */
export function isStoredItemHidden(raw: unknown, key: string): boolean {
  const source = parseRawConfigObject(raw)
  return source[key] === false || (Array.isArray(source.hiddenItems) && source.hiddenItems.includes(key))
}

export function addSection(
  config: SidebarMenuConfig,
  label: string,
  explicitId?: string,
): { config: SidebarMenuConfig; sectionId: SidebarSectionId } {
  const cleanLabel = sanitizeLabel(label) || "New section"
  const candidateId = explicitId && !isBuiltinSidebarSectionId(explicitId) && isSidebarSectionId(explicitId) && !config.sectionOrder.includes(explicitId)
    ? explicitId
    : slugifySectionId(cleanLabel, config.sectionOrder)

  const sectionOrder = [...config.sectionOrder, candidateId]
  const sectionLabels = { ...config.sectionLabels, [candidateId]: cleanLabel }
  const sectionItems = cloneSectionItems(config)
  sectionItems[candidateId] = []

  return {
    sectionId: candidateId,
    config: {
      ...config,
      sectionOrder,
      sectionLabels,
      sectionItems,
    },
  }
}

/**
 * Deletes a custom section. Built-in sections cannot be deleted (only hidden).
 * Any items inside the deleted section are safely moved to `workspace` so zero items are lost.
 */
export function deleteSection(
  config: SidebarMenuConfig,
  sectionId: SidebarSectionId,
): SidebarMenuConfig {
  if (isBuiltinSidebarSectionId(sectionId) || !config.sectionOrder.includes(sectionId)) return config

  const orphanedItems = config.sectionItems[sectionId] ?? []
  const sectionOrder = config.sectionOrder.filter(id => id !== sectionId)
  const hiddenSections = config.hiddenSections.filter(id => id !== sectionId)
  const sectionLabels = { ...config.sectionLabels }
  delete sectionLabels[sectionId]

  const sectionItems = cloneSectionItems(config)
  delete sectionItems[sectionId]
  const fallbackSection = sectionOrder.includes("workspace") ? "workspace" : sectionOrder[0]
  if (fallbackSection && orphanedItems.length > 0) {
    sectionItems[fallbackSection] = [...(sectionItems[fallbackSection] ?? []), ...orphanedItems]
  }

  return {
    ...config,
    sectionOrder,
    hiddenSections,
    sectionLabels,
    sectionItems,
  }
}

export function toggleSectionVisibility(
  config: SidebarMenuConfig,
  sectionId: SidebarSectionId,
): SidebarMenuConfig {
  const hidden = config.hiddenSections.includes(sectionId)
    ? config.hiddenSections.filter(id => id !== sectionId)
    : [...config.hiddenSections, sectionId]
  return { ...config, hiddenSections: hidden }
}

export function renameSection(
  config: SidebarMenuConfig,
  sectionId: SidebarSectionId,
  nextLabel: string,
): SidebarMenuConfig {
  const clean = sanitizeLabel(nextLabel)
  const sectionLabels = { ...config.sectionLabels }
  if (!clean || (isBuiltinSidebarSectionId(sectionId) && clean === defaultSectionLabel(sectionId))) {
    delete sectionLabels[sectionId]
  } else {
    sectionLabels[sectionId] = clean
  }
  return { ...config, sectionLabels }
}

export function reorderSections(
  config: SidebarMenuConfig,
  fromSectionId: SidebarSectionId,
  toSectionId: SidebarSectionId,
  after: boolean,
): SidebarMenuConfig {
  if (fromSectionId === toSectionId) return config
  const order = config.sectionOrder.filter(id => id !== fromSectionId)
  const targetIndex = order.indexOf(toSectionId)
  if (targetIndex < 0) return config
  order.splice(targetIndex + Number(after), 0, fromSectionId)
  return { ...config, sectionOrder: order }
}

export function moveSectionByStep(
  config: SidebarMenuConfig,
  sectionId: SidebarSectionId,
  step: -1 | 1,
): SidebarMenuConfig {
  const index = config.sectionOrder.indexOf(sectionId)
  const targetIndex = index + step
  if (index < 0 || targetIndex < 0 || targetIndex >= config.sectionOrder.length) return config
  const order = [...config.sectionOrder]
  const [moved] = order.splice(index, 1)
  if (moved) order.splice(targetIndex, 0, moved)
  return { ...config, sectionOrder: order }
}

export function toggleItemVisibility(
  config: SidebarMenuConfig,
  itemKey: string,
): SidebarMenuConfig {
  const hidden = config.hiddenItems.includes(itemKey)
    ? config.hiddenItems.filter(key => key !== itemKey)
    : [...config.hiddenItems, itemKey]
  return { ...config, hiddenItems: hidden }
}

export function setItemVisible(
  config: SidebarMenuConfig,
  itemKey: string,
  visible: boolean,
): SidebarMenuConfig {
  const currentlyHidden = config.hiddenItems.includes(itemKey)
  if (visible && !currentlyHidden) return config
  if (!visible && currentlyHidden) return config
  return toggleItemVisibility(config, itemKey)
}

/**
 * Pins a nested shortcut (e.g. a named board or custom link) as an independent,
 * movable first-class item in the sidebar. If already pinned, ensures it is visible.
 */
export function pinCustomItem(
  config: SidebarMenuConfig,
  item: CustomNavItem,
  targetSection: SidebarSectionId = defaultSectionForItem(item.id),
): SidebarMenuConfig {
  const cleanLabel = sanitizeLabel(item.label) || item.id
  const cleanIcon = sanitizeCustomLinkIcon(item.icon)
  const exists = config.customItems.some(entry => entry.id === item.id)
  const customItems = exists
    ? config.customItems.map(entry => (entry.id === item.id ? { id: entry.id, href: item.href, icon: cleanIcon || entry.icon, label: entry.label } : entry))
    : [...config.customItems, { id: item.id, href: item.href, icon: cleanIcon, label: cleanLabel }]

  const sectionItems = cloneSectionItems(config)
  const resolvedTarget = config.sectionOrder.includes(targetSection) ? targetSection : "workspace"
  const existingSection = findItemSection(config, item.id)
  if (!existingSection) {
    sectionItems[resolvedTarget] = [...(sectionItems[resolvedTarget] ?? []), item.id]
  }
  const itemLabels = config.itemLabels[item.id]
    ? config.itemLabels
    : { ...config.itemLabels, [item.id]: cleanLabel }

  return {
    ...config,
    customItems,
    sectionItems,
    itemLabels,
    hiddenItems: config.hiddenItems.filter(key => key !== item.id),
  }
}

export function unpinCustomItem(
  config: SidebarMenuConfig,
  itemId: string,
): SidebarMenuConfig {
  const customItems = config.customItems.filter(entry => entry.id !== itemId)
  const sectionItems = cloneSectionItems(config)
  for (const sectionId of Object.keys(sectionItems)) {
    sectionItems[sectionId] = sectionItems[sectionId]!.filter(key => key !== itemId)
  }
  const itemLabels = { ...config.itemLabels }
  delete itemLabels[itemId]
  return {
    ...config,
    customItems,
    sectionItems,
    hiddenItems: config.hiddenItems.filter(key => key !== itemId),
    itemLabels,
  }
}

export function renameItem(
  config: SidebarMenuConfig,
  itemKey: string,
  nextLabel: string,
): SidebarMenuConfig {
  const clean = sanitizeLabel(nextLabel)
  const itemLabels = { ...config.itemLabels }
  if (!clean || clean === DEFAULT_SIDEBAR_ITEM_LABELS[itemKey]) {
    delete itemLabels[itemKey]
  } else {
    itemLabels[itemKey] = clean
  }
  const customItems = config.customItems.map(item =>
    item.id === itemKey && clean ? { ...item, label: clean } : item,
  )
  return { ...config, itemLabels, customItems }
}

export function findItemSection(config: SidebarMenuConfig, itemKey: string): SidebarSectionId | null {
  for (const sectionId of config.sectionOrder) {
    if (config.sectionItems[sectionId]?.includes(itemKey)) return sectionId
  }
  return null
}

/**
 * Reorders an item relative to another item — supports both within-section and
 * cross-section moves seamlessly.
 */
export function reorderItem(
  config: SidebarMenuConfig,
  itemKey: string,
  targetItemKey: string,
  after: boolean,
): SidebarMenuConfig {
  if (itemKey === targetItemKey) return config
  const sourceSection = findItemSection(config, itemKey)
  const targetSection = findItemSection(config, targetItemKey)
  if (!sourceSection || !targetSection) return config

  const nextSectionItems = cloneSectionItems(config)
  nextSectionItems[sourceSection] = nextSectionItems[sourceSection]!.filter(key => key !== itemKey)
  const targetList = nextSectionItems[targetSection]!
  const targetIndex = targetList.indexOf(targetItemKey)
  if (targetIndex < 0) return config
  targetList.splice(targetIndex + Number(after), 0, itemKey)

  return { ...config, sectionItems: nextSectionItems }
}

export function moveItemToSection(
  config: SidebarMenuConfig,
  itemKey: string,
  targetSectionId: SidebarSectionId,
): SidebarMenuConfig {
  const sourceSection = findItemSection(config, itemKey)
  if (!sourceSection || !config.sectionOrder.includes(targetSectionId)) return config
  const nextSectionItems = cloneSectionItems(config)
  nextSectionItems[sourceSection] = nextSectionItems[sourceSection]!.filter(key => key !== itemKey)
  nextSectionItems[targetSectionId]!.push(itemKey)
  return { ...config, sectionItems: nextSectionItems }
}

export function moveItemByStep(
  config: SidebarMenuConfig,
  itemKey: string,
  step: -1 | 1,
): SidebarMenuConfig {
  const sectionId = findItemSection(config, itemKey)
  if (!sectionId) return config
  const items = [...(config.sectionItems[sectionId] ?? [])]
  const index = items.indexOf(itemKey)
  const targetIndex = index + step
  if (index < 0 || targetIndex < 0 || targetIndex >= items.length) return config
  const [moved] = items.splice(index, 1)
  if (moved) items.splice(targetIndex, 0, moved)
  return {
    ...config,
    sectionItems: {
      ...config.sectionItems,
      [sectionId]: items,
    },
  }
}

export function flattenSidebarOrder(config: SidebarMenuConfig): string[] {
  return config.sectionOrder.flatMap(sectionId => config.sectionItems[sectionId] ?? [])
}

export function isSidebarConfigEqual(a: SidebarMenuConfig, b: SidebarMenuConfig): boolean {
  return JSON.stringify(serializeSidebarConfig(a)) === JSON.stringify(serializeSidebarConfig(b))
}

/**
 * Serializes the section-aware config while maintaining legacy flat keys so
 * existing consumers and settings exports stay compatible.
 */
export function serializeSidebarConfig(config: SidebarMenuConfig): SerializedSidebarConfig {
  const flatOrder = flattenSidebarOrder(config)
  const hiddenSet = new Set(config.hiddenItems)
  const serialized: SerializedSidebarConfig = {
    sections: {
      order: [...config.sectionOrder],
      hidden: [...config.hiddenSections],
      labels: { ...config.sectionLabels },
    },
    sectionItems: cloneSectionItems(config),
    hiddenItems: [...config.hiddenItems],
    order: flatOrder,
    labels: { ...config.itemLabels },
    customItems: config.customItems.map(item => ({
      id: item.id,
      href: item.href,
      icon: sanitizeCustomLinkIcon(item.icon),
      label: item.label,
    })),
  }

  for (const key of flatOrder) {
    serialized[key] = !hiddenSet.has(key)
  }

  return serialized
}

export function hasPersonalSidebarConfig(): boolean {
  if (typeof window === "undefined") return false
  try {
    return Boolean(window.localStorage.getItem(SIDEBAR_PERSONAL_STORAGE_KEY))
  } catch {
    return false
  }
}

export function readPersonalSidebarConfig(availableKeys?: readonly string[]): SidebarMenuConfig | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(SIDEBAR_PERSONAL_STORAGE_KEY)
    if (!raw) return null
    return normalizeSidebarConfig(raw, availableKeys)
  } catch {
    return null
  }
}

export function savePersonalSidebarConfig(config: SidebarMenuConfig): SerializedSidebarConfig | null {
  const payload = serializeSidebarConfig(config)
  if (typeof window === "undefined") return payload
  try {
    window.localStorage.setItem(SIDEBAR_PERSONAL_STORAGE_KEY, JSON.stringify(payload))
    return payload
  } catch {
    return null
  }
}

export function clearPersonalSidebarConfig(): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(SIDEBAR_PERSONAL_STORAGE_KEY)
  } catch {
    /* Storage may be unavailable */
  }
}
