/**
 * Label Color Resolver — deterministic label name → hex color mapping.
 *
 * @kcs Color resolution priority:
 * 1. Vikunja compat store (user-defined colors)
 * 2. Hash-based palette (deterministic fallback for labels not in store)
 *
 * The hash palette uses HSL to generate visually distinct, harmonious colors
 * that work in both light and dark themes.
 */

import { getLabelColorMap } from "./label-store"

/**
 * HSL-based palette for deterministic fallback colors.
 * 8 hues at 65% saturation, 45% lightness — works in light/dark themes.
 */
const PALETTE: string[] = [
  "#6366f1", // indigo
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#8b5cf6", // violet
  "#14b8a6", // teal
  "#ec4899", // pink
]

/**
 * CSS class suffix for known label color variants.
 * Maps to `.label-badge--{variant}` in _labels.css.
 */
const COLOR_TO_VARIANT: Record<string, string> = {
  "#6366f1": "purple",
  "#3b82f6": "blue",
  "#10b981": "green",
  "#f59e0b": "amber",
  "#ef4444": "red",
  "#8b5cf6": "purple",
  "#14b8a6": "teal",
  "#ec4899": "pink",
}

/** Simple string hash → index into palette array. */
function hashToIndex(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % PALETTE.length
}

/** Cached color map — refreshed per request in Astro SSR (MPA). */
let cachedMap: Map<string, string> | null = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 30_000 // 30s — enough for MPA page renders

async function getColorMap(): Promise<Map<string, string>> {
  const now = Date.now()
  if (cachedMap && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedMap
  }
  try {
    cachedMap = await getLabelColorMap()
    cacheTimestamp = now
  } catch {
    // First-boot: Vikunja compat schema may not exist yet
    cachedMap = new Map()
    cacheTimestamp = now
  }
  return cachedMap
}

/** Reset cache (for tests). */
export function resetColorCache(): void {
  cachedMap = null
  cacheTimestamp = 0
}

/**
 * Resolve a label name to its hex color.
 * Checks Vikunja compat store first, falls back to hash-based palette.
 */
export async function resolveLabelColor(
  labelName: string
): Promise<string> {
  const map = await getColorMap()
  const stored = map.get(labelName.toLowerCase())
  if (stored) return stored
  return PALETTE[hashToIndex(labelName.toLowerCase())] ?? "#6b7280"
}

/**
 * Resolve a label name to its CSS class variant (for _labels.css).
 * Returns "default" if no variant matches.
 */
export async function resolveLabelVariant(
  labelName: string
): Promise<string> {
  const color = await resolveLabelColor(labelName)
  return COLOR_TO_VARIANT[color] ?? "default"
}

/**
 * Batch-resolve colors for multiple label names.
 * More efficient than calling resolveLabelColor() in a loop
 * because it loads the color map once.
 */
export async function resolveAllLabelColors(
  labelNames: string[]
): Promise<Array<{ name: string; color: string; variant: string }>> {
  const map = await getColorMap()
  return labelNames.map((name) => {
    const stored = map.get(name.toLowerCase())
    const color = stored ?? PALETTE[hashToIndex(name.toLowerCase())] ?? "#6b7280"
    const variant = COLOR_TO_VARIANT[color] ?? "default"
    return { name, color, variant }
  })
}
