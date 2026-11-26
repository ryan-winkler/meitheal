export const LIGHT_THEME_MODES = [
  "light",
  "zen-paper",
  "catppuccin-latte",
  "nordic-frost",
  "solarized-dawn",
] as const

export const DARK_NAMED_THEME_MODES = [
  "knight-rider",
  "plainspace",
  "velvet",
  "liquid-glass",
  "rainbow",
] as const

export const NAMED_THEME_MODES = [
  ...DARK_NAMED_THEME_MODES,
  "zen-paper",
  "catppuccin-latte",
  "nordic-frost",
  "solarized-dawn",
] as const

export const THEME_MODES = [
  "dark",
  ...DARK_NAMED_THEME_MODES,
  "light",
  "zen-paper",
  "catppuccin-latte",
  "nordic-frost",
  "solarized-dawn",
  "auto",
  "custom",
] as const

export type ThemeMode = (typeof THEME_MODES)[number]
export type LightThemeMode = (typeof LIGHT_THEME_MODES)[number]

export const THEME_META_COLORS: Record<string, string> = {
  "dark": "#10231b",
  "knight-rider": "#131314",
  "plainspace": "#1a1714",
  "velvet": "#12121d",
  "liquid-glass": "#0b1220",
  "rainbow": "#13111c",
  "light": "#f5faf7",
  "zen-paper": "#f4ece0",
  "catppuccin-latte": "#f5f0ec",
  "nordic-frost": "#ebf3fa",
  "solarized-dawn": "#fdf6e3",
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return THEME_MODES.some(mode => mode === value)
}

export function isLightThemeMode(value: unknown): value is LightThemeMode {
  return LIGHT_THEME_MODES.some(mode => mode === value)
}

export function isDarkNamedThemeMode(value: unknown): boolean {
  return DARK_NAMED_THEME_MODES.some(mode => mode === value)
}

export function isNamedThemeMode(value: unknown): boolean {
  return NAMED_THEME_MODES.some(mode => mode === value)
}
