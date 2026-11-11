import { readCurrentHACoreUsers } from "./core-user-lookup"

type AdminVerification = "allowed" | "denied" | "unavailable"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function currentRole(result: unknown, userId: string, requireAdmin = true): AdminVerification {
  if (!Array.isArray(result)) return "unavailable"
  const matches = result.filter(user => isRecord(user) && user.id === userId)
  if (matches.length === 0) return "denied"
  if (matches.length !== 1) return "unavailable"
  const user = matches[0] as Record<string, unknown>
  if (typeof user.is_active !== "boolean" || typeof user.system_generated !== "boolean"
    || typeof user.is_owner !== "boolean" || !Array.isArray(user.group_ids)
    || !user.group_ids.every(group => typeof group === "string")) return "unavailable"

  return user.is_active && !user.system_generated && (!requireAdmin || user.is_owner || user.group_ids.includes("system-admin"))
    ? "allowed"
    : "denied"
}

/** Check Core's current role on a bounded, uncached connection. */
export async function verifyCurrentHAAdministrator(userId: string, signal: AbortSignal): Promise<AdminVerification> {
  return currentRole(await readCurrentHACoreUsers(signal), userId)
}

/** Check active, nonsystem membership without using retained ingress roles. */
export async function verifyCurrentHAParticipant(userId: string, signal: AbortSignal): Promise<AdminVerification> {
  return currentRole(await readCurrentHACoreUsers(signal), userId, false)
}
