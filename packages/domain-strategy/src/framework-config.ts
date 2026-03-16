/**
 * Framework Configuration — manages YAML defaults + user overrides
 *
 * YAML files in apps/web/src/content/frameworks/ are immutable defaults.
 * User edits (weights, descriptions, help text) are stored as JSON overrides
 * in SQLite and merged on top at runtime.
 */

/** Supported framework archetypes (from YAML configs) */
export type FrameworkArchetype = "formula" | "matrix" | "taxonomy" | "workflow"

/** A single field option (for select/radio fields) */
export interface FrameworkFieldOption {
  value: string | number
  label: string
}

/** A single field definition within a framework */
export interface FrameworkField {
  key: string
  label: string
  type: "number" | "select"
  uiType: "slider" | "radio" | "select"
  weight: number
  min?: number | undefined
  max?: number | undefined
  options?: FrameworkFieldOption[] | undefined
  helpText: string
}

/** Badge threshold for score display */
export interface BadgeThreshold {
  min: number
  label: string
  color: string
}

/** The full framework configuration (YAML defaults merged with user overrides) */
export interface FrameworkConfig {
  /** Framework identifier (e.g. "rice", "heart", "ddd", "kcs") */
  id: string
  /** Display name */
  name: string
  /** Schema version */
  version: string
  /** How the framework operates: formula, matrix, taxonomy, or workflow */
  archetype: FrameworkArchetype
  /** Scoring formula expression (for formula archetypes) */
  formula?: string | undefined
  /** Badge threshold tiers */
  badgeThresholds: BadgeThreshold[]
  /** Field definitions */
  fields: FrameworkField[]
}

/**
 * User-editable overrides stored in SQLite.
 * Keys are field keys, values override specific properties.
 */
export interface FrameworkOverrides {
  /** Per-field overrides: { "reach": { weight: 1.5, helpText: "..." } } */
  fields?: Record<string, Partial<Pick<FrameworkField, "weight" | "helpText" | "label">>> | undefined
  /** Override badge thresholds */
  badgeThresholds?: BadgeThreshold[] | undefined
  /** Override formula expression */
  formula?: string | undefined
}

/** Stored override record in SQLite */
export interface FrameworkOverrideRecord {
  id: string
  frameworkId: string
  overrides: FrameworkOverrides
  createdAt: string
  updatedAt: string
}

/**
 * Parse a raw YAML object into a typed FrameworkConfig.
 * Normalizes the snake_case YAML keys to camelCase.
 */
export function parseFrameworkConfig(id: string, raw: Record<string, unknown>): FrameworkConfig {
  const fields = Array.isArray(raw.fields)
    ? (raw.fields as Record<string, unknown>[]).map((f) => ({
        key: String(f.key ?? ""),
        label: String(f.label ?? ""),
        type: String(f.type ?? "number") as FrameworkField["type"],
        uiType: String(f.ui_type ?? "slider") as FrameworkField["uiType"],
        weight: Number(f.weight ?? 1),
        min: f.min !== undefined ? Number(f.min) : undefined,
        max: f.max !== undefined ? Number(f.max) : undefined,
        options: Array.isArray(f.options)
          ? (f.options as Record<string, unknown>[]).map((o) => ({
              value: o.value as string | number,
              label: String(o.label ?? ""),
            }))
          : undefined,
        helpText: String(f.help_text ?? ""),
      }))
    : []

  const badgeThresholds = Array.isArray(raw.badge_thresholds)
    ? (raw.badge_thresholds as Record<string, unknown>[]).map((t) => ({
        min: Number(t.min ?? 0),
        label: String(t.label ?? ""),
        color: String(t.color ?? ""),
      }))
    : []

  return {
    id,
    name: String(raw.name ?? id.toUpperCase()),
    version: String(raw.version ?? "1.0.0"),
    archetype: String(raw.archetype ?? "formula") as FrameworkArchetype,
    formula: raw.formula ? String(raw.formula) : undefined,
    badgeThresholds,
    fields,
  }
}

/**
 * Merge YAML defaults with user overrides.
 * Overrides take precedence for any specified property.
 */
export function mergeFrameworkConfig(
  base: FrameworkConfig,
  overrides: FrameworkOverrides | null,
): FrameworkConfig {
  if (!overrides) return base

  const merged = { ...base }

  // Merge field-level overrides
  if (overrides.fields) {
    merged.fields = base.fields.map((field) => {
      const fieldOverride = overrides.fields?.[field.key]
      if (!fieldOverride) return field
      return {
        ...field,
        ...fieldOverride,
      }
    })
  }

  // Override badge thresholds
  if (overrides.badgeThresholds) {
    merged.badgeThresholds = overrides.badgeThresholds
  }

  // Override formula
  if (overrides.formula !== undefined) {
    merged.formula = overrides.formula
  }

  return merged
}
