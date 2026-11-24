import { type SectionDescriptor, defineSections } from "./section-registry"

export type HabitsSectionId =
  | "habits-overview"
  | "habits-rhythm"
  | "habits-library"
  | "habits-flow"

export type HabitsSectionDescriptor = SectionDescriptor<HabitsSectionId>

export const HABITS_SECTIONS = defineSections<HabitsSectionId>([
  {
    id: "habits-overview",
    label: "Overview",
    icon: "layout-dashboard",
    description: "Open the Routines overview.",
  },
  {
    id: "habits-rhythm",
    label: "Rhythm",
    icon: "flame",
    description: "Completions, streaks and routine cadence.",
  },
  {
    id: "habits-library",
    label: "Library",
    icon: "repeat",
    description: "Create, edit and complete routines.",
  },
  {
    id: "habits-flow",
    label: "Related views",
    icon: "arrows-left-right",
    description: "Open Today, Kanban, Table or Upcoming.",
  },
])
