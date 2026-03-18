/**
 * Framework Extensibility — Domain Tests
 *
 * Tests framework validation, round-trip conversion, merge logic,
 * preset references, and new framework archetypes.
 *
 * @domain strategy
 */
import { expect, test } from "@playwright/test"
import {
  validateFrameworkConfig,
  frameworkConfigToRaw,
  parseFrameworkConfig,
  mergeFrameworkConfig,
  PRESETS,
  resolveRulesForTask,
  createTaskRule,
} from "@meitheal/domain-strategy"
import type { FrameworkConfig, FrameworkOverrides, TaskRule } from "@meitheal/domain-strategy"

// ─── Test Data ──────────────────────────────────────────────────────

const validFormulaConfig: Partial<FrameworkConfig> = {
  id: "test-formula",
  name: "Test Formula Framework",
  version: "1.0.0",
  archetype: "formula",
  source: "user",
  formula: "(reach * impact) / effort",
  badgeThresholds: [
    { min: 0, label: "Low", color: "bg-secondary" },
    { min: 50, label: "Medium", color: "bg-warning" },
    { min: 100, label: "High", color: "bg-success" },
  ],
  fields: [
    { key: "reach", label: "Reach", type: "number", uiType: "slider", weight: 1, min: 1, max: 100, helpText: "Reach score" },
    { key: "impact", label: "Impact", type: "number", uiType: "slider", weight: 1, min: 1, max: 10, helpText: "Impact score" },
    { key: "effort", label: "Effort", type: "number", uiType: "slider", weight: 1, min: 1, max: 10, helpText: "Effort estimate" },
  ],
}

const validTaxonomyConfig: Partial<FrameworkConfig> = {
  id: "test-taxonomy",
  name: "Test Taxonomy",
  version: "1.0.0",
  archetype: "taxonomy",
  source: "user",
  badgeThresholds: [
    { min: 0, label: "C", color: "bg-secondary" },
    { min: 1, label: "B", color: "bg-warning" },
    { min: 2, label: "A", color: "bg-success" },
  ],
  fields: [
    { key: "category", label: "Category", type: "select", uiType: "select", weight: 1, helpText: "Classification" },
  ],
}

// ─── Validation ─────────────────────────────────────────────────────

test("validateFrameworkConfig: accepts valid formula config", () => {
  const errors = validateFrameworkConfig(validFormulaConfig)
  expect(errors).toBeNull()
})

test("validateFrameworkConfig: accepts valid taxonomy config", () => {
  const errors = validateFrameworkConfig(validTaxonomyConfig)
  expect(errors).toBeNull()
})

test("validateFrameworkConfig: rejects missing id", () => {
  const { id: _, ...withoutId } = validFormulaConfig
  const errors = validateFrameworkConfig(withoutId)
  expect(errors).not.toBeNull()
  expect(errors).toContain("id is required and must be a non-empty string")
})

test("validateFrameworkConfig: rejects invalid id format", () => {
  const errors = validateFrameworkConfig({ ...validFormulaConfig, id: "Test Framework!" })
  expect(errors).not.toBeNull()
  expect(errors).toContain("id must be lowercase alphanumeric with hyphens only")
})

test("validateFrameworkConfig: rejects missing name", () => {
  const errors = validateFrameworkConfig({ ...validFormulaConfig, name: "" })
  expect(errors).not.toBeNull()
  expect(errors).toContain("name is required")
})

test("validateFrameworkConfig: rejects invalid archetype", () => {
  const errors = validateFrameworkConfig({ ...validFormulaConfig, archetype: "invalid" as never })
  expect(errors).not.toBeNull()
  expect(errors![0]).toContain("archetype must be one of")
})

test("validateFrameworkConfig: rejects empty fields array", () => {
  const errors = validateFrameworkConfig({ ...validFormulaConfig, fields: [] })
  expect(errors).not.toBeNull()
  expect(errors).toContain("At least one field is required")
})

