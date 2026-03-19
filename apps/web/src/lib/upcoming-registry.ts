export type UpcomingSectionId =
  | "upcoming-overview"
  | "upcoming-next"
  | "upcoming-week"
  | "upcoming-flow"

export interface UpcomingSectionDescriptor {
  id: UpcomingSectionId
  label: string
  icon: string
  description: string
}

export const UPCOMING_SECTIONS: UpcomingSectionDescriptor[] = [
  {
    id: "upcoming-overview",
    label: "Overview",
    icon: "📅",
    description: "What is scheduled next and where to jump when the week shifts.",
  },
  {
    id: "upcoming-next",
    label: "Next 48h",
    icon: "⚡",
    description: "Today and tomorrow grouped as the most immediate commitment surface.",
  },
  {
    id: "upcoming-week",
    label: "Week Ahead",
    icon: "🗓️",
    description: "The remaining scheduled days, grouped for low-friction scanning.",
  },
  {
    id: "upcoming-flow",
    label: "Flow",
    icon: "↗",
    description: "Handoff back to Today and across to Calendar without losing context.",
  },
]
