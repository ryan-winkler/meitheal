import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

const contextKey = randomBytes(32)
export const taskPinContextHeader = "X-Meitheal-Pin-Context"

export function taskPinContext(ownerId: string): string {
  return createHmac("sha256", contextKey).update("meitheal:task-pins:").update(ownerId).digest("base64url")
}

export function matchesTaskPinContext(ownerId: string, value: string | null): boolean {
  return value !== null && /^[A-Za-z0-9_-]{43}$/.test(value)
    && timingSafeEqual(Buffer.from(value), Buffer.from(taskPinContext(ownerId)))
}
