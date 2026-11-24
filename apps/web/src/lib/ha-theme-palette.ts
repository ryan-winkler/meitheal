import type { applyPersonalAccent } from "./accent-colors"

export const HA_THEME_MATCH_KEY = "meitheal-match-ha-theme"

type Palette = {
  scheme: "light" | "dark"
  primary: string
  tokens: Record<string, string>
}

type Match = { state: "off" | "unavailable" | "contrast" } | { state: "active"; palette: Palette }

// Keep this function self-contained. Layout serializes it for the initial paint.
export function readHAThemePalette(enabled: boolean, ingress: boolean): Match {
  if (!enabled) return { state: "off" }
  if (!ingress || window.parent === window) return { state: "unavailable" }
  if (matchMedia("(forced-colors: active)").matches || matchMedia("(prefers-contrast: more)").matches) {
    return { state: "contrast" }
  }

  let style: CSSStyleDeclaration
  try {
    if (window.parent.location.origin !== location.origin || !window.frameElement?.isConnected) {
      return { state: "unavailable" }
    }
    style = window.parent.getComputedStyle(window.frameElement)
  } catch {
    return { state: "unavailable" }
  }

  type Rgb = [number, number, number]
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (!context) return { state: "unavailable" }
  function readColor(name: string): Rgb | undefined {
    const color = style.getPropertyValue(name).trim()
    if (!CSS.supports("color", color) || /^(currentcolor|inherit|initial|revert(?:-layer)?|unset)$/i.test(color)) return
    context!.clearRect(0, 0, 1, 1)
    context!.fillStyle = "transparent"
    context!.fillStyle = color
    context!.fillRect(0, 0, 1, 1)
    const [red, green, blue, alpha] = context!.getImageData(0, 0, 1, 1).data
    if (alpha === 255) return [red!, green!, blue!]
  }
  function luminance(color: Rgb): number {
    const linear = color.map(channel => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
  }
  function contrast(first: Rgb, second: Rgb): number {
    const a = luminance(first) + 0.05
    const b = luminance(second) + 0.05
    return Math.max(a, b) / Math.min(a, b)
  }

  const background = readColor("--primary-background-color")
  const text = readColor("--primary-text-color")
  const primary = readColor("--primary-color")
  if (!background || !text || !primary || contrast(text, background) < 4.5) return { state: "unavailable" }

  const panel = readColor("--secondary-background-color") ?? background
  const card = readColor("--card-background-color") ?? panel
  const hover = panel.map((channel, index) => Math.round(channel * 0.96 + text[index]! * 0.04)) as Rgb
  const surfaces = [background, panel, card, hover]
  function readable(color: Rgb, minimum: number): boolean {
    return surfaces.every(surface => contrast(color, surface) >= minimum)
  }
  if (!readable(text, 4.5)) return { state: "unavailable" }

  const secondary = readColor("--secondary-text-color") ?? text
  const accent = readColor("--accent-color") ?? primary
  const divider = readColor("--divider-color") ?? secondary
  const accentHover = primary.map(channel => Math.round(channel * 0.85)) as Rgb
  const roles = {
    "bg-primary": background,
    "bg-secondary": panel,
    "bg-card": card,
    "bg-input": card,
    "bg-hover": hover,
    "text-primary": text,
    "text-secondary": readable(secondary, 4.5) ? secondary : text,
    "text-muted": readable(secondary, 4.5) ? secondary : text,
    "accent": primary,
    "accent-hover": accentHover,
    "accent-text": readable(accent, 4.5) ? accent : text,
    "border": readable(divider, 3) ? divider : text,
    "border-focus": readable(accent, 3) ? accent : text,
  }
  const tokens: Record<string, string> = { "--accent-light": `rgb(${accent.join(" ")} / 0.12)` }
  for (const [role, rgb] of Object.entries(roles)) {
    const channels = rgb.join(" ")
    tokens[`--${role}`] = `rgb(${channels})`
    tokens[`--${role}-rgb`] = channels
  }
  return {
    state: "active",
    palette: {
      scheme: luminance(background) >= 0.179 ? "light" : "dark",
      primary: `#${primary.map(channel => channel.toString(16).padStart(2, "0")).join("")}`,
      tokens,
    },
  }
}

// Share the same replacements and cleanup at first paint and at runtime.
export function applyHAThemePalette(
  root: HTMLElement,
  match: Match,
  fallbackAccent: string | null,
  applyAccent: typeof applyPersonalAccent,
): void {
  const state = root.dataset.haMatch
  const doc = root.ownerDocument
  let style = doc.getElementById("meitheal-ha-theme-palette")
  if (match.state === "active") {
    const { scheme, primary, tokens } = match.palette
    if (root.style.getPropertyValue("--personal-accent") !== primary) applyAccent(root, primary)
    const foreground = root.style.getPropertyValue("--personal-accent-foreground")
    // The opt-in palette takes precedence over base presets for these roles.
    const declarations = Object.entries(tokens).map(([name, value]) => `${name}:${value}!important`).join(";")
    const css = `:root[data-ha-match="${scheme}"]{${declarations};--palette-on-accent:${foreground}!important}`
    if (!style) {
      style = doc.createElement("style")
      style.id = "meitheal-ha-theme-palette"
      doc.head.appendChild(style)
    }
    if (style.textContent !== css) style.textContent = css
    root.dataset.haMatch = scheme
    root.dataset.theme = scheme
    return
  }
  style?.remove()
  if (state === "light" || state === "dark") {
    applyAccent(root, fallbackAccent)
  }
  if (match.state === "off") delete root.dataset.haMatch
  else root.dataset.haMatch = match.state
}
