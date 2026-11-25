import { readCurrentHACoreUsers } from "./core-user-lookup"
import {
  currentSupervisorFingerprint,
  readFreshCachedHARole,
  readOutageCachedHARole,
} from "./ha-user-cache"

type AdminVerification = "allowed" | "denied" | "unavailable"
type CurrentHARole = "admin" | "member" | "denied" | "unavailable"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function currentRole(result: unknown, userId: string, ownerOnly = false): CurrentHARole {
  if (!Array.isArray(result)) return "unavailable"
  const matches = result.filter(user => isRecord(user) && user.id === userId)
  if (matches.length === 0) return "denied"
  if (matches.length !== 1) return "unavailable"
  const user = matches[0] as Record<string, unknown>
  if (typeof user.is_active !== "boolean" || typeof user.system_generated !== "boolean"
    || typeof user.is_owner !== "boolean" || !Array.isArray(user.group_ids)
    || !user.group_ids.every(group => typeof group === "string")) return "unavailable"

  if (!user.is_active || user.system_generated) return "denied"
  return user.is_owner || (!ownerOnly && user.group_ids.includes("system-admin")) ? "admin" : "member"
}

/**
 * Resolve active membership and administrator status.
 * When `allowCachedFallback` is true (default for standard workspace requests), uses the 60s
 * in-memory Core cache to avoid per-request WebSocket churn and falls back to the local SQLite
 * `ha_user_cache` ONLY if HA Core is unreachable ("unavailable") — never overriding explicit denials.
 */
export async function readCurrentHARole(
  userId: string,
  signal: AbortSignal,
  { allowCachedFallback = false }: { allowCachedFallback?: boolean } = {},
): Promise<CurrentHARole> {
  const fingerprint = currentSupervisorFingerprint()
  if (allowCachedFallback && fingerprint) {
    const fresh = readFreshCachedHARole(userId, fingerprint)
    if (fresh) return fresh
  }

  const liveRole = currentRole(await readCurrentHACoreUsers(signal), userId)
  if (liveRole !== "unavailable") return liveRole

  if (allowCachedFallback && fingerprint) {
    const cached = await readOutageCachedHARole(userId, fingerprint)
    if (cached) return cached
  }
  return "unavailable"
}

/** Check Core's current role on a bounded connection (falls back to verified local cache during HA outage). */
export async function verifyCurrentHAAdministrator(userId: string, signal: AbortSignal): Promise<AdminVerification> {
  const role = await readCurrentHARole(userId, signal, { allowCachedFallback: true })
  return role === "admin" ? "allowed" : role === "unavailable" ? role : "denied"
}

/** Check active, nonsystem membership with resilient outage fallback. */
export async function verifyCurrentHAParticipant(userId: string, signal: AbortSignal): Promise<AdminVerification> {
  const role = await readCurrentHARole(userId, signal, { allowCachedFallback: true })
  return role === "admin" || role === "member" ? "allowed" : role
}

/** Whole-database custody is held by Home Assistant's current owner (strict live Core check). */
export async function verifyCurrentHAOwner(userId: string, signal: AbortSignal): Promise<AdminVerification> {
  const role = currentRole(await readCurrentHACoreUsers(signal), userId, true)
  return role === "admin" ? "allowed" : role === "unavailable" ? role : "denied"
}
