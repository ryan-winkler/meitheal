export type HabitsSectionId =
  | "habits-overview"
  | "habits-rhythm"
  | "habits-library"
  | "habits-flow"

export interface HabitsSectionDescriptor {
  id: HabitsSectionId
  label: string
  icon: string
  description: string
}

export const HABITS_SECTIONS: HabitsSectionDescriptor[] = [
  {
    id: "habits-overview",
    label: "Overview",
    icon: "✦",
    description: "See the current habits signal and the Home Assistant-native flow.",
  },
  {
    id: "habits-rhythm",
    label: "Rhythm",
    icon: "🔥",
    description: "Track completions, streaks, and daily versus weekly cadence mix.",
  },
  {
    id: "habits-library",
    label: "Library",
    icon: "🔁",
    description: "Review, complete, create, and edit the routines that spawn real tasks.",
  },
  {
    id: "habits-flow",
    label: "Flow",
    icon: "↗",
    description: "Follow how habits move into Today, Kanban, Table, and Upcoming.",
  },
]
