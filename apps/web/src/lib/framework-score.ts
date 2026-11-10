/** Parse the bounded arithmetic grammar without dynamic code. */
function parseFrameworkFormula(formula: string, fieldValue: (key: string) => number): number {
  const tokens = formula.match(/[a-z_][a-z_0-9]*|(?:\d+(?:\.\d*)?|\.\d+)|[()+*/-]|\S/gi) ?? []
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
    return fieldValue(token)
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

  const score = expression()
  if (cursor !== tokens.length) throw new Error("Unsupported formula")
  return score
}

/** Identify unsupported syntax and references independently of the entered estimates. */
export function isFrameworkFormulaSupported(formula: string, fieldKeys: string[]): boolean {
  try {
    parseFrameworkFormula(formula, key => {
      if (!fieldKeys.includes(key)) throw new Error("Unknown field")
      return 1
    })
    return true
  } catch {
    return false
  }
}

/** Evaluate the arithmetic supported by framework formulas without dynamic code. */
export function evaluateFrameworkFormula(formula: string, values: Record<string, unknown>): number | null {
  try {
    const score = parseFrameworkFormula(formula, key => {
      const value = values[key]
      if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") {
        throw new Error("Missing field")
      }
      const number = Number(value)
      if (!Number.isFinite(number)) throw new Error("Invalid field")
      return number
    })
    return Number.isFinite(score) ? Math.round(score) : null
  } catch {
    return null
  }
}
