/**
 * Agent Token CRUD API
 *
 * POST   /api/agent-tokens    — Create a new agent token
 * GET    /api/agent-tokens    — List all tokens (metadata only)
 * PATCH  /api/agent-tokens    — Update a token by ID (body: { id, name?, scopes? })
 * DELETE /api/agent-tokens    — Revoke/delete a token by ID (body: { id, hard? })
 *
 * @domain auth
 * @bounded-context agent-authorization
 * @kcs Admin-only: requires a verified Home Assistant administrator.
 * @kcs Token plaintext returned only on POST (show-once pattern).
 */
import type { APIRoute } from "astro"
import { apiJson, apiProblem } from "../../../lib/api-response"
import { generateAgentToken, validateScopes, toPublicToken, type AgentScope } from "@meitheal/domain-auth"
import {
  createAgentToken,
  listAgentTokens,
  updateAgentToken,
  deleteAgentToken,
  revokeAgentToken,
  ensureAgentTokenSchema,
} from "@domains/auth/agent-token-store"

/** Only an authenticated Home Assistant administrator can manage credentials. */
function isAdmin(locals: App.Locals): boolean {
  return locals.hassIsAdmin === true && !locals.agentToken
}

/** Return a validation error with invalidParams for self-correcting agents */
function validationError(detail: string, invalidParams: Array<{ name: string; reason: string }>): Response {
  return apiProblem({
    status: 400,
    detail,
    invalidParams,
  })
}

// ── POST: Create Token ───────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request, locals }) => {
  if (!isAdmin(locals)) {
    return apiProblem({
      status: 403,
      title: "Admin Required",
      detail: "Creating agent tokens requires HA admin access",
      type: "https://meitheal.local/problems/admin-required",
    })
  }

  await ensureAgentTokenSchema()

  let body: Record<string, unknown>
  try {
    const value: unknown = await request.json()
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return validationError("Request body must be a JSON object", [{ name: "body", reason: "expected object" }])
    }
    body = value as Record<string, unknown>
  } catch {
    return apiProblem({
      status: 400,
      title: "Invalid JSON",
      detail: "Request body must be valid JSON",
      type: "https://meitheal.local/problems/invalid-json",
    })
  }

  const name = typeof body.name === "string" ? body.name.trim() : ""
  const rawScopes = Array.isArray(body.scopes) ? body.scopes : []
  const expiration = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : Number.NaN
  if (body.expiresAt != null && !(expiration > Date.now())) {
    return validationError("Token expiration must be a future date", [
      { name: "expiresAt", reason: "provide a future timestamp or omit expiration" },
    ])
  }
  const expiresAt = Number.isFinite(expiration) ? new Date(expiration).toISOString() : null

  if (!name) {
    return validationError("Token name is required", [
      { name: "name", reason: "must be a non-empty string" },
    ])
  }

  if (name.length > 100) {
    return validationError("Token name too long", [
      { name: "name", reason: "must be 100 characters or fewer" },
    ])
  }

  const { valid: scopes, invalid } = validateScopes(rawScopes.map(String))
  if (invalid.length > 0) {
    return validationError("Invalid scopes", invalid.map(s => ({
      name: "scopes",
      reason: `unknown scope: "${s}"`,
    })))
  }

  if (scopes.length === 0) {
    return validationError("At least one scope is required", [
      { name: "scopes", reason: "must include at least one valid scope" },
    ])
  }

  const { token, tokenHash, tokenPrefix } = generateAgentToken()
  const id = crypto.randomUUID()

  const record = await createAgentToken({
    id,
    name,
    tokenHash,
    tokenPrefix,
    scopes,
    expiresAt,
  })

  // Return plaintext token ONCE — it is never stored or retrievable
  const response = apiJson({
    id: record.id,
    name: record.name,
    token,  // Show once!
    tokenPrefix: record.tokenPrefix,
    scopes: record.scopes,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  }, 201)
  response.headers.set("Cache-Control", "no-store")
  return response
}

// ── GET: List Tokens ─────────────────────────────────────────────────────────

