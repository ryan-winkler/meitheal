import { expect, test } from "@playwright/test"
import { resolveMcpSchema } from "../../apps/web/src/lib/mcp-schema"

test("MCP local references expand nested objects and arrays and reject unsafe references", () => {
  const document = { components: { schemas: {
    Rule: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    Rules: { type: "array", items: { $ref: "#/components/schemas/Rule" } },
    Cycle: { type: "object", properties: { next: { $ref: "#/components/schemas/Cycle" } } },
  } } }
  expect(resolveMcpSchema({ type: "object", properties: { rules: { $ref: "#/components/schemas/Rules" } } }, document))
    .toMatchObject({ properties: { rules: { items: { required: ["name"], properties: { name: { type: "string" } } } } } })
  for (const [reference, error] of [
    ["#/components/schemas/Missing", "Unknown"],
    ["#/components/schemas/Cycle", "Cyclic"],
    ["https://example.invalid/schema", "local"],
  ]) expect(() => resolveMcpSchema({ $ref: reference }, document)).toThrow(error)
  let deep: Record<string, unknown> = { type: "string" }
  for (let index = 0; index < 70; index++) deep = { items: deep }
  expect(() => resolveMcpSchema(deep, document)).toThrow("expansion limit")
})

