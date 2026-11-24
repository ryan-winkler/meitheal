export interface CachedHtmlEntry {
  html: string
  icons: string[]
}

const MAX_CACHE_ENTRIES = 64
const slotCache = new Map<string, CachedHtmlEntry>()
const SPRITE_ICON_RE = /#mt-icon-([a-z0-9-]+)/g

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
