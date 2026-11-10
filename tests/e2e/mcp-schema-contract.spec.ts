import { expect, test } from "@playwright/test"
import { resolveMcpSchema } from "../../apps/web/src/lib/mcp-schema"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.214" } })

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

test("MCP discovery exposes usable canonical create and nested rule schemas and executes creation", async ({ request }) => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL for local MCP integration checks")
  const setting = await request.put("/api/settings", {
    headers: { "x-hass-is-admin": "true", "x-hass-user-id": "mcp-schema-regression" },
    data: { key: "agent-protocols-mcp-enabled", value: true },
  })
  expect(setting.ok()).toBe(true)
  const listed = await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: "schemas", method: "tools/list" } })
  expect(listed.ok(), await listed.text()).toBe(true)
  const { result } = await listed.json()
  const create = result.tools.find((tool: { name: string }) => tool.name === "createTask")
  expect(create.inputSchema.required).toContain("title")
  expect(create.inputSchema.properties).toMatchObject({
    title: { type: "string" }, description: { type: "string" }, priority: { type: "integer", minimum: 1, maximum: 5 },
    due_date: { type: "string" }, custom_fields: { type: "string" },
  })
  const replace = result.tools.find((tool: { name: string }) => tool.name === "replaceRules")
  expect(replace.inputSchema.properties.rules.items).toMatchObject({
    required: ["name"], properties: { name: { type: "string" }, taskTypes: { type: "array", items: { type: "string" } } },
  })
  expect(JSON.stringify(result.tools)).not.toContain('"$ref"')

  const ruleName = `MCP nested rule execution ${crypto.randomUUID()}`
  const replaced = await request.post("/api/mcp", { data: {
    jsonrpc: "2.0", id: "rule-schema-fixture", method: "tools/call",
    params: { name: "replaceRules", arguments: { replaceIds: [], rules: [{ name: ruleName, taskTypes: ["task"], tags: ["mcp-schema-fixture"] }] } },
  } })
  const replacement = (await replaced.json()).result
  expect(replacement.isError).toBe(false)
  const rule = JSON.parse(replacement.content[0].text).data.find((entry: { name: string }) => entry.name === ruleName)
  try { expect(rule).toMatchObject({ name: ruleName, taskTypes: ["task"], tags: ["mcp-schema-fixture"] }) }
  finally { if (rule?.id) await request.delete(`/api/rules/${rule.id}`) }

  const created = await request.post("/api/mcp", { data: {
    jsonrpc: "2.0", id: "create-schema-fixture", method: "tools/call",
    params: { name: "createTask", arguments: { title: "MCP schema execution fixture", description: "Native creation", priority: 2, due_date: "2027-03-01", custom_fields: '{"source":"mcp-schema-regression"}' } },
  } })
  const body = await created.json()
  expect(body.result.isError).toBe(false)
  const task = JSON.parse(body.result.content[0].text)
  try {
    expect(task).toMatchObject({ description: "Native creation", priority: 2, due_date: "2027-03-01", custom_fields: '{"source":"mcp-schema-regression"}' })
    const saved = await request.get(`/api/tasks/${task.id}`)
    expect(await saved.json()).toMatchObject({ priority: 2, due_date: "2027-03-01" })
  } finally { if (task.id) await request.delete(`/api/tasks/${task.id}`) }
})
