/**
 * Priority configuration — single source of truth.
 * Domain: Task Management
 *
 * Replaces 6+ duplicated priority maps across views.
 * Priority 1 = most urgent (Critical), Priority 5 = least urgent (Minimal).
 *
 * Usage:
 *   import { PRIORITY_CONFIG, getPriorityLabel, getPriorityColor } from '@lib/priority-config';
 */

export interface PriorityDef {
  /** Numeric priority value (1–5) */
  value: number
  /** Human-readable label (English fallback) */
  label: string
  /** i18n translation key for localized label */
  i18nKey: string
  /** Hex color for priority indicator */
  color: string
  /** CSS class name for styled elements */
  cssClass: string
  /** Accessibility icon — distinct shape per level (color-blind safe) */
  icon: string
}

/**
 * Canonical priority definitions.
 * 1 = Critical (red), 2 = High (amber), 3 = Medium (blue), 4 = Low (indigo), 5 = Minimal (gray).
 * Icons provide color-blind accessible encoding per WCAG 2.2.
 */
export const PRIORITY_CONFIG: readonly PriorityDef[] = [
  { value: 1, label: "Critical", i18nKey: "priority.critical", color: "#ef4444", cssClass: "priority-critical", icon: "▲" },
  { value: 2, label: "High",     i18nKey: "priority.high",     color: "#f59e0b", cssClass: "priority-high",     icon: "↑" },
  { value: 3, label: "Medium",   i18nKey: "priority.medium",   color: "#3b82f6", cssClass: "priority-medium",   icon: "→" },
  { value: 4, label: "Low",      i18nKey: "priority.low",      color: "#6366F1", cssClass: "priority-low",      icon: "↓" },
  { value: 5, label: "Minimal",  i18nKey: "priority.minimal",  color: "#6b7280", cssClass: "priority-minimal",  icon: "·" },
] as const

/** Lookup maps for fast access — used by SSR templates and client scripts */
export const PRIORITY_LABELS: Record<number, string> = Object.fromEntries(
  PRIORITY_CONFIG.map((p) => [p.value, p.label]),
)

export const PRIORITY_COLORS: Record<number, string> = Object.fromEntries(
  PRIORITY_CONFIG.map((p) => [p.value, p.color]),
)

export const PRIORITY_CSS_CLASSES: Record<number, string> = Object.fromEntries(
  PRIORITY_CONFIG.map((p) => [p.value, p.cssClass]),
)

/** Accessibility icons per priority level (color-blind safe) */
export const PRIORITY_ICONS: Record<number, string> = Object.fromEntries(
  PRIORITY_CONFIG.map((p) => [p.value, p.icon]),
)

/** Get label for a priority value, with fallback */
export function getPriorityLabel(priority: number): string {
  return PRIORITY_LABELS[priority] ?? "Medium"
}

/** Get color for a priority value, with fallback */
export function getPriorityColor(priority: number): string {
  return PRIORITY_COLORS[priority] ?? "#6b7280"
}

/** Get CSS class for a priority value, with fallback */
export function getPriorityCssClass(priority: number): string {
  return PRIORITY_CSS_CLASSES[priority] ?? "priority-medium"
}

/** Get accessibility icon for a priority value, with fallback */
export function getPriorityIcon(priority: number): string {
  return PRIORITY_ICONS[priority] ?? "→"
}
