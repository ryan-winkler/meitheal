import { type SectionDescriptor, defineSections } from "./section-registry"

export type CalendarSectionId =
  | "calendar-overview"
  | "calendar-month"
  | "calendar-agenda"
  | "calendar-flow"

export type CalendarSectionDescriptor = SectionDescriptor<CalendarSectionId>

export const CALENDAR_SECTIONS = defineSections<CalendarSectionId>([
  {
    id: "calendar-overview",
    label: "Overview",
    icon: "🗓️",
    description: "Month context, connected calendars, and planning orientation.",
  },
  {
    id: "calendar-month",
    label: "Month",
    icon: "📆",
    description: "The month grid, counts, and date-based navigation controls.",
  },
  {
    id: "calendar-agenda",
    label: "Agenda",
    icon: "📋",
    description: "Day detail, task due lists, and inline event previews.",
  },
  {
    id: "calendar-flow",
    label: "Flow",
    icon: "↗",
    description: "Operational handoff into Today, Upcoming, and the other task views.",
  },
])
