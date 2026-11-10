import type { APIRoute } from "astro"
import { askAssist } from "../../../domains/ha/ha-services"
import { getHAConnection } from "../../../domains/ha/ha-connection"
import { requireSystemSettingsAdmin } from "../../../lib/settings-security"

const rateBuckets = new Map<string, { count: number; resetAt: number }>()
const rateWindowMs = 60_000
const headers = { "cache-control": "private, no-store" }

function checkRateLimit(key: string): boolean {
  const now = Date.now()
  const bucket = rateBuckets.get(key)
  if (bucket && now < bucket.resetAt) {
    if (bucket.count >= 10) return false
    bucket.count++
    return true
  }
  if (rateBuckets.size >= 128) {
    const firstKey = rateBuckets.keys().next().value
    if (firstKey !== undefined) rateBuckets.delete(firstKey)
  }
  rateBuckets.set(key, { count: 1, resetAt: now + rateWindowMs })
  return true
}

/** Conversation commands execute with the App's Home Assistant credential. */
export const POST: APIRoute = async ({ request, locals }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) {
    denied.headers.set("cache-control", headers["cache-control"])
    return denied
  }

  const body = await request.json().catch(() => null)
  const text = typeof body?.text === "string" ? body.text.trim() : ""
  if (!text) return Response.json({ error: "Provide text for Home Assistant Assist." }, { status: 400, headers })
  if (!checkRateLimit(locals.hassUserId ?? "local")) {
    return Response.json({ error: "Too many Assist requests. Try again in a minute." }, {
      status: 429,
      headers: { ...headers, "retry-after": "60" },
    })
  }

  if (!await getHAConnection()) {
    return Response.json({ error: "Home Assistant is disconnected." }, { status: 503, headers })
  }

  const result = await askAssist(text, {
    agentId: typeof body.agent_id === "string" ? body.agent_id : undefined,
    conversationId: typeof body.conversation_id === "string" ? body.conversation_id : undefined,
  })
  if (!result.responseType) {
    return Response.json({ error: "Home Assistant did not return a conversation response." }, { status: 502, headers })
  }

  return Response.json({
    speech: result.speech,
    conversation_id: result.conversationId,
    response_type: result.responseType,
  }, { headers })
}
