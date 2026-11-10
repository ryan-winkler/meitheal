/**
 * Theme Watcher — prefers-color-scheme live listener
 *
 * Listens for OS-level theme changes (light/dark/auto/custom) and
 * dispatches a custom event for the app to respond to.
 *
 * Bounded context: lib (cross-domain utility)
 */

export type ThemeMode = "light" | "dark" | "auto" | "custom"

const STORAGE_KEY = "meitheal-theme"
const CUSTOM_CSS_KEY = "meitheal-custom-theme-css"
const CUSTOM_STYLE_ID = "meitheal-custom-theme"

export function getEffectiveTheme(): "light" | "dark" {
  const stored = localStorage.getItem(STORAGE_KEY) as ThemeMode | null
  if (stored === "light" || stored === "dark") return stored
  // Custom themes layer on top of dark base
  if (stored === "custom") return "dark"
  if (stored === "auto") {
    const appearance = document.documentElement.dataset.haTheme
    if (appearance === "light" || appearance === "dark") return appearance
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

export function setTheme(mode: ThemeMode): void {
  localStorage.setItem(STORAGE_KEY, mode)
  applyTheme()
  // Auto-apply custom CSS when switching to custom
  if (mode === "custom") {
    const css = localStorage.getItem(CUSTOM_CSS_KEY)
    applyCustomTheme(css)
  } else {
    applyCustomTheme(null)
  }
}

export function applyTheme(): void {
  const stored = localStorage.getItem(STORAGE_KEY) as ThemeMode | null
  const theme = getEffectiveTheme()
  // For built-in themes, set data-theme for CSS variable overrides
  if (stored === "custom") {
    // Custom themes use dark as base, override via injected <style>
    document.documentElement.dataset.theme = "dark"
  } else if (stored === "auto") {
    document.documentElement.dataset.theme = "auto"
  } else {
    document.documentElement.dataset.theme = theme
  }
  document.documentElement.classList.toggle("dark", theme === "dark")
  document.documentElement.classList.toggle("light", theme === "light")
  const metaTheme = document.querySelector('meta[name="theme-color"]')
  if (metaTheme) {
    metaTheme.setAttribute("content", theme === "dark" ? "#1a1a2e" : "#ffffff")
  }
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
  el.textContent = css
}

export function initThemeWatcher(): void {
  applyTheme()
  // If custom theme, restore injected CSS from localStorage
  const stored = localStorage.getItem(STORAGE_KEY) as ThemeMode | null
  if (stored === "custom") {
    const css = localStorage.getItem(CUSTOM_CSS_KEY)
    applyCustomTheme(css)
  }
  const mq = window.matchMedia("(prefers-color-scheme: dark)")
  mq.addEventListener("change", () => {
    const current = localStorage.getItem(STORAGE_KEY) as ThemeMode | null
    if (!current || current === "auto") {
      applyTheme()
      window.dispatchEvent(new CustomEvent("meitheal:theme-changed", {
        detail: { theme: getEffectiveTheme() },
      }))
    }
  })
}
