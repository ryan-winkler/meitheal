/**
 * ha-theme-bridge.ts — Sync HA theme CSS variables → Meitheal RGB channel tokens
 *
 * @bounded-context ha (Home Assistant integration)
 * @kcs The CSS passthrough in _tokens.css maps HA hex vars (--primary-color, etc.)
 *      to Meitheal semantic tokens (--accent, --bg-primary, etc.) via CSS var() fallback.
 *      However, Tailwind v4 opacity modifiers (bg-accent/10) require RGB channel vars
 *      (--accent-rgb: 99 102 241) which can't be derived from CSS variables in pure CSS.
 *      This bridge reads computed HA theme colors and sets the corresponding RGB channels.
 *
 * Lifecycle:
 *   - Runs once on page load when body.ha-ingress is detected
 *   - Re-syncs on 'settheme' custom event from HA (theme changes)
 *   - Cleaned up automatically via pageLifecycle.signal
 */

import { pageLifecycle } from "./page-lifecycle"

/** HA CSS variable → Meitheal RGB channel variable mapping */
const HA_TO_RGB_MAP: ReadonlyArray<[haVar: string, rgbVar: string]> = [
  ["--primary-background-color", "--bg-primary-rgb"],
  ["--secondary-background-color", "--bg-secondary-rgb"],
  ["--card-background-color", "--bg-card-rgb"],
  ["--primary-text-color", "--text-primary-rgb"],
  ["--secondary-text-color", "--text-secondary-rgb"],
  ["--disabled-text-color", "--text-muted-rgb"],
  ["--primary-color", "--accent-rgb"],
  ["--dark-primary-color", "--accent-hover-rgb"],
  ["--error-color", "--danger-rgb"],
  ["--warning-color", "--warning-rgb"],
  ["--info-color", "--info-rgb"],
  ["--divider-color", "--border-rgb"],
]

/**
 * Parse a CSS color string (hex, rgb, rgba) into an "R G B" space-separated string
 * suitable for Tailwind's rgb(var(--token) / alpha) syntax.
 *
 * Returns null if parsing fails — caller should skip that token.
 */
function colorToRgbChannels(color: string): string | null {
  if (!color || color === "transparent" || color === "inherit") return null

  // Hex: #RGB, #RRGGBB, #RRGGBBAA
  const hex = color.trim()
  if (hex.startsWith("#")) {
    const h = hex.slice(1)
    if (h.length === 3 || h.length === 4) {
      const r = parseInt(h.charAt(0) + h.charAt(0), 16)
      const g = parseInt(h.charAt(1) + h.charAt(1), 16)
      const b = parseInt(h.charAt(2) + h.charAt(2), 16)
      return `${r} ${g} ${b}`
    }
    if (h.length >= 6) {
      const r = parseInt(h.slice(0, 2), 16)
      const g = parseInt(h.slice(2, 4), 16)
      const b = parseInt(h.slice(4, 6), 16)
      return `${r} ${g} ${b}`
    }
  }

  // rgb(r, g, b) or rgba(r, g, b, a)
  const rgbMatch = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (rgbMatch) {
    return `${rgbMatch[1]} ${rgbMatch[2]} ${rgbMatch[3]}`
  }

  return null
}

/**
 * Sync all HA CSS vars to Meitheal RGB channel tokens.
 * Reads computed styles from document.body and sets RGB channel vars on :root.
 */
function syncHAThemeToRGB(): void {
  const computed = getComputedStyle(document.body)
  const root = document.documentElement

  for (const [haVar, rgbVar] of HA_TO_RGB_MAP) {
    const rawValue = computed.getPropertyValue(haVar).trim()
    if (!rawValue) continue

    const rgb = colorToRgbChannels(rawValue)
    if (rgb) {
      root.style.setProperty(rgbVar, rgb)
    }
  }
}

/**
 * Initialize the HA theme bridge.
 * Only activates when running inside HA ingress (body.ha-ingress).
 *
 * Call from Layout.astro after the ha-ingress class has been set.
 */
export function initHAThemeBridge(): void {
  if (!document.body.classList.contains("ha-ingress")) return

  const signal = pageLifecycle.signal

  // Initial sync
  syncHAThemeToRGB()

  // Re-sync when HA fires a theme change event
  // HA dispatches 'settheme' on the document when the user changes theme
  document.addEventListener("settheme", () => {
    // Small delay to let HA CSS vars propagate
    setTimeout(syncHAThemeToRGB, 50)
  }, { signal })

  // Also listen for the HA-specific 'll-theme-changed' event
  window.addEventListener("message", (e) => {
    if (typeof e.data === "object" && e.data?.type === "theme-changed") {
      setTimeout(syncHAThemeToRGB, 50)
    }
  }, { signal })
}
