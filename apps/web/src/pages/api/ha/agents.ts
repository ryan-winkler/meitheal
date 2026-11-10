import type { APIRoute } from "astro"
import { listConversationAgents } from "../../../domains/ha/ha-services"
import { getHAConnection } from "../../../domains/ha/ha-connection"
import { requireSystemSettingsAdmin } from "../../../lib/settings-security"

const headers = { "cache-control": "private, no-store" }

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) {
    denied.headers.set("cache-control", headers["cache-control"])
    return denied
  }

  if (!await getHAConnection()) {
    return Response.json({ agents: [], error: "Home Assistant is disconnected." }, { status: 503, headers })
  }

  const agents = await listConversationAgents()
  if (!agents) {
    return Response.json({ agents: [], error: "Home Assistant did not return a conversation agent list." }, { status: 502, headers })
  }
  return Response.json({ agents }, { headers })
}
