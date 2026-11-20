export type TaskType = "epic" | "story" | "task" | "documentation"
export type FrameworkSource = "built-in" | "user" | "imported"

export interface RiceInput {
  reach: number
  impact: number
  confidence: number
  effort: number
}

export interface AIScope {
  canAutoScore: boolean
  canAutoClose: boolean
  canChangePriority: boolean
  canSuggestLabels: boolean
  customInstructions: string
}

export const DEFAULT_AI_SCOPE: AIScope = {
  canAutoScore: false,
  canAutoClose: false,
  canChangePriority: false,
  canSuggestLabels: false,
  customInstructions: "",
}

export interface TaskRule {
  id: string
  name: string
  description: string
  ruleType: "strategic-lens" | "ai-scope" | "custom"
  taskTypes: TaskType[]
  tags: string[]
  lensIds: string[]
  aiScope: AIScope
  constraints: string
  priority: number
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export function createTaskRule(input: {
  id?: string
  name: string
  description?: string
  ruleType?: TaskRule["ruleType"]
  taskTypes?: TaskType[]
  tags?: string[]
  lensIds?: string[]
  aiScope?: Partial<AIScope>
  constraints?: string
  priority?: number
  enabled?: boolean
}): TaskRule {
  const now = new Date().toISOString()
  return {
    id: input.id ?? crypto.randomUUID(),
    name: input.name,
    description: input.description ?? "",
    ruleType: input.ruleType ?? "strategic-lens",
    taskTypes: input.taskTypes ?? [],
    tags: input.tags ?? [],
    lensIds: input.lensIds ?? [],
    aiScope: { ...DEFAULT_AI_SCOPE, ...input.aiScope },
    constraints: input.constraints ?? "",
    priority: input.priority ?? 100,
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  }
}

export interface RuleResolutionMatch {
  matchedRules: TaskRule[]
  lensIds: string[]
  aiScope: AIScope
  constraints: string[]
}

export function resolveRulesForTask(
  taskType: TaskType,
  tags: readonly string[],
  rules: readonly TaskRule[],
): RuleResolutionMatch {
  const tagSet = new Set(tags.map(t => t.toLowerCase()))
  const matched = rules
    .filter(rule => {
      if (!rule.enabled) return false
      if (rule.taskTypes.length > 0 && !rule.taskTypes.includes(taskType)) return false
      if (rule.tags.length > 0 && !rule.tags.some(t => tagSet.has(t.toLowerCase()))) return false
      return true
    })
    .sort((a, b) => a.priority - b.priority)

  const lensIds: string[] = []
  const seenLenses = new Set<string>()
  const constraints: string[] = []
  const aiScope: AIScope = { ...DEFAULT_AI_SCOPE }
  const customInstructions: string[] = []

  for (const rule of matched) {
    for (const lensId of rule.lensIds) {
      if (!seenLenses.has(lensId)) {
        seenLenses.add(lensId)
        lensIds.push(lensId)
      }
    }
    if (rule.aiScope.canAutoScore) aiScope.canAutoScore = true
    if (rule.aiScope.canAutoClose) aiScope.canAutoClose = true
    if (rule.aiScope.canChangePriority) aiScope.canChangePriority = true
    if (rule.aiScope.canSuggestLabels) aiScope.canSuggestLabels = true
    if (rule.aiScope.customInstructions?.trim()) customInstructions.push(rule.aiScope.customInstructions.trim())
    if (rule.constraints?.trim()) constraints.push(rule.constraints.trim())
  }
  aiScope.customInstructions = customInstructions.join("\n")

  return { matchedRules: matched, lensIds, aiScope, constraints }
}

export interface FrameworkFieldOption {
  value: string | number
  label: string
}

export interface FrameworkField {
  key: string
  label: string
  type: string
  uiType?: string | undefined
  ui_type?: string | undefined
  min?: number | undefined
  max?: number | undefined
  weight?: number | undefined
  helpText?: string | undefined
  help_text?: string | undefined
  description?: string | undefined
  options?: FrameworkFieldOption[] | undefined
}

export interface BadgeThreshold {
  min: number
  label: string
  color: string
}

export interface FrameworkConfig {
  id: string
  name: string
  version: string
  archetype: string
  source: FrameworkSource
  description?: string | undefined
  formula?: string | undefined
  badgeThresholds: BadgeThreshold[]
  fields: FrameworkField[]
}

export interface FrameworkFieldOverride {
  label?: string | undefined
  weight?: number | undefined
  min?: number | undefined
  max?: number | undefined
  helpText?: string | undefined
  description?: string | undefined
  options?: FrameworkFieldOption[] | undefined
}

export interface FrameworkOverrides {
  name?: string | undefined
  description?: string | undefined
  formula?: string | undefined
  badgeThresholds?: BadgeThreshold[] | undefined
  fields?: Record<string, FrameworkFieldOverride> | undefined
}

export interface FrameworkOverrideRecord {
  id: string
  frameworkId: string
  overrides: FrameworkOverrides
  createdAt: string
  updatedAt: string
}

export function isFrameworkFieldOptions(value: unknown): value is FrameworkFieldOption[] {
  return (
    Array.isArray(value) &&
    value.every(
      item =>
        item !== null &&
        typeof item === "object" &&
        ("value" in item) &&
        (typeof (item as FrameworkFieldOption).value === "string" || typeof (item as FrameworkFieldOption).value === "number") &&
        typeof (item as FrameworkFieldOption).label === "string",
    )
  )
}

// ── Safe arithmetic formula parser (recursive descent, no eval) ──

type Token =
  | { kind: "num"; value: number }
  | { kind: "id"; value: string }
  | { kind: "op"; value: "+" | "-" | "*" | "/" }
  | { kind: "lparen" }
  | { kind: "rparen" }

function tokenizeFormula(formula: string): Token[] | null {
  const tokens: Token[] = []
  let i = 0
  while (i < formula.length) {
    const ch = formula[i]!
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      tokens.push({ kind: "op", value: ch })
      i++
      continue
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen" })
      i++
      continue
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen" })
      i++
      continue
    }
    if (/[0-9.]/.test(ch)) {
      let start = i
      while (i < formula.length && /[0-9.]/.test(formula[i]!)) i++
      const num = Number(formula.slice(start, i))
      if (!Number.isFinite(num)) return null
      tokens.push({ kind: "num", value: num })
      continue
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let start = i
      while (i < formula.length && /[a-zA-Z0-9_]/.test(formula[i]!)) i++
      tokens.push({ kind: "id", value: formula.slice(start, i) })
      continue
    }
    return null
  }
  return tokens.length > 0 ? tokens : null
}

