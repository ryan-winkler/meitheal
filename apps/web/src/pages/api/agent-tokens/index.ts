/**
 * Agent Token CRUD API
 *
 * POST   /api/agent-tokens    — Create a new agent token
 * GET    /api/agent-tokens    — List tokens (metadata only)
 * PATCH  /api/agent-tokens    — Update a token by ID (body: { id, name?, scopes?, assigneeId? })
 * DELETE /api/agent-tokens    — Revoke/delete a token by ID (body: { id, hard? })
 *
 * @domain auth
 * @bounded-context agent-authorization
 * @kcs Admin-only: requires a verified Home Assistant administrator.
 * @kcs Token plaintext returned only on POST (show-once pattern).
 */
import type { APIRoute } from "astro"
import { generateAgentToken, validateScopes, toPublicToken, type AgentScope } from "@meitheal/domain-auth"
import {
  createAgentToken,
  deleteAgentToken,
  ensureAgentTokenSchema,
  getAgentTokenById,
  isCsrfAllowed,
  listAgentTokens,
  revokeAgentToken,
  updateAgentToken,
} from "@domains/auth"
import { verifyCurrentHAAdministrator } from "@domains/ha"
import { ensureSchema, getPersistenceClient, UserRepository } from "@domains/tasks"
import { apiJson, apiProblem } from "@lib/api-response"
import { readWithinLimit } from "@lib/bounded-body"
import { verifiedIngressUser } from "@lib/verified-ingress-user"

const MAX_BODY_BYTES = 16 * 1024

/** Only an authenticated Home Assistant administrator can manage credentials. */
function isAdmin(locals: App.Locals): boolean {
  return locals.hassIsAdmin === true && !locals.agentToken
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store")
  return response
}

/** Return a validation error with invalidParams for self-correcting agents. */
function validationError(detail: string, invalidParams: Array<{ name: string; reason: string }>): Response {
  return noStore(apiProblem({
    status: 400,
    detail,
    invalidParams,
  }))
}

function requiresAssigneeForScopes(scopes: AgentScope[], assigneeId: string | null | undefined): boolean {
  return scopes.includes("tasks:write:assigned") && !scopes.includes("tasks:write") && !assigneeId
}

function cancelBody(request: Request): void {
  if (!request.body?.locked) void request.body?.cancel().catch(() => undefined)
}

function parseAssigneeId(raw: unknown): { ok: true; value: string | null } | { ok: false; response: Response } {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  if (typeof raw !== "string") {
    return {
      ok: false,
      response: validationError("Invalid assigneeId", [
        { name: "assigneeId", reason: "must be a string or null" },
      ]),
    }
  }
  const trimmed = raw.trim()
  if (trimmed.length > 128) {
    return {
      ok: false,
      response: validationError("Assignee ID too long", [
        { name: "assigneeId", reason: "must be 128 characters or fewer" },
      ]),
    }
  }
  return { ok: true, value: trimmed || null }
}

function authorizeAdminContext(
  request: Request,
  locals: App.Locals,
  action: string,
  isMutation: boolean,
): Response | null {
  if (!isAdmin(locals)) {
    cancelBody(request)
    return noStore(apiProblem({
      status: 403,
      title: "Admin Required",
      detail: `${action} agent tokens requires HA admin access`,
      type: "https://meitheal.local/problems/admin-required",
    }))
  }

  if (isMutation) {
    const origin = request.headers.get("origin")
    const referer = request.headers.get("referer")
    const secFetchSite = request.headers.get("sec-fetch-site")
    const untrustedFetchSite = secFetchSite !== null && secFetchSite !== "same-origin" && secFetchSite !== "none"
    const untrustedOrigin = (origin !== null || referer !== null) && !isCsrfAllowed({
      behindIngress: false,
      isDev: false,
      host: request.headers.get("host") ?? new URL(request.url).host,
      origin,
      referer: origin ? null : referer,
    })
    if (untrustedFetchSite || untrustedOrigin) {
      cancelBody(request)
      return noStore(apiProblem({
        status: 403,
        title: "Cross-Origin Request Denied",
        detail: "Submit agent token changes from the same site.",
        type: "https://meitheal.local/problems/csrf-denied",
      }))
    }
  }

  const user = verifiedIngressUser(locals)
  if (process.env.SUPERVISOR_TOKEN && !user?.isAdmin) {
    cancelBody(request)
    return noStore(apiProblem({
      status: 403,
      title: "Admin Required",
      detail: `${action} agent tokens requires a current HA administrator.`,
      type: "https://meitheal.local/problems/admin-required",
    }))
  }

  return null
}