export const GET: APIRoute = async ({ locals }) => {
  if (!isAdmin(locals)) {
    return apiProblem({
      status: 403,
      title: "Admin Required",
      detail: "Listing agent tokens requires HA admin access",
      type: "https://meitheal.local/problems/admin-required",
    })
  }

  await ensureAgentTokenSchema()

  const tokens = await listAgentTokens()
  return apiJson(tokens.map(toPublicToken))
}

// ── PATCH: Update Token ──────────────────────────────────────────────────────

export const PATCH: APIRoute = async ({ request, locals }) => {
  if (!isAdmin(locals)) {
    return apiProblem({
      status: 403,
      title: "Admin Required",
      detail: "Updating agent tokens requires HA admin access",
      type: "https://meitheal.local/problems/admin-required",
    })
  }

  await ensureAgentTokenSchema()

  let body: Record<string, unknown>
  try {
    const value: unknown = await request.json()
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return validationError("Request body must be a JSON object", [{ name: "body", reason: "expected object" }])
    }
    body = value as Record<string, unknown>
  } catch {
    return apiProblem({
      status: 400,
      title: "Invalid JSON",
      detail: "Request body must be valid JSON",
      type: "https://meitheal.local/problems/invalid-json",
    })
  }

  const id = typeof body.id === "string" ? body.id : ""
  if (!id) {
    return validationError("Token ID is required", [
      { name: "id", reason: "must be a valid token ID" },
    ])
  }

  const updates: { name?: string; scopes?: AgentScope[] } = {}

  if (typeof body.name === "string") {
    const name = body.name.trim()
    if (!name) {
      return validationError("Token name cannot be empty", [
        { name: "name", reason: "must be a non-empty string" },
      ])
    }
    updates.name = name
  }

  if (Array.isArray(body.scopes)) {
    const { valid, invalid } = validateScopes(body.scopes.map(String))
    if (invalid.length > 0) {
      return validationError("Invalid scopes", invalid.map(s => ({
        name: "scopes",
        reason: `unknown scope: "${s}"`,
      })))
    }
    if (valid.length === 0) {
      return validationError("At least one scope is required", [
        { name: "scopes", reason: "must include at least one valid scope" },
      ])
    }
    updates.scopes = valid
  }

  const updated = await updateAgentToken(id, updates)
  if (!updated) {
    return apiProblem({
      status: 404,
      title: "Token Not Found",
      detail: `No agent token found with ID: ${id}`,
      type: "https://meitheal.local/problems/not-found",
    })
  }

  return apiJson({ ok: true, id })
}

// ── DELETE: Revoke/Delete Token ──────────────────────────────────────────────

export const DELETE: APIRoute = async ({ request, locals }) => {
  if (!isAdmin(locals)) {
    return apiProblem({
      status: 403,
      title: "Admin Required",
      detail: "Deleting agent tokens requires HA admin access",
      type: "https://meitheal.local/problems/admin-required",
    })
  }

  await ensureAgentTokenSchema()

  let body: Record<string, unknown>
  try {
    const value: unknown = await request.json()
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return validationError("Request body must be a JSON object", [{ name: "body", reason: "expected object" }])
    }
    body = value as Record<string, unknown>
  } catch {
    return apiProblem({
      status: 400,
      title: "Invalid JSON",
      detail: "Request body must be valid JSON",
      type: "https://meitheal.local/problems/invalid-json",
    })
  }

  const id = typeof body.id === "string" ? body.id : ""
  if (!id) {
    return validationError("Token ID is required", [
      { name: "id", reason: "must be a valid token ID" },
    ])
  }

  const hard = body.hard === true

  const success = hard
    ? await deleteAgentToken(id)
    : await revokeAgentToken(id)

  if (!success) {
    return apiProblem({
      status: 404,
      title: "Token Not Found",
      detail: `No agent token found with ID: ${id}`,
      type: "https://meitheal.local/problems/not-found",
    })
  }

  return apiJson({ ok: true, id, action: hard ? "deleted" : "revoked" })
}
