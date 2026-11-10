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
    icon: "✦",
    description: "Orientation, workload, and high-signal stats",
  },
  {
    id: "dashboard-momentum",
    label: "Momentum",
    icon: "🔥",
    description: "Streaks, XP, and pinned work that keeps momentum visible",
  },
  {
    id: "dashboard-capture",
    label: "Capture",
    icon: "＋",
    description: "Fast task capture without leaving the dashboard",
  },
  {
    id: "dashboard-open",
    label: "Focus",
    icon: "🎯",
    description: "Open work filtered by person when you need to focus",
  },
  {
    id: "dashboard-recent",
    label: "Recent",
    icon: "🗂",
    description: "Recently touched work and quick re-entry",
  },
])