async function verifyLiveAdmin(
  request: Request,
  locals: App.Locals,
  action: string,
): Promise<Response | null> {
  if (!process.env.SUPERVISOR_TOKEN) return null
  const user = verifiedIngressUser(locals)
  if (!user?.isAdmin) {
    return noStore(apiProblem({
      status: 403,
      title: "Admin Required",
      detail: `${action} agent tokens requires a current HA administrator.`,
      type: "https://meitheal.local/problems/admin-required",
    }))
  }
  const authority = await verifyCurrentHAAdministrator(user.id, request.signal)
  if (authority !== "allowed") {
    return noStore(apiProblem({
      status: authority === "unavailable" ? 503 : 403,
      title: authority === "unavailable" ? "Service Unavailable" : "Admin Required",
      detail: authority === "unavailable"
        ? "Home Assistant could not verify administrator access. Try again."
        : `${action} agent tokens requires a current HA administrator.`,
      type: "https://meitheal.local/problems/admin-required",
    }))
  }
  return null
}

async function readJsonObject(
  request: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (mediaType !== "application/json") {
    cancelBody(request)
    return {
      ok: false,
      response: noStore(apiProblem({
        status: 415,
        title: "Unsupported Media Type",
        detail: "Request body must be application/json",
        type: "https://meitheal.local/problems/unsupported-media-type",
      })),
    }
  }

  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
    cancelBody(request)
    return {
      ok: false,
      response: noStore(apiProblem({
        status: 413,
        title: "Payload Too Large",
        detail: "Request body exceeds 16 KiB",
      })),
    }
  }

  let bytes: Buffer | null
  try {
    bytes = await readWithinLimit(
      request.body,
      MAX_BODY_BYTES,
      AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]),
    )
  } catch {
    return {
      ok: false,
      response: noStore(apiProblem({
        status: 400,
        title: "Invalid JSON",
        detail: "Request body must be valid JSON",
        type: "https://meitheal.local/problems/invalid-json",
      })),
    }
  }

  if (!bytes) {
    return {
      ok: false,
      response: noStore(apiProblem({
        status: 413,
        title: "Payload Too Large",
        detail: "Request body exceeds 16 KiB",
      })),
    }
  }

  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        ok: false,
        response: validationError("Request body must be a JSON object", [{ name: "body", reason: "expected object" }]),
      }
    }
    return { ok: true, body: value as Record<string, unknown> }
  } catch {
    return {
      ok: false,
      response: noStore(apiProblem({
        status: 400,
        title: "Invalid JSON",
        detail: "Request body must be valid JSON",
        type: "https://meitheal.local/problems/invalid-json",
      })),
    }
  }
}

type AssigneeChoice = { assigneeId: string | null } | Response

/**
 * A token may act only as an agent assignee. Linking it to a person would let
 * automation answer for a household member.
 */
