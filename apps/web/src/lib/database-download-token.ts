import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

const signingKey = randomBytes(32)
const tokenLifetimeMs = 15 * 60 * 1000

function signature(userId: string, expiresAt: number): string {
  return createHmac("sha256", signingKey)
    .update(JSON.stringify(["database-download", userId, expiresAt]))
    .digest("base64url")
}

export function issueDatabaseDownloadToken(userId: string, now = Date.now()): string {
  const expiresAt = now + tokenLifetimeMs
  return `${expiresAt}.${signature(userId, expiresAt)}`
}

export function verifyDatabaseDownloadToken(token: string, userId: string, now = Date.now()): boolean {
  const match = /^([1-9]\d{0,14})\.([\w-]{43})$/.exec(token)
  if (!match) return false
  const expiresAt = Number(match[1])
  if (expiresAt <= now || expiresAt > now + tokenLifetimeMs) return false
  return timingSafeEqual(Buffer.from(match[2]!), Buffer.from(signature(userId, expiresAt)))
}
