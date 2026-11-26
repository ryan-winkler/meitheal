/**
 * Theme Watcher — prefers-color-scheme live listener
 *
 * Listens for OS-level theme changes (light/dark/auto/custom) and
 * dispatches a custom event for the app to respond to.
 *
 * Bounded context: lib (cross-domain utility)
 */

import { isDarkNamedThemeMode, isLightThemeMode, isNamedThemeMode, isThemeMode, THEME_META_COLORS, type ThemeMode } from "./theme-mode"
import { readWorkspacePreferences } from "./workspace-preferences"

const STORAGE_KEY = "meitheal-theme"
const CUSTOM_CSS_KEY = "meitheal-custom-theme-css"
const CUSTOM_STYLE_ID = "meitheal-custom-theme"

export function readAppearanceValue(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function readStoredThemeMode(): ThemeMode {
  const preferred = readWorkspacePreferences().theme
  if (preferred) return preferred
  const value = readAppearanceValue(STORAGE_KEY)
  return isThemeMode(value) ? value : "auto"
}

export function getEffectiveTheme(stored = readStoredThemeMode(), followSystem = readWorkspacePreferences().theme === "auto"): "light" | "dark" {
  const matched = document.documentElement.dataset.haMatch
  if (matched === "light" || matched === "dark") return matched
  if (isLightThemeMode(stored)) return "light"
  if (stored === "dark" || stored === "custom" || isDarkNamedThemeMode(stored)) return "dark"
  if (stored === "auto" && !followSystem) {
    const appearance = document.documentElement.dataset.haTheme
    if (appearance === "light" || appearance === "dark") return appearance
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

/** Stores the theme without applying it, for a page that is previewing another draft. */
export function storeTheme(mode: ThemeMode): void {
  localStorage.setItem(STORAGE_KEY, mode)
}

export function setTheme(mode: ThemeMode): void {
  storeTheme(mode)
  applyTheme()
}

export function applyTheme(stored = readStoredThemeMode(), followSystem = readWorkspacePreferences().theme === "auto"): void {
  const root = document.documentElement
  const matched = root.dataset.haMatch === "light" || root.dataset.haMatch === "dark"
  const theme = getEffectiveTheme(stored, followSystem)
  const resolvedDefault = theme === "dark" ? "knight-rider" : "light"
  const inheritIngress = !followSystem && Boolean(window.__ingress_path)
  root.dataset.theme = !matched && isNamedThemeMode(stored)
    ? stored
    : !matched && stored === "auto"
      ? inheritIngress ? "auto" : resolvedDefault
      : theme
  root.classList.toggle("dark", theme === "dark")
  root.classList.toggle("light", theme === "light")
  applyCustomTheme(!matched && stored === "custom" && root.hasAttribute("data-custom-theme-admin")
    ? readAppearanceValue(CUSTOM_CSS_KEY) : null)
  const metaTheme = document.querySelector('meta[name="theme-color"]')
  if (metaTheme) {
    const color = matched ? getComputedStyle(root).getPropertyValue("--bg-primary").trim() : ""
    const fallback = THEME_META_COLORS[root.dataset.theme === "auto" ? theme : root.dataset.theme || ""] || (theme === "dark" ? "#131314" : "#f5faf7")
    metaTheme.setAttribute("content", color || fallback)
  }
  window.dispatchEvent(new CustomEvent("meitheal:theme-changed", { detail: { theme } }))
}

/**
 * Inject or remove custom theme CSS.
 * Pass `null` to remove any active custom theme.
 */
export function applyCustomTheme(css: string | null): void {
  let el = document.getElementById(CUSTOM_STYLE_ID) as HTMLStyleElement | null
  if (!css) {
    el?.remove()
    return
  }
  if (!el) {
    el = document.createElement("style")
    el.id = CUSTOM_STYLE_ID
    document.head.appendChild(el)
  }
  if (el.textContent !== css) el.textContent = css
}

export function initThemeWatcher(signal: AbortSignal): void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)")
  mq.addEventListener("change", () => {
    if (readStoredThemeMode() === "auto") applyTheme()
  }, { signal })
}
