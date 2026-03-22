#!/usr/bin/env node
/**
 * generate-llms.mjs — Build-time llms.txt and llms-full.txt generator
 *
 * Aggregates project context from multiple sources and generates
 * token-optimized context files for AI agents and LLM tools.
 *
 * @domain integrations
 * @bounded-context context-aggregation
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { parse } from "yaml"

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..")
const PUBLIC = resolve(dirname(new URL(import.meta.url).pathname), "../public")

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readOptional(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : null
  } catch {
    return null
  }
}

/** Strip mermaid diagrams, code fences > 10 lines, and HTML to save tokens */
function tokenOptimize(md) {
  if (!md) return ""
  return md
    .replace(/```mermaid[\s\S]*?```/g, "[mermaid diagram removed]")
    .replace(/```[\s\S]{500,}?```/g, "[large code block removed]")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

// ─── Read sources ─────────────────────────────────────────────────────────────

const projectMd = readOptional(resolve(ROOT, ".planning/PROJECT.md"))
const agentsMd = readOptional(resolve(ROOT, "AGENTS.md"))
const docsMd = readOptional(resolve(ROOT, "meitheal-hub/DOCS.md"))
const openapiPath = resolve(PUBLIC, "openapi.yaml")

// ─── Generate OpenAPI summary ─────────────────────────────────────────────────

let apiSummary = ""
if (existsSync(openapiPath)) {
  try {
    const spec = parse(readFileSync(openapiPath, "utf-8"))
    const lines = [`## API Endpoints (${spec.info?.version ?? "unknown"})`, ""]

    if (spec.paths) {
      const tagGroups = {}
      for (const [path, methods] of Object.entries(spec.paths)) {
        for (const [method, op] of Object.entries(methods)) {
          const tag = op.tags?.[0] ?? "Other"
          if (!tagGroups[tag]) tagGroups[tag] = []
          tagGroups[tag].push(
            `- \`${method.toUpperCase()} ${path}\` — ${op.operationId}: ${op.summary ?? ""}`
          )
        }
      }
      for (const [tag, endpoints] of Object.entries(tagGroups).sort()) {
        lines.push(`### ${tag}`)
        lines.push(...endpoints)
        lines.push("")
      }
    }

    if (spec.webhooks) {
      lines.push("### Webhook Events")
      for (const [event, methods] of Object.entries(spec.webhooks)) {
        const op = methods.post ?? Object.values(methods)[0]
        lines.push(`- \`${event}\` — ${op?.summary ?? ""}`)
      }
      lines.push("")
    }

    apiSummary = lines.join("\n")
  } catch (err) {
    apiSummary = `## API Endpoints\n\n[OpenAPI parsing failed: ${err.message}]\n`
  }
}

// ─── Build llms-full.txt ──────────────────────────────────────────────────────

const fullParts = [
  "# Meitheal — Full System Context for AI Agents",
  "",
  `> Generated: ${new Date().toISOString()}`,
  "> This file is auto-generated at build time. Do not edit manually.",
  "",
]

if (projectMd) {
  fullParts.push("---", "## Project Overview", "", tokenOptimize(projectMd), "")
}

if (agentsMd) {
  fullParts.push("---", "## Agent Guidelines (AGENTS.md)", "", tokenOptimize(agentsMd), "")
}

if (docsMd) {
  fullParts.push("---", "## Documentation", "", tokenOptimize(docsMd), "")
}

if (apiSummary) {
  fullParts.push("---", apiSummary)
}

fullParts.push(
  "---",
  "## Key Integration Points",
  "",
  "- **MCP Endpoint**: POST `/api/mcp` — JSON-RPC 2.0 server for AI tool calling",
  "- **A2A Agent Card**: GET `/api/a2a/agent-card` — Agent-to-Agent discovery",
  "- **SSE Stream**: GET `/api/sse` — Real-time event subscription",
  "- **Webhooks**: Configure via POST `/api/settings` with keys: webhook_endpoint, n8n_webhook_url",
  "- **HA Event Bus**: Events fired as meitheal_task_* on the Home Assistant event bus",
  "- **OpenAPI Spec**: GET `/openapi.yaml` — Full API specification",
  "- **AI Plugin**: GET `/.well-known/ai-plugin.json` — AI plugin manifest",
  "",
  "## Ubiquitous Language",
  "",
  "| Term | Meaning |",
  "|------|---------|",
  "| Area | Top-level organizational container (WHERE) |",
  "| Goal | Desired outcome with optional metrics (WHAT) |",
  "| Project | Container for tasks within an area |",
  "| Task | Individual action item with lifecycle |",
  "| Pillar | Identity anchor — permanent WHY layer |",
  "| Routine | Repeating habit template |",
  "| task_kind | Behavioral variant: standard_action, shopping_item, checklist, routine_instance |",
  "| Lens | Strategic framework (RICE scoring, etc.) |",
  ""
)

const fullContent = fullParts.join("\n")

// ─── Build llms.txt (router) ─────────────────────────────────────────────────

const routerContent = `# Meitheal

> Home Assistant-native household and homelab execution hub

## Documentation

- [Full System Context](/llms-full.txt) — Complete AI agent context
- [OpenAPI Specification](/openapi.yaml) — ${apiSummary ? "120+ operations" : "API spec"}
- [AI Plugin Manifest](/.well-known/ai-plugin.json) — Plugin discovery
- [MCP Protocol](/api/mcp) — JSON-RPC 2.0 for AI tool calling
- [A2A Agent Card](/api/a2a/agent-card) — Agent-to-Agent discovery
- [SSE Events](/api/sse) — Real-time event stream

## Core Facts

- Local-first SQLite — no cloud dependency
- Runs as Home Assistant add-on or standalone Docker
- Dual-licensed: AGPL-3.0 (source) + Commercial
- Hierarchy: Area → Goal → Project → Task → Routine
- Pillars: Identity anchors (the WHY layer)
- 120+ API operations with AI-optimized descriptions
- 6 webhook events for n8n/Node-RED automation
- MCP + A2A protocol support for autonomous agents

## Quick Start for Agents

1. GET /api/health — verify service is running
2. POST /api/mcp — use tools/list to discover available tools
3. POST /api/mcp — use tools/call to execute actions
`

// ─── Write output ─────────────────────────────────────────────────────────────

mkdirSync(PUBLIC, { recursive: true })
writeFileSync(resolve(PUBLIC, "llms-full.txt"), fullContent, "utf-8")
writeFileSync(resolve(PUBLIC, "llms.txt"), routerContent, "utf-8")

console.log(`✅ Generated llms.txt → ${resolve(PUBLIC, "llms.txt")}`)
console.log(`✅ Generated llms-full.txt → ${resolve(PUBLIC, "llms-full.txt")}`)
console.log(`   llms.txt: ${routerContent.length} chars`)
console.log(`   llms-full.txt: ${fullContent.length} chars`)
