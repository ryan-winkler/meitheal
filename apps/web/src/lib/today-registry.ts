export type TodaySectionId =
  | "today-overview"
  | "today-focus"
  | "today-triage"
  | "today-work"
  | "today-habits"
  | "today-flow"

export interface TodaySectionDescriptor {
  id: TodaySectionId
  label: string
  icon: string
  description: string
}

export const TODAY_SECTIONS: TodaySectionDescriptor[] = [
  {
    id: "today-overview",
    label: "Overview",
    icon: "☀️",
    description: "Daily signal, quick capture, and the shortest path into work.",
  },
  {
    id: "today-focus",
    label: "Focus",
    icon: "🎯",
    description: "Focus stack and the next actions that deserve attention first.",
  },
  {
    id: "today-triage",
    label: "Triage",
    icon: "🧭",
    description: "Carried-forward work, suggested tasks, and cleanup decisions.",
  },
  {
    id: "today-work",
    label: "Work",
    icon: "📋",
    description: "Pinned, due-today, and unscheduled work on one operational surface.",
  },
  {
    id: "today-habits",
    label: "Habits",
    icon: "🔁",
    description: "Routine completions that flow back into shared task execution.",
  },
  {
    id: "today-flow",
    label: "Flow",
    icon: "🔀",
    description: "Switch context to the planning or execution view that fits your next move.",
  },
]
