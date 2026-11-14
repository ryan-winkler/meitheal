import { checkProtocolAvailability } from "./protocol-availability"

const SETTING = "agent-protocols-mcp-enabled"
const MCP_RESPONSE_HEADERS = { "Cache-Control": "no-store" }

export async function checkMcpAvailability(): Promise<Response | null> {
  return checkProtocolAvailability(SETTING, "MCP", MCP_RESPONSE_HEADERS)
}
