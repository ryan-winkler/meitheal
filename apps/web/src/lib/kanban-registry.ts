export type KanbanSectionId =
  | "kanban-overview"
  | "kanban-lanes"
  | "kanban-fields"
  | "kanban-flow"

export interface KanbanSectionDescriptor {
  id: KanbanSectionId
  label: string
  icon: string
  description: string
}

export const KANBAN_SECTIONS: KanbanSectionDescriptor[] = [
  {
    id: "kanban-overview",
    label: "Overview",
    icon: "▦",
    description: "Board context, current workload, and route-level orientation.",
  },
  {
    id: "kanban-lanes",
    label: "Lanes",
    icon: "🧱",
    description: "Lane management, WIP cues, and the main board surface.",
  },
  {
    id: "kanban-fields",
    label: "Fields",
    icon: "🪄",
    description: "Card-field emphasis, filters, and view density controls.",
  },
  {
    id: "kanban-flow",
    label: "Flow",
    icon: "↗",
    description: "Cross-view continuity into Table and Calendar with current context.",
  },
]
