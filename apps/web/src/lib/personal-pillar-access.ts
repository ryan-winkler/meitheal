import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { personalPillarScope, personalPillarOwnerId, type PersonalPillarScope, type PillarOwnerScope } from "@domains/pillars"
import { verifiedBoardRequestPrincipal, resolveBoardRequestScope } from "./board-request-context"
import { boardScopeResponse } from "./board-http"
import { ensureSchema, getPersistenceClient } from "@domains/tasks"
import type { WorkAction } from "@domains/tasks/board-scope"
import { getPillarById } from "@domains/pillars"
import { apiError } from "./api-response"
import { readWithinLimit } from "./bounded-body"

type PillarRequestContext = { request: Request, locals: App.Locals }

/** The immutable Personal owner comes only from a current verified request principal. */
export async function resolvePersonalPillarOwner(context: PillarRequestContext, write = false): Promise<PersonalPillarScope | undefined> {
  const principal = await verifiedBoardRequestPrincipal(context, write)
  if (!principal || !["ha_user", "local_operator"].includes(principal.kind)) return
  return personalPillarScope(principal) ?? undefined
}

const signingKey = randomBytes(32)
const formLifetimeMs = 15 * 60 * 1000

function signature(owner: string, expiresAt: number): string {
  return createHmac("sha256", signingKey).update(JSON.stringify([owner, expiresAt])).digest("base64url")
}

export function issuePersonalPillarForm(scope: PersonalPillarScope): string {
  const owner = personalPillarOwnerId(scope)
  const expiresAt = Date.now() + formLifetimeMs
  return expiresAt + "." + signature(owner, expiresAt)
}

export function matchesPersonalPillarForm(token: unknown, scope: PersonalPillarScope): boolean {
  const owner = personalPillarOwnerId(scope)
  const match = typeof token === "string" && /^([1-9]\d{0,14})\.([\w-]{43})$/.exec(token)
  if (!match) return false
  const expiresAt = Number(match[1])
  const now = Date.now()
  return expiresAt > now && expiresAt <= now + formLifetimeMs
    && timingSafeEqual(Buffer.from(match[2]!), Buffer.from(signature(owner, expiresAt)))
}

export async function getVisiblePillar(id: string, context: PillarRequestContext, action: WorkAction = "read") {
  await ensureSchema()
  // Ownership-only locator. No foreign Pillar title or policy is projected here.
  const { rows: [owner] } = await getPersistenceClient().execute({ sql: "SELECT user_id FROM pillars WHERE id = ?", args: [id] })
  if (!owner) return null
  let ownerScope: PillarOwnerScope
  if (owner.user_id !== "default") {
    const personal = await resolvePersonalPillarOwner(context, action !== "read")
    if (!personal || personalPillarOwnerId(personal) !== owner.user_id) return null
    ownerScope = personal
  } else {
    const result = await resolveBoardRequestScope(context, { operation: { resource: "pillar", action }, record: { resource: "pillar", id } })
    if (!result.ok) return boardScopeResponse(result.errorCode)
    ownerScope = result.scope
  }
  const pillar = await getPillarById(ownerScope, id)
  return pillar ? { pillar, ownerScope } : null
}

export async function readPillarBody(request: Request): Promise<Record<string, unknown> | Response> {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)])
  try {
    const data = await readWithinLimit(request.body, 64 * 1024, signal)
    if (!data) return apiError("Pillar requests are limited to 64 KiB.", 413)
    const body: unknown = JSON.parse(data.toString("utf8"))
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>
    return apiError("Send a JSON object.", 400)
  } catch {
    return signal.aborted ? apiError("The request body did not arrive in time.", 408) : apiError("Send a JSON object.", 400)
  }
}
