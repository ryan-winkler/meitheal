export type TableSectionId =
  | "table-overview"
  | "table-filters"
  | "table-fields"
  | "table-flow"

export interface TableSectionDescriptor {
  id: TableSectionId
  label: string
  icon: string
  description: string
}

export const TABLE_SECTIONS: TableSectionDescriptor[] = [
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
]
