/** Evaluate the arithmetic supported by framework formulas without dynamic code. */
export function evaluateFrameworkFormula(formula: string, values: Record<string, unknown>): number | null {
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
    const value = values[token]
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
    return cursor === tokens.length && Number.isFinite(score) ? Math.round(score) : null
  } catch {
    return null
  }
}