function evaluateTokens(tokens: Token[], values: Record<string, unknown>): number | null {
  let pos = 0

  function parseExpr(): number | null {
    let left = parseTerm()
    if (left === null) return null
    while (pos < tokens.length && tokens[pos]?.kind === "op" && (tokens[pos]!.value === "+" || tokens[pos]!.value === "-")) {
      const op = (tokens[pos++] as { kind: "op"; value: "+" | "-" }).value
      const right = parseTerm()
      if (right === null) return null
      left = op === "+" ? left + right : left - right
    }
    return left
  }

  function parseTerm(): number | null {
    let left = parseFactor()
    if (left === null) return null
    while (pos < tokens.length && tokens[pos]?.kind === "op" && (tokens[pos]!.value === "*" || tokens[pos]!.value === "/")) {
      const op = (tokens[pos++] as { kind: "op"; value: "*" | "/" }).value
      const right = parseFactor()
      if (right === null) return null
      if (op === "/") {
        if (right === 0) return null
        left = left / right
      } else {
        left = left * right
      }
    }
    return left
  }

  function parseFactor(): number | null {
    const tok = tokens[pos]
    if (!tok) return null
    if (tok.kind === "op" && (tok.value === "+" || tok.value === "-")) {
      pos++
      const inner = parseFactor()
      if (inner === null) return null
      return tok.value === "-" ? -inner : inner
    }
    if (tok.kind === "num") {
      pos++
      return tok.value
    }
    if (tok.kind === "id") {
      pos++
      const raw = values[tok.value]
      const num = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN
      return Number.isFinite(num) ? num : null
    }
    if (tok.kind === "lparen") {
      pos++
      const inner = parseExpr()
      if (inner === null || tokens[pos]?.kind !== "rparen") return null
      pos++
      return inner
    }
    return null
  }

  const result = parseExpr()
  if (result === null || pos !== tokens.length || !Number.isFinite(result)) return null
  return Math.round(result * 100) / 100
}

