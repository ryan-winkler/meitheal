/** Round computed framework scores cleanly to at most two decimal places. */
export function roundFrameworkScore(score: number): number {
  if (!Number.isFinite(score) || Number.isInteger(score) || Math.abs(score) >= 1e12) return score
  return Math.round((score + Number.EPSILON) * 100) / 100
}

/** Evaluate the arithmetic supported by framework formulas without dynamic code. */
function parseFormula(
  formula: string,
  values: Record<string, unknown>,
  syntaxOnly = false,
  precision: "integer" | "decimal" = "integer",
): number | null {
  if (typeof formula !== "string" || formula.length > 4096) return null
  const lexemes = formula.match(/[a-z_][a-z_0-9]*|(?:\d+(?:\.\d*)?|\.\d+)|[()+*/-]|\S/gi) ?? []
  if (lexemes.length > 512) return null
  let cursor = 0

  function primary(): number {
    const lexeme = lexemes[cursor++]
    if (lexeme === "+" || lexeme === "-") return (lexeme === "-" ? -1 : 1) * primary()
    if (lexeme === "(") {
      const result = expression()
      if (lexemes[cursor++] !== ")") throw new Error("Unclosed formula")
      return result
    }
    if (!lexeme) throw new Error("Missing formula value")
    if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(lexeme)) return Number(lexeme)
    if (!/^[a-z_][a-z_0-9]*$/i.test(lexeme)) throw new Error("Invalid formula")
    const value = values[lexeme]
    if (typeof value === "boolean") return Number(value)
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Invalid field")
      return value
    }
    if (typeof value !== "string") throw new Error("Missing field")
    const trimmed = value.trim()
    if (!trimmed || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
      throw new Error("Invalid field")
    }
    const number = Number(trimmed)
    if (!Number.isFinite(number)) throw new Error("Invalid field")
    return number
  }

  function product(): number {
    let result = primary()
    while (lexemes[cursor] === "*" || lexemes[cursor] === "/") {
      const operator = lexemes[cursor++]
      const right = primary()
      result = operator === "*" ? result * right : result / right
    }
    return result
  }

  function expression(): number {
    let result = product()
    while (lexemes[cursor] === "+" || lexemes[cursor] === "-") {
      const operator = lexemes[cursor++]
      const right = product()
      result = operator === "+" ? result + right : result - right
    }
    return result
  }

  try {
    const score = expression()
    if (cursor !== lexemes.length || (!syntaxOnly && !Number.isFinite(score))) return null
    if (syntaxOnly) return 0
    return precision === "decimal" ? roundFrameworkScore(score) : Math.round(score)
  } catch {
    return null
  }
}

export function evaluateFrameworkFormula(formula: string, values: Record<string, unknown>): number | null {
  return parseFormula(formula, values, false, "integer")
}

export function evaluateFrameworkFormulaDecimal(formula: string, values: Record<string, unknown>): number | null {
  return parseFormula(formula, values, false, "decimal")
}

export function isFrameworkFormulaSupported(formula: string, fields: readonly string[]): boolean {
  return parseFormula(formula, Object.fromEntries(fields.map(key => [key, 1])), true) !== null
}
