/**
 * Agent Token Self-Renewal API
 *
 * POST /api/agent-tokens/renew
 *
 * Allows an active, non-revoked, non-expired agent token (such as the Home Assistant
 * integration) to extend its own expiration window before expiry without changing scopes
 * or Board grants.
 *
 * Security invariants:
 * - Only works for an already-valid, non-revoked, non-expired Bearer agent token.
 * - Cannot elevate scopes, change assignee, or modify Board grants.
 * - Extension window is strictly bounded (1..365 days, default 90 days).
 *
 * @domain auth
 * @bounded-context agent-authorization
 */
import type { APIRoute } from "astro"
import { ensureAgentTokenSchema, getAgentTokenById, renewAgentToken } from "@domains/auth"
import { apiJson, apiProblem } from "@lib/api-response"

const DEFAULT_EXTEND_DAYS = 90
const MIN_EXTEND_DAYS = 1
const MAX_EXTEND_DAYS = 365

export const POST: APIRoute = async ({ request, locals }) => {
  const agent = locals.agentToken
  if (!agent?.tokenId) {
    return apiProblem({
      status: 401,
      title: "Agent Token Required",
      detail: "Authenticate with an active agent Bearer token to renew it.",
      extraHeaders: { "Cache-Control": "private, no-store", "WWW-Authenticate": "Bearer" },
    })
  }

  await ensureAgentTokenSchema()
  const record = await getAgentTokenById(agent.tokenId)
  if (!record || record.revoked || (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now())) {
    return apiProblem({
      status: 401,
      title: "Invalid Token",
      detail: "This token is no longer active and cannot be renewed.",
      extraHeaders: { "Cache-Control": "private, no-store" },
    })
  }

  // Non-expiring tokens are already permanent
  if (!record.expiresAt) {
    const res = apiJson({ ok: true, id: record.id, expiresAt: null, renewed: false })
    res.headers.set("Cache-Control", "private, no-store")
    return res
  }

  let days = DEFAULT_EXTEND_DAYS
  const contentType = request.headers.get("content-type") ?? ""
  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (body && typeof body.days === "number" && Number.isFinite(body.days)) {
      days = Math.min(MAX_EXTEND_DAYS, Math.max(MIN_EXTEND_DAYS, Math.round(body.days)))
    }
  }

  const nextExpiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
  const renewed = await renewAgentToken(record.id, nextExpiresAt)
  if (!renewed) {
    return apiProblem({
      status: 404,
      title: "Token Not Found",
      detail: "Unable to renew this token.",
      extraHeaders: { "Cache-Control": "private, no-store" },
    })
  }

  const res = apiJson({
    ok: true,
    id: renewed.id,
    expiresAt: renewed.expiresAt,
    renewed: true,
  })
  res.headers.set("Cache-Control", "private, no-store")
  return res
}
