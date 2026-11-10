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

export const TABLE_COLUMNS = [
  { id: "key", label: "Key" },
  { id: "title", label: "Title", required: true },
  { id: "type", label: "Type" },
  { id: "status", label: "Status" },
  { id: "priority", label: "Priority" },
  { id: "due-date", label: "Due Date" },
  { id: "rice", label: "RICE" },
  { id: "calendar", label: "Calendar" },
  { id: "custom-fields", label: "Custom Fields" },
  { id: "assigned", label: "Assigned" },
  { id: "labels", label: "Labels" },
] as const

export const TABLE_COLUMN_PREFS_KEY = "meitheal-column-preferences"

export function loadTableColumnPreferences(): string[] {
  try {
    const prefs = JSON.parse(localStorage.getItem(TABLE_COLUMN_PREFS_KEY) ?? "{}")
    return TABLE_COLUMNS.filter(column => column.id === "title" || prefs?.[column.id] !== false).map(column => column.id)
  } catch {
    return TABLE_COLUMNS.map(column => column.id)
  }
}
