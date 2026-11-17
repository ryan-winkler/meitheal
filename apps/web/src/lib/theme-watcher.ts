/**
 * Theme Watcher — prefers-color-scheme live listener
 *
 * Listens for OS-level theme changes (light/dark/auto/custom) and
 * dispatches a custom event for the app to respond to.
 *
 * Bounded context: lib (cross-domain utility)
 */

import { isThemeMode, type ThemeMode } from "./theme-mode"

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
  const value = readAppearanceValue(STORAGE_KEY)
  return isThemeMode(value) ? value : "auto"
}

export function getEffectiveTheme(stored = readStoredThemeMode()): "light" | "dark" {
  const matched = document.documentElement.dataset.haMatch
  if (matched === "light" || matched === "dark") return matched
  if (stored === "light" || stored === "dark") return stored
  // Custom themes layer on top of dark base
  if (stored === "custom" || stored === "knight-rider") return "dark"
  if (stored === "auto") {
    const appearance = document.documentElement.dataset.haTheme
    if (appearance === "light" || appearance === "dark") return appearance
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

export function setTheme(mode: ThemeMode): void {
  localStorage.setItem(STORAGE_KEY, mode)
  applyTheme()
}

export function applyTheme(): void {
  const stored = readStoredThemeMode()
  const root = document.documentElement
  const matched = root.dataset.haMatch === "light" || root.dataset.haMatch === "dark"
  const theme = getEffectiveTheme(stored)
  root.dataset.theme = !matched && (stored === "auto" || stored === "knight-rider") ? stored : theme
  root.classList.toggle("dark", theme === "dark")
  root.classList.toggle("light", theme === "light")
  applyCustomTheme(!matched && stored === "custom" && root.hasAttribute("data-custom-theme-admin")
    ? readAppearanceValue(CUSTOM_CSS_KEY) : null)
  const metaTheme = document.querySelector('meta[name="theme-color"]')
  if (metaTheme) {
    const color = matched ? getComputedStyle(root).getPropertyValue("--bg-primary").trim() : ""
    metaTheme.setAttribute("content", color || (root.dataset.theme === "knight-rider" ? "#131314" : theme === "dark" ? "#1a1a2e" : "#ffffff"))
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

export function initThemeWatcher(): void {
  applyTheme()
  const mq = window.matchMedia("(prefers-color-scheme: dark)")
  mq.addEventListener("change", () => {
    if (readStoredThemeMode() === "auto") applyTheme()
  })
}
