import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

const contextKey = randomBytes(32)
export { commentMentionContextHeader as mentionInboxContextHeader } from "./comment-mentions"

export function mentionInboxContext(owner: string): string {
  return createHmac("sha256", contextKey).update(owner).digest("base64url")
}

export function matchesMentionInboxContext(owner: string, value: string | null): boolean {
  return value !== null && /^[A-Za-z0-9_-]{43}$/.test(value)
    && timingSafeEqual(Buffer.from(value), Buffer.from(mentionInboxContext(owner)))
}