test("validateFrameworkConfig: rejects duplicate field keys", () => {
  const errors = validateFrameworkConfig({
    ...validFormulaConfig,
    fields: [
      { key: "dup", label: "First", type: "number", uiType: "slider", weight: 1, helpText: "" },
      { key: "dup", label: "Second", type: "number", uiType: "slider", weight: 1, helpText: "" },
    ],
  })
  expect(errors).not.toBeNull()
  expect(errors).toContain("Duplicate field key: dup")
})

test("validateFrameworkConfig: formula archetype requires formula", () => {
  const errors = validateFrameworkConfig({ ...validFormulaConfig, formula: undefined })
  expect(errors).not.toBeNull()
  expect(errors).toContain("Formula archetypes require a formula expression")
})

test("validateFrameworkConfig: taxonomy archetype does not require formula", () => {
  const errors = validateFrameworkConfig(validTaxonomyConfig)
  expect(errors).toBeNull()
})

// ─── Round-Trip Conversion ──────────────────────────────────────────

test("frameworkConfigToRaw converts FrameworkConfig to YAML-compatible object", () => {
  const full = validFormulaConfig as FrameworkConfig
  const raw = frameworkConfigToRaw(full)

  expect(raw.name).toBe("Test Formula Framework")
  expect(raw.version).toBe("1.0.0")
  expect(raw.archetype).toBe("formula")
  expect(raw.formula).toBe("(reach * impact) / effort")
  expect(Array.isArray(raw.badge_thresholds)).toBe(true)
  expect(Array.isArray(raw.fields)).toBe(true)

  // Check field key mapping
  const fields = raw.fields as Array<Record<string, unknown>>
  expect(fields.length).toBeGreaterThan(0)
  expect(fields[0]!.key).toBe("reach")
  expect(fields[0]!.ui_type).toBe("slider")
  expect(fields[0]!.help_text).toBe("Reach score")
})

test("parseFrameworkConfig → frameworkConfigToRaw round-trip preserves data", () => {
  const rawYaml = {
    name: "Round Trip Test",
    version: "2.0.0",
    archetype: "formula",
    formula: "a + b",
    badge_thresholds: [
      { min: 0, label: "Low", color: "bg-muted" },
    ],
    fields: [
      { key: "a", label: "Alpha", type: "number", ui_type: "slider", weight: 2, min: 0, max: 10, help_text: "Alpha value" },
      { key: "b", label: "Beta", type: "number", ui_type: "slider", weight: 1, min: 0, max: 5, help_text: "Beta value" },
    ],
  }

  const parsed = parseFrameworkConfig("roundtrip", rawYaml)
  const exported = frameworkConfigToRaw(parsed)

  expect(exported.name).toBe(rawYaml.name)
  expect(exported.version).toBe(rawYaml.version)
  expect(exported.archetype).toBe(rawYaml.archetype)
  expect(exported.formula).toBe(rawYaml.formula)
  expect((exported.badge_thresholds as unknown[]).length).toBeGreaterThan(0)
  expect((exported.badge_thresholds as Array<{ min: number }>)[0]!.min).toBe(0)
  expect((exported.fields as unknown[]).length).toBeGreaterThan(0)
  expect((exported.fields as Array<{ key: string }>)[0]!.key).toBe("a")
  expect((exported.fields as Array<{ help_text: string }>)[0]!.help_text).toBe("Alpha value")
})

// ─── Merge Logic ────────────────────────────────────────────────────

test("mergeFrameworkConfig with null overrides returns base unchanged", () => {
  const base = validFormulaConfig as FrameworkConfig
  const merged = mergeFrameworkConfig(base, null)
  expect(merged).toEqual(base)
})

test("mergeFrameworkConfig applies field-level weight override", () => {
  const base = validFormulaConfig as FrameworkConfig
  const overrides: FrameworkOverrides = {
    fields: { reach: { weight: 5 } },
  }
  const merged = mergeFrameworkConfig(base, overrides)

  const reachField = merged.fields.find(f => f.key === "reach")
  expect(reachField?.weight).toBe(5)
  // Other fields unchanged
  const impactField = merged.fields.find(f => f.key === "impact")
  expect(impactField?.weight).toBe(1)
})

