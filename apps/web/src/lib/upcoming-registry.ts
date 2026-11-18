import { type SectionDescriptor, defineSections } from "./section-registry"

export type UpcomingSectionId =
  | "upcoming-overview"
  | "upcoming-next"
  | "upcoming-week"
  | "upcoming-flow"

export type UpcomingSectionDescriptor = SectionDescriptor<UpcomingSectionId>

export const UPCOMING_SECTIONS = defineSections<UpcomingSectionId>([
  {
    id: "upcoming-overview",
    label: "Overview",
    icon: "calendar",
    description: "Tasks due in the next seven days.",
  },
  {
    id: "upcoming-next",
    label: "Today and tomorrow",
    icon: "bolt",
    description: "Tasks due today or tomorrow.",
  },
  {
    id: "upcoming-week",
    label: "Following five days",
    icon: "calendar-event",
    description: "Tasks due in the following five days.",
  },
  {
    id: "upcoming-flow",
    label: "Related views",
    icon: "arrows-left-right",
    description: "Open Today or Calendar.",
  },
])
