import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { getCurrentHAUserRoster } from "@domains/ha/ha-users"
import { readWithinLimit } from "./bounded-body"
import { verifiedIngressUser } from "./verified-ingress-user"

const boardSessionSecret = randomBytes(32)

export function boardSessionProof(id: string) {
  return createHmac("sha256", boardSessionSecret).update(id).digest("hex")
}

export async function currentBoardUser(locals: App.Locals, signal: AbortSignal, writeRequest?: Request) {
  const user = verifiedIngressUser(locals)
  if (!user) return null
  if (writeRequest) {
    const presented = writeRequest.headers.get("x-meitheal-board-session")
    if (!presented || !/^[0-9a-f]{64}$/.test(presented) ||
      !timingSafeEqual(Buffer.from(presented, "hex"), Buffer.from(boardSessionProof(user.id), "hex"))) return null
  }
  const roster = await getCurrentHAUserRoster(user.id, signal)
  if (!roster) return null
  return { actor: { kind: "ha_user", id: user.id } as const, roster }
}

export async function readBoardRequest(request: Request): Promise<Record<string, unknown> | null> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)])
  try {
    const body = await readWithinLimit(request.body, 24 * 1024, signal)
    if (!body) return null
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}
