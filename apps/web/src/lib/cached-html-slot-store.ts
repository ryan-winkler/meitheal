import {
  CLIENT_DYNAMIC_ICON_NAMES,
  ICON_INNER_SVG,
  isIconName,
  resolveCanonicalIconName,
  type CanonicalIconName,
} from "../generated/icon-registry"

export interface CachedHtmlEntry {
  html: string
  icons: string[]
}

const MAX_CACHE_ENTRIES = 64
const slotCache = new Map<string, CachedHtmlEntry>()
const spriteSvgCache = new Map<string, string>()
const SPRITE_ICON_RE = /#mt-icon-([a-z0-9-]+)/g

/** Return a cached SSR sprite <svg> block for the active icon set, updating LRU order. */
export function getCachedIconSpriteHtml(usedIcons: Iterable<string> | undefined): string {
  const symbolSet = new Set<CanonicalIconName>(CLIENT_DYNAMIC_ICON_NAMES)
  for (const raw of usedIcons ?? []) {
    if (isIconName(raw)) {
      symbolSet.add(resolveCanonicalIconName(raw))
    }
  }
  if (symbolSet.size === 0) return ""
  const sortedNames = Array.from(symbolSet).sort()
  const cacheKey = sortedNames.join(",")
  const cached = spriteSvgCache.get(cacheKey)
  if (cached !== undefined) {
    spriteSvgCache.delete(cacheKey)
    spriteSvgCache.set(cacheKey, cached)
    return cached
  }
  const symbols = sortedNames
    .map((name) => `<symbol id="mt-icon-${name}" viewBox="0 0 24 24">${ICON_INNER_SVG[name]}</symbol>`)
    .join("")
  const html = `<svg id="mt-icon-sprite-defs" hidden aria-hidden="true" style="display:none" xmlns="http://www.w3.org/2000/svg"><defs>${symbols}</defs></svg>`
  if (spriteSvgCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = spriteSvgCache.keys().next().value
    if (oldest !== undefined) spriteSvgCache.delete(oldest)
  }
  spriteSvgCache.set(cacheKey, html)
  return html
}

/** Return a cached SSR HTML fragment and advance its LRU position. */
export function getCachedHtmlSlot(key: string): CachedHtmlEntry | undefined {
  const existing = slotCache.get(key)
  if (!existing) return undefined
  slotCache.delete(key)
  slotCache.set(key, existing)
  return existing
}

/** Store a rendered SSR HTML fragment together with its referenced sprite icon names. */
export function setCachedHtmlSlot(key: string, html: string): CachedHtmlEntry {
  const icons = new Set<string>()
  SPRITE_ICON_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SPRITE_ICON_RE.exec(html)) !== null) {
    if (match[1]) icons.add(match[1])
  }
  const entry: CachedHtmlEntry = { html, icons: Array.from(icons) }
  if (slotCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = slotCache.keys().next().value
    if (oldest !== undefined) slotCache.delete(oldest)
  }
  slotCache.set(key, entry)
  return entry
}
