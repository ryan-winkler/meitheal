export const THEME_MODES = ["dark", "knight-rider", "light", "auto", "custom"] as const

export type ThemeMode = (typeof THEME_MODES)[number]

export function isThemeMode(value: unknown): value is ThemeMode {
  return THEME_MODES.some(mode => mode === value)
}
