import type { APIRoute } from "astro"
import { guardAgentProtocol } from "../../lib/agent-protocol-policy"
import { apiJson } from "../../lib/api-response"
import { getMcpToolCount } from "../api/mcp"

export const GET: APIRoute = async ({ locals }) => {
  const blocked = await guardAgentProtocol("mcp")
  if (blocked) return blocked
  const response = apiJson({
    name: "meitheal",
    version: process.env.MEITHEAL_VERSION ?? "unknown",
    protocol: "mcp",
    protocolVersion: "2025-03-26",
    endpoint: `${locals.ingressPath ?? ""}/api/mcp`,
    toolCount: getMcpToolCount(),
    capabilities: { tools: { listChanged: false } },
    authentication: {
      type: "optional-bearer",
      note: "Home Assistant ingress sessions use Supervisor authentication. Agent tokens, when supplied, require MCP and underlying operation scopes. Standalone access follows the configured deployment boundary.",
    },
  })
  response.headers.set("Cache-Control", "no-store")
  return response
}