async function readAssignee(value: unknown, scopes: AgentScope[] | undefined): Promise<AssigneeChoice> {
  if (value === null || value === undefined || value === "") {
    if (requiresAssigneeForScopes(scopes ?? [], null)) {
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
  const contextDenied = authorizeAdminContext(request, locals, "Creating", true)
  if (contextDenied) return contextDenied

  const parsed = await readJsonObject(request)
  if (!parsed.ok) return parsed.response
  const { body } = parsed

  const liveDenied = await verifyLiveAdmin(request, locals, "Creating")
  if (liveDenied) return liveDenied

  await ensureAgentTokenSchema()

  const name = typeof body.name === "string" ? body.name.trim() : ""
  const rawScopes = Array.isArray(body.scopes) ? body.scopes : []
  const rawAssignee = body.assignee_id !== undefined ? body.assignee_id : body.assigneeId
  const parsedAssignee = parseAssigneeId(rawAssignee)
  if (!parsedAssignee.ok) return parsedAssignee.response
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

  const assignee = await readAssignee(parsedAssignee.value, scopes)
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

  // Return plaintext token ONCE — Meitheal never stores or retrieves it again.
  return noStore(apiJson({
    id: record.id,
    name: record.name,
    token,
    tokenPrefix: record.tokenPrefix,
    scopes: record.scopes,
    assigneeId: record.assigneeId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  }, 201))
}

// ── GET: List Tokens ─────────────────────────────────────────────────────────

export const GET: APIRoute = async ({ request, locals }) => {
  const contextDenied = authorizeAdminContext(request, locals, "Listing", false)
  if (contextDenied) return contextDenied

  const liveDenied = await verifyLiveAdmin(request, locals, "Listing")
  if (liveDenied) return liveDenied

  await ensureAgentTokenSchema()

  const includeRevoked = new URL(request.url).searchParams.get("include_revoked") === "1"
  const tokens = await listAgentTokens(includeRevoked)
  return noStore(apiJson(tokens.map(toPublicToken)))
}

// ── PATCH: Update Token ──────────────────────────────────────────────────────

export const PATCH: APIRoute = async ({ request, locals }) => {
  const contextDenied = authorizeAdminContext(request, locals, "Updating", true)
  if (contextDenied) return contextDenied

  const parsed = await readJsonObject(request)
  if (!parsed.ok) return parsed.response
  const { body } = parsed

  const liveDenied = await verifyLiveAdmin(request, locals, "Updating")
  if (liveDenied) return liveDenied

  await ensureAgentTokenSchema()

  const id = typeof body.id === "string" ? body.id : ""
  if (!id) {
    return validationError("Token ID is required", [
      { name: "id", reason: "must be a valid token ID" },
    ])
  }

  if (!("assigneeId" in body) && "assignee_id" in body) body.assigneeId = body.assignee_id
  const hasAssigneeField = body.assignee_id !== undefined || body.assigneeId !== undefined
  const updates: { name?: string; scopes?: AgentScope[]; assigneeId?: string | null } = {}

  if (hasAssigneeField) {
    const val = body.assignee_id !== undefined ? body.assignee_id : body.assigneeId
    const parsedAssignee = parseAssigneeId(val)
    if (!parsedAssignee.ok) return parsedAssignee.response
    updates.assigneeId = parsedAssignee.value
  }

  if (body.name !== undefined) {
    if (typeof body.name !== "string") {
      return validationError("Token name must be a string", [
        { name: "name", reason: "must be a non-empty string" },
      ])
    }
    const name = body.name.trim()
    if (!name) {
      return validationError("Token name cannot be empty", [
        { name: "name", reason: "must be a non-empty string" },
      ])
    }
    if (name.length > 100) {
      return validationError("Token name too long", [
        { name: "name", reason: "must be 100 characters or fewer" },
      ])
    }
    updates.name = name
  }

  if (body.scopes !== undefined) {
    if (!Array.isArray(body.scopes)) {
      return validationError("Scopes must be an array", [
        { name: "scopes", reason: "must be an array of scope strings" },
      ])
    }
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

  if (Object.keys(updates).length === 0) {
    return validationError("At least one updatable field is required", [
      { name: "body", reason: "provide name, scopes, or assigneeId" },
    ])
  }

  const existing = await getAgentTokenById(id)
  if (!existing) {
    return noStore(apiProblem({
      status: 404,
      title: "Token Not Found",
      detail: `No agent token found with ID: ${id}`,
      type: "https://meitheal.local/problems/not-found",
    }))
  }

  const effectiveScopes = updates.scopes ?? existing.scopes
  const effectiveAssigneeId = updates.assigneeId !== undefined ? updates.assigneeId : (existing.assigneeId ?? null)
  if (hasAssigneeField || requiresAssigneeForScopes(effectiveScopes, effectiveAssigneeId)) {
    const assignee = await readAssignee(effectiveAssigneeId, effectiveScopes)
    if (assignee instanceof Response) return assignee
    if (hasAssigneeField) updates.assigneeId = assignee.assigneeId
  }

  const updated = await updateAgentToken(id, updates)
  if (!updated) {
    return noStore(apiProblem({
      status: 404,
      title: "Token Not Found",
      detail: `No agent token found with ID: ${id}`,
      type: "https://meitheal.local/problems/not-found",
    }))
  }

  return noStore(apiJson({ ok: true, id }))
}

// ── DELETE: Revoke/Delete Token ──────────────────────────────────────────────

export const DELETE: APIRoute = async ({ request, locals }) => {
  const contextDenied = authorizeAdminContext(request, locals, "Deleting", true)
  if (contextDenied) return contextDenied

  const parsed = await readJsonObject(request)
  if (!parsed.ok) return parsed.response
  const { body } = parsed

  const liveDenied = await verifyLiveAdmin(request, locals, "Deleting")
  if (liveDenied) return liveDenied

  await ensureAgentTokenSchema()

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
    return noStore(apiProblem({
      status: 404,
      title: "Token Not Found",
      detail: `No agent token found with ID: ${id}`,
      type: "https://meitheal.local/problems/not-found",
    }))
  }

  return noStore(apiJson({ ok: true, id, action: hard ? "deleted" : "revoked" }))
}
