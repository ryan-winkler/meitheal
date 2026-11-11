import { readCurrentHACoreUsers } from "./core-user-lookup"

type AdminVerification = "allowed" | "denied" | "unavailable"
type CurrentHARole = "admin" | "member" | "denied" | "unavailable"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function currentRole(result: unknown, userId: string): CurrentHARole {
  if (!Array.isArray(result)) return "unavailable"
  const matches = result.filter(user => isRecord(user) && user.id === userId)
  if (matches.length === 0) return "denied"
  if (matches.length !== 1) return "unavailable"
  const user = matches[0] as Record<string, unknown>
  if (typeof user.is_active !== "boolean" || typeof user.system_generated !== "boolean"
    || typeof user.is_owner !== "boolean" || !Array.isArray(user.group_ids)
    || !user.group_ids.every(group => typeof group === "string")) return "unavailable"

  if (!user.is_active || user.system_generated) return "denied"
  return user.is_owner || user.group_ids.includes("system-admin") ? "admin" : "member"
}

/** Resolve active membership and administrator status from the same Core response. */
export async function readCurrentHARole(userId: string, signal: AbortSignal): Promise<CurrentHARole> {
  return currentRole(await readCurrentHACoreUsers(signal), userId)
}

/** Check Core's current role on a bounded, uncached connection. */
export async function verifyCurrentHAAdministrator(userId: string, signal: AbortSignal): Promise<AdminVerification> {
  const role = await readCurrentHARole(userId, signal)
  return role === "admin" ? "allowed" : role === "unavailable" ? role : "denied"
}

/** Check active, nonsystem membership without using retained ingress roles. */
export async function verifyCurrentHAParticipant(userId: string, signal: AbortSignal): Promise<AdminVerification> {
  const role = await readCurrentHARole(userId, signal)
  return role === "admin" || role === "member" ? "allowed" : role
}
