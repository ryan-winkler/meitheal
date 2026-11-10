import { isFrameworkFormulaSupported } from "./framework-formula"

/**
 * Framework Configuration — manages YAML defaults + user overrides
 *
 * YAML files in apps/web/src/content/frameworks/ are immutable defaults.
 * User edits (weights, descriptions, help text) are stored as JSON overrides
 * in SQLite and merged on top at runtime.
 */

/** Supported framework archetypes (from YAML configs) */
export type FrameworkArchetype = "formula" | "matrix" | "taxonomy" | "workflow"

/** Source of a framework definition */
export type FrameworkSource = "built-in" | "user" | "imported"

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
  /** Where this framework came from */
  source: FrameworkSource
  /** Scoring formula expression (for formula archetypes) */
  formula?: string | undefined
  /** Badge threshold tiers */
  badgeThresholds: BadgeThreshold[]
  /** Field definitions */
  fields: FrameworkField[]
  /** Short description for catalog/listings */
  description?: string | undefined
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
    source: (raw.source as FrameworkSource) ?? "built-in",
    formula: raw.formula ? String(raw.formula) : undefined,
    badgeThresholds,
    fields,
    description: raw.description ? String(raw.description) : undefined,
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

/**
 * Validate a framework configuration object.
 * Returns null if valid, or an array of error messages.
 */
export function validateFrameworkConfig(
  config: Partial<FrameworkConfig>,
): string[] | null {
  const errors: string[] = []

  if (!config.id || typeof config.id !== "string") {
    errors.push("id is required and must be a non-empty string")
  } else if (!/^[a-z0-9-]+$/.test(config.id)) {
    errors.push("id must be lowercase alphanumeric with hyphens only")
  }

  if (!config.name || typeof config.name !== "string") {
    errors.push("name is required")
  }

  const validArchetypes: FrameworkArchetype[] = ["formula", "matrix", "taxonomy", "workflow"]
  if (!config.archetype || !validArchetypes.includes(config.archetype)) {
    errors.push(`archetype must be one of: ${validArchetypes.join(", ")}`)
  }

  if (!Array.isArray(config.fields) || config.fields.length === 0) {
    errors.push("At least one field is required")
  } else {
    const keys = new Set<string>()
    for (const field of config.fields) {
      if (!field || typeof field !== "object" || Array.isArray(field)) {
        errors.push("Each field must be an object")
        continue
      }
      if (!field.key || typeof field.key !== "string") {
        errors.push("Each field must have a non-empty key")
      } else if (keys.has(field.key)) {
        errors.push(`Duplicate field key: ${field.key}`)
      } else {
        keys.add(field.key)
      }
      for (const bound of ["min", "max"] as const) {
        if (field[bound] !== undefined && (typeof field[bound] !== "number" || !Number.isFinite(field[bound]))) {
          errors.push(`Field "${field.key}" ${bound} must be a finite number`)
        }
      }
      if (typeof field.min === "number" && typeof field.max === "number" && field.min > field.max) errors.push(`Field "${field.key}" min must not exceed max`)
      if (!field.label) errors.push(`Field "${field.key}" must have a label`)
    }
  }

  if (config.archetype === "formula" && !config.formula) {
    errors.push("Formula archetypes require a formula expression")
  }

  const fieldKeys = Array.isArray(config.fields) ? config.fields.flatMap(field => typeof field?.key === "string" ? [field.key] : []) : []
  if (config.formula && (typeof config.formula !== "string" || !isFrameworkFormulaSupported(config.formula, fieldKeys))) {
    errors.push("Formula must use declared fields, numbers, parentheses and + - * / operators")
  }

  if (!Array.isArray(config.badgeThresholds)) {
    errors.push("badgeThresholds must be an array")
  }

  return errors.length > 0 ? errors : null
}

/**
 * Convert a FrameworkConfig back to YAML-compatible plain object.
 * Useful for export/display.
 */
export function frameworkConfigToRaw(config: FrameworkConfig): Record<string, unknown> {
  return {
    name: config.name,
    version: config.version,
    archetype: config.archetype,
    description: config.description ?? "",
    formula: config.formula,
    badge_thresholds: config.badgeThresholds.map((t) => ({
      min: t.min,
      label: t.label,
      color: t.color,
    })),
    fields: config.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      ui_type: f.uiType,
      weight: f.weight,
      min: f.min,
      max: f.max,
      options: f.options?.map((o) => ({ value: o.value, label: o.label })),
      help_text: f.helpText,
    })),
  }
}
