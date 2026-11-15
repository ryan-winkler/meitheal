/*
 * Tabler outline helper adapters backed by build-extracted @tabler/icons
 * paths in apps/web/src/generated/icon-registry.ts.
 *
 * Source icons: @tabler/icons (MIT License, Copyright (c) 2020-2026 Paweł Kuna)
 */
import {
  CANONICAL_ICON_NAMES,
  LEGACY_ICON_ALIASES,
  createSpriteIconElement,
  resolveCanonicalIconName,
  type CanonicalIconName,
  type IconName,
} from "../generated/icon-registry"

export const TABLER_LEGACY_ALIASES = {
  "pinned-off": "pin",
  "calendar-check": "calendar-event",
  "chevron-right": "chevron-down",
  "chevron-left": "chevron-down",
  "arrow-up": "arrows-left-right",
  "arrow-right": "arrows-left-right",
  "circle-dashed": "clock",
  "circle-check": "check",
  "menu-open": "layout-sidebar-left-collapse",
  "panel-left-close": "layout-sidebar-left-collapse",
  "panel-left-open": "layout-sidebar-left-collapse",
  filter: "adjustments-horizontal",
  folders: "folder",
  checklist: "list-check",
  key: "settings",
  lock: "settings",
  copy: "clipboard-list",
  ban: "x",
  dots: "menu-2",
  "clock-pause": "clock",
  hourglass: "clock",
  pillars: "layout-grid",
  bulb: "sparkles",
  robot: "message-chatbot",
  dice: "sparkles",
  award: "star",
  medal: "star",
  scale: "target",
  "trending-up": "chart-bar",
  message: "message-circle",
  activity: "bolt",
  "align-left": "file-text",
} as const satisfies Record<string, CanonicalIconName>

export type TablerIconName = IconName | keyof typeof TABLER_LEGACY_ALIASES

const CANONICAL_SET = new Set<string>(CANONICAL_ICON_NAMES)

export function resolveTablerIconName(name: string): IconName {
  if (CANONICAL_SET.has(name) || name in LEGACY_ICON_ALIASES) {
    return name as IconName
  }
  if (name in TABLER_LEGACY_ALIASES) {
    return TABLER_LEGACY_ALIASES[name as keyof typeof TABLER_LEGACY_ALIASES]
  }
  return "checkbox"
}

export function createTablerSvgElement(
  name: TablerIconName,
  size = 16,
  className?: string,
): SVGSVGElement {
  return createSpriteIconElement(resolveTablerIconName(name), {
    size,
    className,
    strokeWidth: 1.75,
  })
}

const DEFAULT_EMOJI_TO_TABLER: Record<string, IconName> = {
  "🏠": "home",
  "🏡": "home",
  "🗂": "folder",
  "🗂️": "folder",
  "📁": "folder",
  "📂": "folder",
  "☀️": "sun",
  "☀": "sun",
  "📋": "list-check",
  "📥": "inbox",
  "⚡": "bolt",
  "✅": "checkbox",
  "☑️": "checkbox",
  "🛒": "shopping-cart",
  "📅": "calendar-event",
  "🗓️": "calendar",
  "🗓": "calendar",
  "🏛️": "layout-grid",
  "🏛": "layout-grid",
  "🔁": "repeat",
  "🔄": "repeat",
  "🎯": "target",
  "🏆": "trophy",
  "💡": "sparkles",
  "⚖️": "target",
  "⚖": "target",
  "📈": "chart-bar",
  "📊": "chart-bar",
  "🔥": "flame",
  "✨": "sparkles",
  "🚀": "rocket",
  "🎲": "sparkles",
  "🎨": "palette",
  "🔑": "settings",
  "🔒": "settings",
  "⚙️": "settings",
  "⚙": "settings",
  "📌": "pin",
  "🏅": "star",
  "🛡️": "star",
  "🔌": "plug",
  "🔔": "bell",
  "🏷️": "adjustments-horizontal",
  "🏷": "adjustments-horizontal",
}

export function mapEntityEmojiToTabler(raw?: string | null): IconName | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null
  if (CANONICAL_SET.has(trimmed) || trimmed in LEGACY_ICON_ALIASES) {
    return resolveCanonicalIconName(trimmed as IconName)
  }
  if (trimmed in TABLER_LEGACY_ALIASES) {
    return TABLER_LEGACY_ALIASES[trimmed as keyof typeof TABLER_LEGACY_ALIASES]
  }
  return DEFAULT_EMOJI_TO_TABLER[trimmed] ?? null
}

export function resolveAchievementTablerIcon(idOrIcon?: string | null): IconName {
  const key = (idOrIcon ?? "").trim().toLowerCase()
  if (!key) return "star"
  const mapped = mapEntityEmojiToTabler(idOrIcon)
  if (mapped) return mapped
  if (key.includes("first")) return "target"
  if (key.includes("100") || key.includes("century") || key.includes("champion")) return "trophy"
  if (key.includes("50")) return "bolt"
  if (key.includes("25") || key.includes("quarter")) return "sparkles"
  if (key.includes("10")) return "rocket"
  if (key.includes("streak")) return "flame"
  if (key.includes("xp") || key.includes("sparkle")) return "sparkles"
  if (key.includes("level")) return "star"
  return "star"
}

export function renderIconOrCustomEmoji(
  container: HTMLElement,
  rawIcon: string | null | undefined,
  fallbackIcon: TablerIconName,
  size = 16,
  className?: string,
): void {
  const trimmed = rawIcon?.trim()
  const mapped = trimmed ? mapEntityEmojiToTabler(trimmed) : fallbackIcon
  if (mapped) {
    container.replaceChildren(createTablerSvgElement(mapped, size, className))
    return
  }
  container.textContent = trimmed || ""
}
