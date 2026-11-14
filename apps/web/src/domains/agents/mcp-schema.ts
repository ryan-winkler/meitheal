/** Expand only local OpenAPI component schemas for standalone MCP tool inputs. */
export function resolveMcpSchema(schema: Record<string, unknown>, document: unknown): Record<string, unknown> {
  let remaining = 10_000
  function expand(value: unknown, references: Set<string>, depth: number): unknown {
    if (--remaining < 0 || depth > 64) throw new Error("MCP schema exceeds the expansion limit")
    if (Array.isArray(value)) return value.map(item => expand(item, references, depth + 1))
    if (!value || typeof value !== "object") return value
    const source = value as Record<string, unknown>
    if ("$ref" in source) {
      const reference = source.$ref
      if (typeof reference !== "string" || !reference.startsWith("#/components/schemas/")) {
        throw new Error("MCP schemas require local component schema references")
      }
      if (references.has(reference)) throw new Error(`Cyclic MCP schema reference: ${reference}`)
      let target: unknown = document
      for (const segment of reference.slice(2).split("/")) {
        const key = segment.replace(/~1/g, "/").replace(/~0/g, "~")
        if (!target || typeof target !== "object" || !Object.hasOwn(target, key)) {
          throw new Error(`Unknown MCP schema reference: ${reference}`)
        }
        target = (target as Record<string, unknown>)[key]
      }
      if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error(`Invalid MCP schema reference: ${reference}`)
      const nextReferences = new Set(references).add(reference)
      const { $ref: _reference, ...siblings } = source
      return {
        ...expand(target, nextReferences, depth + 1) as Record<string, unknown>,
        ...expand(siblings, references, depth + 1) as Record<string, unknown>,
      }
    }
    return Object.fromEntries(Object.entries(source).map(([key, child]) => [key, expand(child, references, depth + 1)]))
  }
  return expand(schema, new Set(), 0) as Record<string, unknown>
}
