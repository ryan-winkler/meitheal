import { expect, test } from "@playwright/test"
import fc from "fast-check"
import { evaluateFrameworkFormula, isFrameworkFormulaSupported } from "@meitheal/domain-strategy"

// Framework formulas are user-authored text that the server evaluates, so the
// parser is fuzzed: arbitrary input must never escape as an exception, and
// well-formed input must match a reference evaluation.

const FIELDS = ["impact", "effort", "reach", "confidence"] as const
type Field = typeof FIELDS[number]
type Values = Record<Field, number>

interface Expr {
  text: string
  value: (values: Values) => number
}

const literal: fc.Arbitrary<Expr> = fc.integer({ min: 0, max: 1000 }).map(n => ({ text: String(n), value: () => n }))
const field: fc.Arbitrary<Expr> = fc.constantFrom(...FIELDS).map(name => ({ text: name, value: (values: Values) => values[name] }))

const { expr } = fc.letrec<{ expr: Expr, leaf: Expr, binary: Expr, group: Expr, negate: Expr }>(tie => ({
  leaf: fc.oneof(literal, field),
  // Every binary node is parenthesised, so the reference needs no precedence rules.
  binary: fc.tuple(tie("expr"), fc.constantFrom("+", "-", "*", "/"), tie("expr")).map(([left, operator, right]) => ({
    text: `(${left.text} ${operator} ${right.text})`,
    value: (values: Values) => {
      const a = left.value(values)
      const b = right.value(values)
      if (operator === "+") return a + b
      if (operator === "-") return a - b
      if (operator === "*") return a * b
      return a / b
    },
  })),
  group: tie("expr").map(inner => ({ text: `(${inner.text})`, value: inner.value })),
  negate: tie("leaf").map(inner => ({ text: `-${inner.text}`, value: (values: Values) => -inner.value(values) })),
  expr: fc.oneof({ depthSize: "small", withCrossShrink: true }, tie("leaf"), tie("binary"), tie("group"), tie("negate")),
}))

const values: fc.Arbitrary<Values> = fc.record({
  impact: fc.integer({ min: 0, max: 100 }),
  effort: fc.integer({ min: 1, max: 100 }),
  reach: fc.integer({ min: 0, max: 10_000 }),
  confidence: fc.integer({ min: 0, max: 100 }),
})

const anyFieldValue = fc.oneof(fc.double(), fc.integer(), fc.string(), fc.boolean(), fc.constant(null), fc.constant(undefined), fc.object())

test("arbitrary formula text never throws and only returns an integer or null", () => {
  fc.assert(fc.property(
    fc.oneof(fc.string({ maxLength: 600 }), fc.string({ unit: fc.constantFrom(..."()+-*/. 0123456789impacteffort_"), maxLength: 600 })),
    fc.dictionary(fc.constantFrom(...FIELDS, "constructor", "__proto__", "toString"), anyFieldValue),
    (formula, fieldValues) => {
      const result = evaluateFrameworkFormula(formula, fieldValues)
      expect(result === null || Number.isInteger(result)).toBe(true)
      expect(typeof isFrameworkFormulaSupported(formula, Object.keys(fieldValues))).toBe("boolean")
    },
  ), { numRuns: 2_000 })
})

test("well-formed formulas match a reference evaluation", () => {
  fc.assert(fc.property(expr, values, (formula, input) => {
    const expected = formula.value(input)
    const actual = evaluateFrameworkFormula(formula.text, input)
    if (Number.isFinite(expected)) expect(actual).toBe(Math.round(expected))
    else expect(actual).toBeNull()
    expect(isFrameworkFormulaSupported(formula.text, [...FIELDS])).toBe(true)
  }), { numRuns: 1_000 })
})

test("deeply nested input is bounded rather than overflowing the stack", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 5_000 }), depth => {
    const formula = "(".repeat(depth) + "impact" + ")".repeat(depth)
    const result = evaluateFrameworkFormula(formula, { impact: 3 })
    expect(result === null || result === 3).toBe(true)
  }), { numRuns: 200 })
})
