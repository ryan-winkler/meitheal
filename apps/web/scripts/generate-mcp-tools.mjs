#!/usr/bin/env node
/**
 * generate-mcp-tools.mjs — Build-time MCP tool catalog & route map precompiler
 *
 * Reads apps/web/public/openapi.yaml, expands all local $ref schemas for
 * non-excluded operations, and writes deterministic JSON to
 * apps/web/src/generated/mcp-tools.json so production /api/mcp never parses
 * openapi.yaml into V8 Old Space at runtime.
 *
 * @domain integration-core
 * @bounded-context agent-protocols
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OPENAPI_PATH = resolve(SCRIPT_DIR, "../public/openapi.yaml")
const OUTPUT_PATH = resolve(SCRIPT_DIR, "../src/generated/mcp-tools.json")

/** Must match EXCLUDED_OPS in apps/web/src/pages/api/mcp.ts */
export const EXCLUDED_OPS = new Set([
  "reviewTaskProposal", "acceptTaskProposal",
  "createRule", "replaceRules", "updateRule", "deleteRule", "restoreRuleDefaults",
  "createFramework", "updateFramework", "deleteFramework",
  "useLabelCleanup",
  "updateLabel", "deleteLabel",
  "taskInactivity",
  "mcpEndpoint",
  "healthPing",
  "getRuntimeDiagnostics",
  "subscribeSSE",
  "exportDatabase",
  "exportSettings",
  "importSettings",
  "setTaskDeferral",
  "readTaskPins", "verifyTaskPinContext", "setTaskPin",
  "findCommentPeople", "useMentionInbox",
  "readTaskDraft", "verifyTaskDraftContext", "writeTaskDraft",
])

/** Must match FRIENDLY_NAMES in apps/web/src/pages/api/mcp.ts */
export const FRIENDLY_NAMES = {
  searchMeitheal: "searchTasks",
  getHealth: "getSystemHealth",
}

/** Expand only local OpenAPI component schemas for standalone MCP tool inputs. */
export function resolveMcpSchema(schema, document) {
  let remaining = 10_000
  function expand(value, references, depth) {
    if (--remaining < 0 || depth > 64) throw new Error("MCP schema exceeds the expansion limit")
    if (Array.isArray(value)) return value.map(item => expand(item, references, depth + 1))
    if (!value || typeof value !== "object") return value
    if ("$ref" in value) {
      const reference = value.$ref
      if (typeof reference !== "string" || !reference.startsWith("#/components/schemas/")) {
        throw new Error("MCP schemas require local component schema references")
      }
      if (references.has(reference)) throw new Error(`Cyclic MCP schema reference: ${reference}`)
      let target = document
      for (const segment of reference.slice(2).split("/")) {
        const key = segment.replace(/~1/g, "/").replace(/~0/g, "~")
        if (!target || typeof target !== "object" || !Object.hasOwn(target, key)) {
          throw new Error(`Unknown MCP schema reference: ${reference}`)
        }
        target = target[key]
      }
      if (!target || typeof target !== "object" || Array.isArray(target)) {
        throw new Error(`Invalid MCP schema reference: ${reference}`)
      }
      const nextReferences = new Set(references).add(reference)
      const { $ref: _reference, ...siblings } = value
      return {
        ...expand(target, nextReferences, depth + 1),
        ...expand(siblings, references, depth + 1),
      }
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child, references, depth + 1)]))
  }
  return expand(schema, new Set(), 0)
}

export function buildMcpCatalogFromYaml(specContent) {
  const spec = parse(specContent)
  const tools = []
  const routes = {}

  if (!spec?.paths) return { tools, routes }

  for (const [path, methods] of Object.entries(spec.paths)) {
    if (path === "/api/feedback" || path.startsWith("/api/feedback/")) continue
    for (const [method, op] of Object.entries(methods)) {
      if (!op?.operationId || EXCLUDED_OPS.has(op.operationId)) continue

      const toolName = FRIENDLY_NAMES[op.operationId] ?? op.operationId
      const properties = {}
      const required = []
      const pathParams = []
      const queryParams = []

      if (op.parameters) {
        for (const param of op.parameters) {
          if (param.in === "header") continue
          const paramSchema = resolveMcpSchema(param.schema ?? { type: "string" }, spec)
          properties[param.name] = {
            ...paramSchema,
            description: param.description ?? `${param.name} parameter`,
          }
          if (param.required) required.push(param.name)
          if (param.in === "path") pathParams.push(param.name)
          if (param.in === "query") queryParams.push(param.name)
        }
      }

      const hasBody = method === "post" || method === "put" || method === "patch"
      if (hasBody && op.requestBody?.content?.["application/json"]?.schema) {
        const bodySchema = resolveMcpSchema(op.requestBody.content["application/json"].schema, spec)
        if (bodySchema.properties) {
          for (const [propName, propSchema] of Object.entries(bodySchema.properties)) {
            properties[propName] = propSchema
          }
          if (bodySchema.required && Array.isArray(bodySchema.required)) {
            for (const r of bodySchema.required) {
              if (!required.includes(r)) required.push(r)
            }
          }
        }
      }

      if (toolName === "searchTasks") {
        properties.scope = { type: "string", enum: ["tasks"], default: "tasks" }
      }

      tools.push({
        name: toolName,
        description: op.description ?? op.summary ?? `${method.toUpperCase()} ${path}`,
        inputSchema: {
          type: "object",
          properties,
          ...(required.length > 0 ? { required } : {}),
        },
      })

      routes[toolName] = {
        method: method.toUpperCase(),
        path,
        hasBody,
        pathParams,
        queryParams,
      }
    }
  }

  return { tools, routes }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const specContent = readFileSync(OPENAPI_PATH, "utf-8")
  const catalog = buildMcpCatalogFromYaml(specContent)
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(catalog, null, 2)}\n`, "utf-8")
  console.log(`[generate-mcp] Wrote ${catalog.tools.length} tools to ${OUTPUT_PATH}`)
}
