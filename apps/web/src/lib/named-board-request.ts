import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { BoardActor } from "@domains/tasks/persistence/named-board-repository"
import { getCurrentHAUserRoster } from "@domains/ha/ha-users"
import { readWithinLimit } from "./bounded-body"
import { verifiedIngressUser } from "./verified-ingress-user"

const boardSessionSecret = randomBytes(32)

export function boardSessionProof(id: string) {
  return createHmac("sha256", boardSessionSecret).update(id).digest("hex")
}

export function boardGroupCursor(actorId: string, boardId: string, after: string): string {
  const proof = createHmac("sha256", boardSessionSecret).update(JSON.stringify(["group-page", actorId, boardId, after])).digest("hex")
  return `${after}.${proof}`
}

export function readBoardGroupCursor(actorId: string, boardId: string, cursor: string): string | null {
  const id = cursor.slice(0, cursor.lastIndexOf("."))
  if (!id || id.length > 150) return null
  const expected = Buffer.from(boardGroupCursor(actorId, boardId, id))
  const actual = Buffer.from(cursor)
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? id : null
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

export async function currentBoardTaskActor(locals: App.Locals, request: Request, write = false): Promise<BoardActor | null> {
  if (locals.agentToken) return { kind: "agent", id: locals.agentToken.tokenId }
  return (await currentBoardUser(locals, request.signal, write ? request : undefined))?.actor ?? null
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