export function isFrameworkFormulaSupported(formula: string): boolean {
  if (typeof formula !== "string" || !formula.trim() || formula.length > 500) return false
  const tokens = tokenizeFormula(formula)
  if (!tokens) return false
  const dummyValues: Record<string, number> = {}
  for (const tok of tokens) {
    if (tok.kind === "id") dummyValues[tok.value] = 1
  }
  return evaluateTokens(tokens, dummyValues) !== null
}

export function evaluateFrameworkFormula(formula: string, values: Record<string, unknown>): number | null {
  if (typeof formula !== "string" || !formula.trim()) return null
  const tokens = tokenizeFormula(formula)
  if (!tokens) return null
  return evaluateTokens(tokens, values)
}

export function parseFrameworkConfig(frameworkId: string, raw: Record<string, unknown>): FrameworkConfig {
  const fields: FrameworkField[] = Array.isArray(raw.fields)
    ? raw.fields
        .filter((f): f is Record<string, unknown> => Boolean(f && typeof f === "object"))
        .map(f => ({
          key: String(f.key ?? ""),
          label: String(f.label ?? f.key ?? ""),
          type: String(f.type ?? "number"),
          uiType: typeof f.ui_type === "string" ? f.ui_type : typeof f.uiType === "string" ? f.uiType : undefined,
          ui_type: typeof f.ui_type === "string" ? f.ui_type : typeof f.uiType === "string" ? f.uiType : undefined,
          min: typeof f.min === "number" ? f.min : undefined,
          max: typeof f.max === "number" ? f.max : undefined,
          weight: typeof f.weight === "number" ? f.weight : 1,
          helpText: typeof f.help_text === "string" ? f.help_text : typeof f.helpText === "string" ? f.helpText : undefined,
          help_text: typeof f.help_text === "string" ? f.help_text : typeof f.helpText === "string" ? f.helpText : undefined,
          description: typeof f.description === "string" ? f.description : undefined,
          options: isFrameworkFieldOptions(f.options) ? f.options : undefined,
        }))
    : []

  const rawThresholds = Array.isArray(raw.badge_thresholds)
    ? raw.badge_thresholds
    : Array.isArray(raw.badgeThresholds)
      ? raw.badgeThresholds
      : []

  const badgeThresholds: BadgeThreshold[] = rawThresholds
    .filter((b): b is Record<string, unknown> => Boolean(b && typeof b === "object"))
    .map(b => ({
      min: Number(b.min ?? 0),
      label: String(b.label ?? ""),
      color: String(b.color ?? "bg-secondary"),
    }))

  return {
    id: frameworkId,
    name: String(raw.name ?? frameworkId),
    version: String(raw.version ?? "1.0.0"),
    archetype: String(raw.archetype ?? "formula"),
    source: (raw.source === "user" || raw.source === "imported" ? raw.source : "built-in"),
    description: typeof raw.description === "string" ? raw.description : undefined,
    formula: typeof raw.formula === "string" ? raw.formula : undefined,
    badgeThresholds,
    fields,
  }
}