test("mergeFrameworkConfig overrides badge thresholds entirely", () => {
  const base = validFormulaConfig as FrameworkConfig
  const overrides: FrameworkOverrides = {
    badgeThresholds: [
      { min: 0, label: "None", color: "bg-muted" },
      { min: 200, label: "Max", color: "bg-primary" },
    ],
  }
  const merged = mergeFrameworkConfig(base, overrides)
  expect(merged.badgeThresholds).toHaveLength(2)
  expect(merged.badgeThresholds[1]!.label).toBe("Max")
})

test("mergeFrameworkConfig overrides formula", () => {
  const base = validFormulaConfig as FrameworkConfig
  const overrides: FrameworkOverrides = { formula: "custom_formula()" }
  const merged = mergeFrameworkConfig(base, overrides)
  expect(merged.formula).toBe("custom_formula()")
})

// ─── Preset Resolution with New Frameworks ──────────────────────────

test("PRESETS contains all 5 preset IDs", () => {
  const ids = Object.keys(PRESETS)
  expect(ids).toContain("strategic")
  expect(ids).toContain("ux-focused")
  expect(ids).toContain("agile-delivery")
  expect(ids).toContain("balanced")
  expect(ids).toContain("simple")
  expect(ids).toHaveLength(5)
})

test("agile-delivery preset references wsjf and ice frameworks", () => {
  const preset = PRESETS["agile-delivery"]
  const allLensIds = preset.rules.flatMap(r => r.lensIds)
  expect(allLensIds).toContain("wsjf")
  expect(allLensIds).toContain("ice")
  expect(allLensIds).toContain("ddd")
  expect(allLensIds).toContain("kcs")
})

test("balanced preset references moscow and rice frameworks", () => {
  const preset = PRESETS.balanced
  const allLensIds = preset.rules.flatMap(r => r.lensIds)
  expect(allLensIds).toContain("moscow")
  expect(allLensIds).toContain("rice")
  expect(allLensIds).toContain("ddd")
  expect(allLensIds).toContain("kcs")
})

test("simple preset has no rules", () => {
  expect(PRESETS.simple.rules).toHaveLength(0)
})

test("agile-delivery epic rule allows canChangePriority", () => {
  const epicRule = PRESETS["agile-delivery"].rules.find(r => r.taskTypes.includes("epic"))
  expect(epicRule?.aiScope.canChangePriority).toBe(true)
})

// ─── Preset Rules Resolve Correctly ─────────────────────────────────

test("agile-delivery rules resolve WSJF lens for epic", () => {
  const rules: TaskRule[] = PRESETS["agile-delivery"].rules.map(r =>
    createTaskRule({ ...r, ruleType: r.ruleType ?? "strategic-lens" }),
  )
  const match = resolveRulesForTask("epic", [], rules)
  expect(match.applicableLensIds).toContain("wsjf")
  expect(match.applicableLensIds).toContain("ddd")
})

test("agile-delivery rules resolve ICE lens for story", () => {
  const rules: TaskRule[] = PRESETS["agile-delivery"].rules.map(r =>
    createTaskRule({ ...r, ruleType: r.ruleType ?? "strategic-lens" }),
  )
  const match = resolveRulesForTask("story", [], rules)
  expect(match.applicableLensIds).toContain("ice")
  expect(match.applicableLensIds).toContain("kcs")
})

test("balanced rules resolve MoSCoW lens for epic", () => {
  const rules: TaskRule[] = PRESETS.balanced.rules.map(r =>
    createTaskRule({ ...r, ruleType: r.ruleType ?? "strategic-lens" }),
  )
  const match = resolveRulesForTask("epic", [], rules)
  expect(match.applicableLensIds).toContain("moscow")
})

test("balanced rules resolve RICE lens for story", () => {
  const rules: TaskRule[] = PRESETS.balanced.rules.map(r =>
    createTaskRule({ ...r, ruleType: r.ruleType ?? "strategic-lens" }),
  )
  const match = resolveRulesForTask("story", [], rules)
  expect(match.applicableLensIds).toContain("rice")
})
