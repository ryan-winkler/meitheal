import type { APIRoute } from "astro";
import { askAssist, type AssistResponse } from "../../../domains/ha/ha-services";
import { getHAConnectionStatus } from "../../../domains/ha/ha-connection";
import { logApiError } from "../../../lib/api-logger";

/**
 * POST /api/ha/assist — Proxy to HA conversation.process.
 *
 * Supports multi-turn via conversation_id and agent selection via agent_id.
 * Returns full response with speech, conversation_id, and response_type.
 *
 * @domain ha
 * @bounded-context ai
 * @see https://developers.home-assistant.io/docs/intent_conversation_api
 */

// Simple in-memory rate limiter for LLM calls (10/min per IP)
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT) return false;
  bucket.count++;
  return true;
}

export const POST: APIRoute = async ({ request }) => {
  const status = getHAConnectionStatus();
  if (!status.connected) {
    return new Response(
      JSON.stringify({ error: "Home Assistant WebSocket disconnected" }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  // Rate limit by IP or fallback
  const clientIp = request.headers.get("x-forwarded-for") || "anonymous";
  if (!checkRateLimit(clientIp)) {
    return new Response(
      JSON.stringify({ error: "Rate limited — max 10 Assist calls per minute" }),
      { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" } }
    );
  }

  try {
    const body = await request.json();
    if (!body?.text || typeof body.text !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid 'text' property" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const options: { agentId?: string; conversationId?: string } = {};
    if (body.agent_id && typeof body.agent_id === "string") {
      options.agentId = body.agent_id;
    }
    if (body.conversation_id && typeof body.conversation_id === "string") {
      options.conversationId = body.conversation_id;
    }

    const result: AssistResponse = await askAssist(body.text, options);

    return new Response(
      JSON.stringify({
        speech: result.speech ?? "Done.",
        conversation_id: result.conversationId,
        response_type: result.responseType,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    logApiError("ha-assist", "Failed to proxy assist request", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
