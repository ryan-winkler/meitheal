import type { InValue } from "@libsql/client"

export type SqlFragment = Readonly<{ sql: string; args: InValue[] }>
const fragments = new WeakSet<object>()

function fragment(text: string, args: InValue[]): SqlFragment {
  const result = { sql: text, args }
  fragments.add(result)
  return result
}

/** Source-owned SQL syntax only. Never pass request/provider text here. */
export function sourceSql(text: string, args: InValue[] = []): SqlFragment {
  return fragment(text, [...args])
}

/** Ordinary values bind; only fragments minted here can splice SQL syntax. */
export function sql(
  strings: TemplateStringsArray,
  ...values: (InValue | SqlFragment)[]
): SqlFragment {
  let text = strings[0]!
  const args: InValue[] = []
  for (let index = 0; index < values.length; index++) {
    const value = values[index]
    if (value !== null && typeof value === "object" && fragments.has(value)) {
      const part = value as SqlFragment
      text += part.sql
      args.push(...part.args)
    } else {
      text += "?"
      args.push(value as InValue)
    }
    text += strings[index + 1]!
  }
  return fragment(text, args)
}

export function joinSql(parts: readonly SqlFragment[], separator = ", "): SqlFragment {
  if (parts.some((part) => !fragments.has(part))) throw new Error("Untrusted SQL fragment")
  return fragment(
    parts.map((part) => part.sql).join(separator),
    parts.flatMap((part) => part.args)
  )
}
