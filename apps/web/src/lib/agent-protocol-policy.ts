import { isAgentProtocolEnabled } from "./agent-protocol-settings"
import { apiProblem } from "./api-response"

/** One server-side policy for protocol execution and discovery. */
export async function guardAgentProtocol(protocol: "mcp" | "a2a"): Promise<Response | null> {
  try {
    if (!await isAgentProtocolEnabled(protocol)) {
      return apiProblem({ status: 404, detail: `${protocol.toUpperCase()} protocol is disabled`, extraHeaders: { "Cache-Control": "no-store" } })
    }
    return null
  } catch {
    return apiProblem({ status: 503, detail: "Protocol settings are unavailable; retry after database recovery", extraHeaders: { "Cache-Control": "no-store" } })
  }
}
