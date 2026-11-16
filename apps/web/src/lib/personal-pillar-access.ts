import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { verifyCurrentHAParticipant } from "@domains/ha/current-admin"
import { getPillarById } from "@domains/pillars/pillar-service"
import { verifiedIngressUser } from "./verified-ingress-user"

/** The immutable owner key comes from Home Assistant, never the request body. */
export async function resolvePersonalPillarOwner(locals: App.Locals, signal: AbortSignal): Promise<string | undefined> {
  const actor = verifiedIngressUser(locals)
  if (!actor || signal.aborted || await verifyCurrentHAParticipant(actor.id, signal) !== "allowed") return
  return createHash("sha256").update("pillar-owner:" + actor.id).digest("hex")
}

const signingKey = randomBytes(32)
const formLifetimeMs = 15 * 60 * 1000

function signature(owner: string, expiresAt: number): string {
  return createHmac("sha256", signingKey).update(JSON.stringify([owner, expiresAt])).digest("base64url")
}

export function issuePersonalPillarForm(owner: string): string {
  const expiresAt = Date.now() + formLifetimeMs
  return expiresAt + "." + signature(owner, expiresAt)
}

export function matchesPersonalPillarForm(token: unknown, owner: string): boolean {
  const match = typeof token === "string" && /^([1-9]\d{0,14})\.([\w-]{43})$/.exec(token)
  if (!match) return false
  const expiresAt = Number(match[1])
  const now = Date.now()
  return expiresAt > now && expiresAt <= now + formLifetimeMs
    && timingSafeEqual(Buffer.from(match[2]!), Buffer.from(signature(owner, expiresAt)))
}

export async function getVisiblePillar(id: string, locals: App.Locals, signal: AbortSignal) {
  const household = await getPillarById(id)
  if (household) return household
  const owner = await resolvePersonalPillarOwner(locals, signal)
  return owner ? getPillarById(id, owner) : null
}
