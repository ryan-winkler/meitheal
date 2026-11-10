import type { APIRoute } from "astro";
import { listConversationAgents } from "../../../domains/ha/ha-services";
import { getHAConnectionStatus } from "../../../domains/ha/ha-connection";
import { logApiError } from "../../../lib/api-logger";

/**
 * GET /api/ha/agents — List available HA conversation agents.
 *
 * Returns the list of conversation agents registered in HA Core
 * (e.g. built-in Assist, Google Generative AI, OpenAI, Ollama).
 *
 * @domain ha
 * @bounded-context ai
 */
export const GET: APIRoute = async () => {
  const status = getHAConnectionStatus();
  if (!status.connected) {
    return new Response(
      JSON.stringify({ agents: [], error: "Home Assistant WebSocket disconnected" }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const agents = await listConversationAgents();
    return new Response(
      JSON.stringify({ agents }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    logApiError("ha-agents", "Failed to list conversation agents", err);
    return new Response(
      JSON.stringify({ agents: [], error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
