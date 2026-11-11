import type { APIRoute } from "astro"
import { listConversationAgents } from "../../../domains/ha/ha-services"
import { getHAConnection } from "../../../domains/ha/ha-connection"
import { assistResponseHeaders as headers, requireAssistAdministrator } from "../../../lib/assist-access"


export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireAssistAdministrator(request, locals)
  if (denied) return denied

  if (!(await getHAConnection())?.connected) {
    return Response.json({ agents: [], error: "Home Assistant is disconnected." }, { status: 503, headers })
  }

  const agents = await listConversationAgents()
  if (!agents) {
    return Response.json({ agents: [], error: "Home Assistant did not return a conversation agent list." }, { status: 502, headers })
  }
  return Response.json({ agents }, { headers })
}
