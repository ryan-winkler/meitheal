/** Evaluate the arithmetic supported by framework formulas without dynamic code. */
function parseFormula(formula: string, values: Record<string, unknown>, syntaxOnly = false): number | null {
  if (typeof formula !== "string" || formula.length > 4096) return null
  const tokens = formula.match(/[a-z_][a-z_0-9]*|(?:\d+(?:\.\d*)?|\.\d+)|[()+*/-]|\S/gi) ?? []
  if (tokens.length > 512) return null
  let cursor = 0

  function primary(): number {
    const token = tokens[cursor++]
    if (token === "+" || token === "-") return (token === "-" ? -1 : 1) * primary()
    if (token === "(") {
      const result = expression()
      if (tokens[cursor++] !== ")") throw new Error("Unclosed formula")
      return result
    }
    if (!token) throw new Error("Missing formula value")
    if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) return Number(token)
    if (!/^[a-z_][a-z_0-9]*$/i.test(token)) throw new Error("Invalid formula")
    const value = values[token]
    if (typeof value === "boolean") return Number(value)
    if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") {
      throw new Error("Missing field")
    }
    const number = Number(value)
    if (!Number.isFinite(number)) throw new Error("Invalid field")
    return number
  }

  function product(): number {
    let result = primary()
    while (tokens[cursor] === "*" || tokens[cursor] === "/") {
      const operator = tokens[cursor++]
      const right = primary()
      result = operator === "*" ? result * right : result / right
    }
    return result
  }

  function expression(): number {
    let result = product()
    while (tokens[cursor] === "+" || tokens[cursor] === "-") {
      const operator = tokens[cursor++]
      const right = product()
      result = operator === "+" ? result + right : result - right
    }
    return result
  }

  try {
    const score = expression()
    return cursor === tokens.length && (syntaxOnly || Number.isFinite(score)) ? syntaxOnly ? 0 : Math.round(score) : null
  } catch {
    return null
  }
}

export function evaluateFrameworkFormula(formula: string, values: Record<string, unknown>): number | null {
  return parseFormula(formula, values)
}

export function isFrameworkFormulaSupported(formula: string, fields: readonly string[]): boolean {
  return parseFormula(formula, Object.fromEntries(fields.map(key => [key, 1])), true) !== null
}
