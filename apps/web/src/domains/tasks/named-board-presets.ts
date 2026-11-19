export const NAMED_BOARD_PRESETS = {
  standard: ["To Do", "In Progress", "Done"],
  project: ["Backlog", "In Progress", "Delivered"],
  chores: ["To Do", "Doing", "Checked Off"],
} as const

export type NamedBoardPreset = keyof typeof NAMED_BOARD_PRESETS

export function isNamedBoardPreset(value: unknown): value is NamedBoardPreset {
  return typeof value === "string" && Object.hasOwn(NAMED_BOARD_PRESETS, value)
}