export function frameworkConfigToRaw(config: FrameworkConfig): Record<string, unknown> {
  return {
    name: config.name,
    version: config.version,
    archetype: config.archetype,
    ...(config.description ? { description: config.description } : {}),
    ...(config.formula ? { formula: config.formula } : {}),
    ...(config.badgeThresholds.length > 0 ? { badge_thresholds: config.badgeThresholds } : {}),
    fields: config.fields.map(field => ({
      key: field.key,
      label: field.label,
      type: field.type,
      ...(field.uiType ?? field.ui_type ? { ui_type: field.uiType ?? field.ui_type } : {}),
      ...(field.min !== undefined ? { min: field.min } : {}),
      ...(field.max !== undefined ? { max: field.max } : {}),
      ...(field.weight !== undefined ? { weight: field.weight } : {}),
      ...(field.helpText ?? field.help_text ? { help_text: field.helpText ?? field.help_text } : {}),
      ...(field.description ? { description: field.description } : {}),
      ...(field.options ? { options: field.options } : {}),
    })),
  }
}

export function mergeFrameworkConfig(base: FrameworkConfig, overrides: FrameworkOverrides | null): FrameworkConfig {
  if (!overrides) return base
  return {
    ...base,
    ...(overrides.name ? { name: overrides.name } : {}),
    ...(overrides.description !== undefined ? { description: overrides.description } : {}),
    ...(overrides.formula !== undefined ? { formula: overrides.formula } : {}),
    ...(overrides.badgeThresholds ? { badgeThresholds: overrides.badgeThresholds } : {}),
    fields: base.fields.map(field => {
      const ov = overrides.fields?.[field.key]
      if (!ov) return field
      return {
        ...field,
        ...ov,
        help_text: ov.helpText ?? field.help_text,
      }
    }),
  }
}

export function validateFrameworkScoring(
  config: { formula?: string | undefined; fields?: ReadonlyArray<{ key: string }> | undefined },
): string[] | null {
  const errors: string[] = []
  if (config.formula !== undefined && config.formula !== "") {
    if (!isFrameworkFormulaSupported(config.formula)) {
      errors.push("Formula contains unsupported syntax or invalid arithmetic")
    }
  }
  return errors.length > 0 ? errors : null
}

export function validateFrameworkConfig(config: Partial<FrameworkConfig>): string[] | null {
  const errors: string[] = []
  if (!config || typeof config !== "object") return ["Framework config must be an object"]
  if (typeof config.id !== "string" || !config.id.trim()) errors.push("Framework id is required")
  if (typeof config.name !== "string" || !config.name.trim()) errors.push("Framework name is required")
  if (typeof config.archetype !== "string" || !config.archetype.trim()) errors.push("Framework archetype is required")
  if (!Array.isArray(config.fields)) errors.push("Framework fields must be an array")
  const scoringErrors = validateFrameworkScoring(config)
  if (scoringErrors) errors.push(...scoringErrors)
  return errors.length > 0 ? errors : null
}

export function validateFrameworkOverrides(
  overrides: unknown,
  fieldKeys?: readonly string[],
  options?: { preserveLegacyFormula?: boolean },
): string[] | null {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return ["Framework overrides must be an object"]
  }
  const ov = overrides as FrameworkOverrides
  const errors: string[] = []
  if (ov.formula !== undefined && ov.formula !== "" && !options?.preserveLegacyFormula) {
    if (!isFrameworkFormulaSupported(ov.formula)) {
      errors.push("Invalid framework formula")
    }
  }
  if (ov.fields && typeof ov.fields === "object") {
    const allowed = fieldKeys ? new Set(fieldKeys) : null
    for (const [key, value] of Object.entries(ov.fields)) {
      if (allowed && !allowed.has(key)) errors.push(`Unknown field override: ${key}`)
      if (!value || typeof value !== "object") errors.push(`Field override ${key} must be an object`)
    }
  }
  return errors.length > 0 ? errors : null
}
