/**
 * Design Tokens — shared constants for Meitheal UI
 *
 * Central source of truth for colors, spacing, and UI constants.
 * Replaces scattered magic values across components.
 *
 * @domain shared/ui
 */

/** Default accent color — Meitheal Living Mint (matches CSS --accent) */
export const DEFAULT_ACCENT = "#69E3B2"

/** Default entity icon for new areas/projects */
export const DEFAULT_ICON = "📋"

/** Default home area icon */
export const HOME_ICON = "🏠"

/**
 * Curated color swatch palette for area/project customization.
 * Order: primary brand mint, indigo, warm, cool, neutral.
 */
export const COLOR_SWATCHES = [
  "#69E3B2", // Living Mint (default brand accent)
  "#10B981", // Emerald
  "#14B8A6", // Teal
  "#3B82F6", // Blue
  "#6366F1", // Indigo
  "#8B5CF6", // Violet
  "#EC4899", // Pink
  "#F0B86D", // Warm Amber
  "#F59E0B", // Amber
  "#F97316", // Orange
  "#EF4444", // Red
  "#64748B", // Slate
] as const

/** Curated Indigo swatch referenced by settings UI without literal chrome hex duplication */
export const INDIGO_SWATCH = COLOR_SWATCHES[4]

/** Type for valid swatch colors */
export type SwatchColor = (typeof COLOR_SWATCHES)[number]
