/**
 * Agents Domain — Public Server API
 *
 * Centralizes MCP, WebMCP, and A2A protocol contracts and availability gates.
 * Browser bundles import client-safe contracts from `@domains/agents/webmcp-protocol`.
 */
export { A2A_RESPONSE_HEADERS, checkA2aAvailability } from "./a2a-availability"
export { getA2ALinkOrigin } from "./a2a-urls"
export { checkMcpAvailability } from "./mcp-availability"
export { resolveMcpSchema } from "./mcp-schema"
export { MCP_LEGACY_VERSION, MCP_PROTOCOL_VERSION, MCP_SUPPORTED_VERSIONS } from "./mcp-versions"
export { WEBMCP_SETTING, webMcpEnabled } from "./webmcp-protocol"
