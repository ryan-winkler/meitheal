import { type SectionDescriptor, defineSections } from "./section-registry"

export type EisenhowerSectionId =
  | "eisenhower-overview"
  | "eisenhower-matrix"
  | "eisenhower-flow"

export type EisenhowerSectionDescriptor = SectionDescriptor<EisenhowerSectionId>

export const EISENHOWER_SECTIONS = defineSections<EisenhowerSectionId>([
  {
    id: "eisenhower-overview",
    label: "Overview",
    icon: "target",
    description: "Triage status, completed-today counter, and weekly review entry point.",
  },
  {
    id: "eisenhower-matrix",
    label: "Matrix",
    icon: "layout-grid",
    description: "The 2×2 urgency-importance grid with drag-and-drop between quadrants.",
  },
  {
    id: "eisenhower-flow",
    label: "Flow",
    icon: "external-link",
    description: "Operational handoff into Today, Upcoming, and the other task views.",
  },
])
