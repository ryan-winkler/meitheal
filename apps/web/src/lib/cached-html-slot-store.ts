import {
  CLIENT_DYNAMIC_ICON_NAMES,
  ICON_INNER_SVG,
  isIconName,
  resolveCanonicalIconName,
  type CanonicalIconName,
} from "../generated/icon-registry"

export interface CachedHtmlByteChunk {
  render(destination: { write(chunk: unknown): void }): void
}

export interface CachedHtmlEntry {
  html: string
  bytes: Uint8Array
  byteChunk: CachedHtmlByteChunk
  icons: string[]
}

const MAX_CACHE_ENTRIES = 64
const MAX_SPRITE_CACHE_ENTRIES = 32
const slotCache = new Map<string, CachedHtmlEntry>()
const iconSpriteCache = new Map<string, string>()
const SPRITE_ICON_RE = /#mt-icon-([a-z0-9-]+)/g
const htmlEncoder = new TextEncoder()

/** Return cached SVG markup for the active icon sprite definitions. */
export function getCachedIconSpriteHtml(usedIcons: Iterable<string> | undefined): string {
  const symbolSet = new Set<CanonicalIconName>(CLIENT_DYNAMIC_ICON_NAMES)
  if (usedIcons) {
    for (const raw of usedIcons) {
      if (isIconName(raw)) {
        symbolSet.add(resolveCanonicalIconName(raw))
      }
    }
  }
  if (symbolSet.size === 0) return ""
  const sorted = Array.from(symbolSet).sort()
  const key = sorted.join(",")
  const cached = iconSpriteCache.get(key)
  if (cached) {
    iconSpriteCache.delete(key)
    iconSpriteCache.set(key, cached)
    return cached
  }
  const symbols = new Array<string>(sorted.length)
  for (let i = 0; i < sorted.length; i += 1) {
    const name = sorted[i]!
    symbols[i] = `<symbol id="mt-icon-${name}" viewBox="0 0 24 24">${ICON_INNER_SVG[name]}</symbol>`
  }
  const svg = `<svg id="mt-icon-sprite-defs" hidden aria-hidden="true" style="display:none" xmlns="http://www.w3.org/2000/svg"><defs>${symbols.join("")}</defs></svg>`
  if (iconSpriteCache.size >= MAX_SPRITE_CACHE_ENTRIES) {
    const oldest = iconSpriteCache.keys().next().value
    if (oldest !== undefined) iconSpriteCache.delete(oldest)
  }
  iconSpriteCache.set(key, svg)
  return svg
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
  const bytes = htmlEncoder.encode(html)
  const byteChunk: CachedHtmlByteChunk = Object.freeze({
    render(destination: { write(chunk: unknown): void }) {
      destination.write(bytes)
    },
  })
  const entry: CachedHtmlEntry = { html, bytes, byteChunk, icons: Array.from(icons) }
  if (slotCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = slotCache.keys().next().value
    if (oldest !== undefined) slotCache.delete(oldest)
  }
  slotCache.set(key, entry)
  return entry
}
