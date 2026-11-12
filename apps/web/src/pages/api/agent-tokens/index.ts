/**
 * Agent Token CRUD API
 *
 * POST   /api/agent-tokens    — Create a new agent token
 * GET    /api/agent-tokens    — List all tokens (metadata only)
 * PATCH  /api/agent-tokens    — Update a token by ID (body: { id, name?, scopes?, assigneeId? })
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
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { UserRepository } from "@domains/tasks/persistence/user-repository"

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

type AssigneeChoice = { assigneeId: string | null } | Response

/**
 * A token may act only as an agent assignee. Linking it to a person would let
 * automation answer for a household member.
 */
async function readAssignee(value: unknown, scopes: AgentScope[] | undefined): Promise<AssigneeChoice> {
  if (value === null || value === undefined || value === "") {
    if (scopes?.includes("tasks:write:assigned")) {
      return validationError("Working on assigned tasks needs an agent assignee", [
        { name: "assigneeId", reason: "choose the agent assignee this token acts as" },
      ])
    }
    return { assigneeId: null }
  }
  if (typeof value !== "string") {
    return validationError("Invalid assignee", [{ name: "assigneeId", reason: "must be an agent assignee ID or null" }])
  }
  await ensureSchema()
  const assignee = await new UserRepository(getPersistenceClient()).getCustomUser(value)
  if (assignee?.kind !== "agent") {
    return validationError("Invalid assignee", [
      { name: "assigneeId", reason: "must be the ID of an agent assignee" },
    ])
  }
  return { assigneeId: assignee.id }
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

  const assignee = await readAssignee(body.assigneeId !== undefined ? body.assigneeId : body.assignee_id, scopes)
  if (assignee instanceof Response) return assignee

  const { token, tokenHash, tokenPrefix } = generateAgentToken()
  const id = crypto.randomUUID()

  const record = await createAgentToken({
    id,
    name,
    tokenHash,
    tokenPrefix,
    scopes,
    assigneeId: assignee.assigneeId,
    expiresAt,
  })

  // Return plaintext token ONCE — it is never stored or retrievable
  const response = apiJson({
    id: record.id,
    name: record.name,
    token,  // Show once!
    tokenPrefix: record.tokenPrefix,
    scopes: record.scopes,
    assigneeId: record.assigneeId,
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

  if (!("assigneeId" in body) && "assignee_id" in body) body.assigneeId = body.assignee_id
  const updates: { name?: string; scopes?: AgentScope[]; assigneeId?: string | null } = {}

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

  if ("assigneeId" in body || updates.scopes?.includes("tasks:write:assigned")) {
    const current = (await listAgentTokens(true)).find(token => token.id === id)
    const assignee = await readAssignee(
      "assigneeId" in body ? body.assigneeId : current?.assigneeId,
      updates.scopes ?? current?.scopes,
    )
    if (assignee instanceof Response) return assignee
    if ("assigneeId" in body) updates.assigneeId = assignee.assigneeId
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
