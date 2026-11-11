import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

const contextKey = randomBytes(32)
export const taskDraftContextHeader = "X-Meitheal-Draft-Context"

export function taskDraftContext(ownerId: string): string {
  return createHmac("sha256", contextKey).update("meitheal:task-drafts:").update(ownerId).digest("base64url")
}

export function matchesTaskDraftContext(ownerId: string, value: string | null): boolean {
  return value !== null && /^[A-Za-z0-9_-]{43}$/.test(value)
    && timingSafeEqual(Buffer.from(value), Buffer.from(taskDraftContext(ownerId)))
}
