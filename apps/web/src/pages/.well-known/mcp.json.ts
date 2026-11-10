import type { APIRoute } from "astro"
import { apiJson } from "@lib/api-response"
import { checkMcpAvailability } from "@lib/mcp-availability"
import { MCP_LEGACY_VERSION, MCP_SUPPORTED_VERSIONS } from "@lib/mcp-versions"

export const GET: APIRoute = async ({ locals }) => {
  const unavailable = await checkMcpAvailability()
  if (unavailable) return unavailable

  const response = apiJson({
    name: "meitheal",
    description: "Scoped automation for the installed Meitheal App",
    protocol: "mcp",
    protocolVersion: MCP_LEGACY_VERSION,
    supportedVersions: MCP_SUPPORTED_VERSIONS,
    transport: "streamable-http",
    endpoint: `${locals.ingressPath ?? ""}/api/mcp`,
    authentication: { type: "bearer", requiredScope: "mcp:execute" },
    discovery: "Use server/discover on current clients or initialize on legacy clients, then call tools/list with your token.",
  })
  response.headers.set("Cache-Control", "no-store")
  return response
}
