import { type SectionDescriptor, defineSections } from "./section-registry"

export type DashboardSectionId =
  | "dashboard-overview"
  | "dashboard-momentum"
  | "dashboard-capture"
  | "dashboard-open"
  | "dashboard-recent"

export type DashboardSectionDescriptor = SectionDescriptor<DashboardSectionId>

export const DASHBOARD_SECTIONS = defineSections<DashboardSectionId>([
  {
    id: "dashboard-overview",
    label: "Overview",
    icon: "layout-dashboard",
    description: "Open, active, completed and overdue tasks.",
  },
  {
    id: "dashboard-momentum",
    label: "Momentum",
    icon: "flame",
    description: "Streaks, achievements and pinned tasks.",
  },
  {
    id: "dashboard-capture",
    label: "Capture",
    icon: "plus",
    description: "Add a task from its title.",
  },
  {
    id: "dashboard-open",
    label: "Focus",
    icon: "target",
    description: "Filter open tasks by assignee.",
  },
  {
    id: "dashboard-recent",
    label: "Recent",
    icon: "folder",
    description: "Open recently added tasks.",
  },
])
