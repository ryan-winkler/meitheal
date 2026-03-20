/**
 * Design Tokens — shared constants for Meitheal UI
 *
 * Central source of truth for colors, spacing, and UI constants.
 * Replaces scattered magic values across components.
 *
 * @domain shared/ui
 */

/** Default accent color — Indigo 500 (matches CSS --accent) */
export const DEFAULT_ACCENT = "#6366F1"

/** Default entity icon for new areas/projects */
export const DEFAULT_ICON = "📋"

/** Default home area icon */
export const HOME_ICON = "🏠"

/**
 * Curated color swatch palette for area/project customization.
 * Order: primary accent, warm, cool, neutral.
 */
export const COLOR_SWATCHES = [
  "#6366F1", // Indigo (accent)
  "#EF4444", // Red
  "#F59E0B", // Amber
  "#10B981", // Emerald
  "#3B82F6", // Blue
  "#8B5CF6", // Violet
  "#EC4899", // Pink
  "#14B8A6", // Teal
  "#F97316", // Orange
  "#64748B", // Slate
] as const

/** Type for valid swatch colors */
export type SwatchColor = (typeof COLOR_SWATCHES)[number]
