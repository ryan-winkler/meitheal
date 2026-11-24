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

import { labelNameKey } from "./label-name"

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

/** Compatibility hook: colors are now supplied per request, so there is no shared cache. */
export function resetColorCache(): void {}

/**
 * Resolve a label name to its hex color.
 * Checks Vikunja compat store first, falls back to hash-based palette.
 */
export async function resolveLabelColor(
  labelName: string,
  map: ReadonlyMap<string, string>,
): Promise<string> {
  const key = labelNameKey(labelName)
  const stored = map.get(key)
  if (stored) return stored
  return PALETTE[hashToIndex(key)] ?? "#6b7280"
}

/**
 * Resolve a label name to its CSS class variant (for _labels.css).
 * Returns "default" if no variant matches.
 */
export async function resolveLabelVariant(
  labelName: string,
  map: ReadonlyMap<string, string>,
): Promise<string> {
  const color = await resolveLabelColor(labelName, map)
  return COLOR_TO_VARIANT[color] ?? "default"
}

/**
 * Batch-resolve colors for multiple label names.
 * More efficient than calling resolveLabelColor() in a loop
 * because it loads the color map once.
 */
export async function resolveAllLabelColors(
  labelNames: string[],
  map: ReadonlyMap<string, string>,
): Promise<Array<{ name: string; color: string; variant: string }>> {
  return labelNames.map((name) => {
    const key = labelNameKey(name)
    const stored = map.get(key)
    const color = stored ?? PALETTE[hashToIndex(key)] ?? "#6b7280"
    const variant = COLOR_TO_VARIANT[color] ?? "default"
    return { name, color, variant }
  })
}
