import { type SectionDescriptor, defineSections } from "./section-registry"

export type TableSectionId =
  | "table-overview"
  | "table-filters"
  | "table-fields"
  | "table-flow"

export type TableSectionDescriptor = SectionDescriptor<TableSectionId>

export const TABLE_SECTIONS = defineSections<TableSectionId>([
  {
    id: "table-overview",
    label: "Overview",
    icon: "⊞",
    description: "Counts, current workload signal, and route-level orientation.",
  },
  {
    id: "table-filters",
    label: "Filters",
    icon: "🧰",
    description: "Filter toolbar, saved presets, and the fastest way to narrow work.",
  },
  {
    id: "table-fields",
    label: "Fields",
    icon: "🧾",
    description: "Column visibility and the dense field surface of the table view.",
  },
  {
    id: "table-flow",
    label: "Flow",
    icon: "↗",
    description: "Cross-view movement into Kanban and Calendar without losing context.",
  },
])

import type { CanonicalIconName } from "../generated/icon-registry"

export interface TableColumnDef {
  id: string
  label: string
  icon: CanonicalIconName
  group: "core" | "planning"
  required?: boolean
  defaultVisible?: boolean
}

export const TABLE_COLUMNS: readonly TableColumnDef[] = [
  // Core task columns (visible by default)
  { id: "key", label: "Key", icon: "hash", group: "core", defaultVisible: true },
  { id: "title", label: "Title", icon: "file-text", group: "core", required: true, defaultVisible: true },
  { id: "type", label: "Type", icon: "tag", group: "core", defaultVisible: true },
  { id: "status", label: "Status", icon: "checkbox", group: "core", defaultVisible: true },
  { id: "priority", label: "Priority", icon: "flame", group: "core", defaultVisible: true },
  { id: "due-date", label: "Due Date", icon: "calendar-due", group: "core", defaultVisible: true },
  { id: "rice", label: "Score", icon: "target", group: "core", defaultVisible: true },
  { id: "calendar", label: "Calendar", icon: "calendar-event", group: "core", defaultVisible: true },
  { id: "custom-fields", label: "Custom Fields", icon: "list", group: "core", defaultVisible: true },
  { id: "assigned", label: "Assigned", icon: "user", group: "core", defaultVisible: true },
  { id: "labels", label: "Labels", icon: "tag", group: "core", defaultVisible: true },
  // Planning & Strategy columns (opt-in via Columns customizer)
  { id: "start-date", label: "Start Date", icon: "calendar", group: "planning", defaultVisible: false },
  { id: "effort", label: "Effort", icon: "clock", group: "planning", defaultVisible: false },
  { id: "story-points", label: "Story Points", icon: "bolt", group: "planning", defaultVisible: false },
  { id: "eisenhower", label: "Eisenhower", icon: "layout-grid", group: "planning", defaultVisible: false },
  { id: "progress", label: "Progress", icon: "chart-bar", group: "planning", defaultVisible: false },
  { id: "area", label: "Area", icon: "folder", group: "planning", defaultVisible: false },
  { id: "project", label: "Project", icon: "package", group: "planning", defaultVisible: false },
  { id: "epic", label: "Epic", icon: "rocket", group: "planning", defaultVisible: false },
  { id: "created", label: "Created", icon: "clock", group: "planning", defaultVisible: false },
] as const

export const TABLE_COLUMN_PREFS_KEY = "meitheal-column-preferences"

export function getDefaultVisibleTableColumns(): string[] {
  return TABLE_COLUMNS.filter(column => column.defaultVisible !== false).map(column => column.id)
}

export function loadTableColumnPreferences(): string[] {
  try {
    const raw = localStorage.getItem(TABLE_COLUMN_PREFS_KEY)
    if (!raw) return getDefaultVisibleTableColumns()
    const prefs = JSON.parse(raw) as Record<string, unknown> | null
    if (!prefs || typeof prefs !== "object") return getDefaultVisibleTableColumns()
    return TABLE_COLUMNS.filter(column => {
      if (column.id === "title") return true
      if (typeof prefs[column.id] === "boolean") return Boolean(prefs[column.id])
      return column.defaultVisible !== false
    }).map(column => column.id)
  } catch {
    return getDefaultVisibleTableColumns()
  }
}
