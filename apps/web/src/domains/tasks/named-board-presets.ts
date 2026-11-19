export const NAMED_BOARD_PRESETS = {
  standard: ["Backlog", "To Do", "In Progress", "Done"],
  project: ["Backlog", "To Do", "In Progress", "Delivered"],
  chores: ["Backlog", "To Do", "Doing", "Checked Off"],
} as const

export type NamedBoardPreset = keyof typeof NAMED_BOARD_PRESETS

export function isNamedBoardPreset(value: unknown): value is NamedBoardPreset {
  return typeof value === "string" && Object.hasOwn(NAMED_BOARD_PRESETS, value)
}
