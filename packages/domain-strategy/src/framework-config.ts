import { isFrameworkFormulaSupported } from "./framework-formula"

const formulaError = "Formula must use declared fields, numbers, parentheses and + - * / operators"

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

/** Check option data before it reaches a form or the scorer. */
export function isFrameworkFieldOptions(options: unknown): options is FrameworkFieldOption[] {
  return Array.isArray(options) && options.every(option => option && typeof option.label === "string" &&
    (typeof option.value === "string" || Number.isFinite(option.value)))
}

/** A single field definition within a framework */
export interface FrameworkField {
  key: string
  label: string
  description?: string | undefined
  type: "number" | "select" | "boolean" | "text" | "matrix"
  uiType: "slider" | "radio" | "select" | "checkbox"
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

/** Validate the JSON override contract before persistence or merging. */
export function validateFrameworkOverrides(
  value: unknown,
  fieldKeys?: readonly string[],
  { preserveLegacyFormula = false } = {},
): string[] | null {
  const record = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)
  if (!record(value)) return ["Overrides must be an object"]
  const errors: string[] = []
  for (const key of Object.keys(value)) {
    if (!["fields", "formula", "badgeThresholds"].includes(key)) errors.push(`Unsupported override: ${key}`)
  }
  if ("fields" in value) {
    if (!record(value.fields)) errors.push("fields must be a dictionary keyed by field key")
    else for (const [key, field] of Object.entries(value.fields)) {
      if (!key || ["__proto__", "prototype", "constructor"].includes(key) || (fieldKeys && !fieldKeys.includes(key))) errors.push(`Unknown field: ${key}`)
      if (!record(field)) { errors.push(`Field ${key} overrides must be an object`); continue }
      for (const property of Object.keys(field)) {
        if (!["weight", "label", "helpText"].includes(property)) errors.push(`Unsupported field override: ${key}.${property}`)
      }
      if ("weight" in field && (typeof field.weight !== "number" || !Number.isFinite(field.weight) || field.weight < 0)) errors.push(`Field ${key} weight must be a finite non-negative number`)
      if ("label" in field && (typeof field.label !== "string" || !field.label.trim())) errors.push(`Field ${key} label must be a non-empty string`)
      if ("helpText" in field && typeof field.helpText !== "string") errors.push(`Field ${key} helpText must be a string`)
    }
  }
  if ("formula" in value) {
    if (typeof value.formula !== "string" || !value.formula.trim()) errors.push("formula must be a non-empty string")
    else if (fieldKeys && !preserveLegacyFormula && !isFrameworkFormulaSupported(value.formula, fieldKeys)) {
      errors.push(formulaError)
    }
  }
  if ("badgeThresholds" in value) {
    if (!Array.isArray(value.badgeThresholds)) errors.push("badgeThresholds must be an array")
    else for (const badge of value.badgeThresholds) {
      if (!record(badge) || typeof badge.min !== "number" || !Number.isFinite(badge.min) || typeof badge.label !== "string" || typeof badge.color !== "string" || Object.keys(badge).some((key) => !["min", "label", "color"].includes(key))) errors.push("Each badge requires a finite min, string label and string color")
    }
  }
  return errors.length ? errors : null
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
        ...(typeof f.description === "string" ? { description: f.description } : {}),
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

/** Check the scoring semantics separately so backup restore can retain legacy definitions. */
export function validateFrameworkScoring(
  fields: readonly Pick<FrameworkField, "key" | "min" | "max" | "options">[],
  formula: unknown,
): string[] {
  const errors: string[] = []
  for (const field of fields) {
    if (field.options != null && !isFrameworkFieldOptions(field.options)) {
      errors.push(`Field "${field.key}" options must have a label and a text or numeric value`)
    }
    for (const bound of ["min", "max"] as const) {
      if (field[bound] !== undefined && (typeof field[bound] !== "number" || !Number.isFinite(field[bound]))) {
        errors.push(`Field "${field.key}" ${bound} must be a finite number`)
      }
    }
    if (typeof field.min === "number" && typeof field.max === "number" && field.min > field.max) {
      errors.push(`Field "${field.key}" min must not exceed max`)
    }
  }
  if (formula !== undefined && (typeof formula !== "string" || (formula && !isFrameworkFormulaSupported(formula, fields.map(field => field.key))))) {
    errors.push(formulaError)
  }
  return errors
}

/** Return validation errors for a framework configuration, or null when valid. */
export function validateFrameworkConfig(
  config: Partial<FrameworkConfig>,
  { preserveLegacyScoring = false } = {},
): string[] | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return ["Framework must be an object"]
  const errors: string[] = []
  const fields: FrameworkField[] = []

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
      fields.push(field)
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
  if (!preserveLegacyScoring) {
    errors.push(...validateFrameworkScoring(fields, config.formula))
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
      ...(f.description !== undefined ? { description: f.description } : {}),
      type: f.type,
      ui_type: f.uiType,
      weight: f.weight,
      min: f.min,
      max: f.max,
      options: f.options,
      help_text: f.helpText,
    })),
  }
}
