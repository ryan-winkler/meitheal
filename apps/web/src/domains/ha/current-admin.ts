import { openHACoreSocket } from "./ha-connection"

type AdminVerification = "allowed" | "denied" | "unavailable"
const timeoutMs = 3_000
const maxReplyBytes = 256 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function currentRole(result: unknown, userId: string): AdminVerification {
  if (!Array.isArray(result)) return "unavailable"
  const matches = result.filter(user => isRecord(user) && user.id === userId)
  if (matches.length === 0) return "denied"
  if (matches.length !== 1) return "unavailable"
  const user = matches[0] as Record<string, unknown>
  if (typeof user.is_active !== "boolean" || typeof user.system_generated !== "boolean"
    || typeof user.is_owner !== "boolean" || !Array.isArray(user.group_ids)
    || !user.group_ids.every(group => typeof group === "string")) return "unavailable"

  return user.is_active && !user.system_generated && (user.is_owner || user.group_ids.includes("system-admin"))
    ? "allowed"
    : "denied"
}

/** Check Core's current role on a bounded, uncached connection. */
export async function verifyCurrentHAAdministrator(userId: string, signal: AbortSignal): Promise<AdminVerification> {
  const token = process.env.SUPERVISOR_TOKEN
  if (!token || signal.aborted) return "unavailable"

  try {
    const socket = openHACoreSocket(token, { maxPayload: maxReplyBytes, perMessageDeflate: false })
    return await new Promise(resolve => {
      let phase: "challenge" | "auth" | "result" = "challenge"
      let settled = false
      const timer = setTimeout(unavailable, timeoutMs)
      function finish(result: AdminVerification) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener("abort", unavailable)
        socket.terminate()
        resolve(result)
      }
      function unavailable() { finish("unavailable") }
      signal.addEventListener("abort", unavailable, { once: true })
      socket.on("error", unavailable)
      socket.once("close", unavailable)
      socket.on("message", (data, binary) => {
        try {
          if (settled) return
          const message: unknown = binary ? null : JSON.parse(data.toString())
          if (!isRecord(message)) return unavailable()
          if (phase === "challenge" && message.type === "auth_required") {
            phase = "auth"
            socket.send(JSON.stringify({ type: "auth", access_token: token }))
          } else if (phase === "auth" && message.type === "auth_ok") {
            phase = "result"
            socket.send(JSON.stringify({ type: "config/auth/list", id: 1 }))
          } else if (phase === "result" && message.type === "result" && message.id === 1 && message.success === true) {
            finish(currentRole(message.result, userId))
          } else {
            unavailable()
          }
        } catch {
          unavailable()
        }
      })
    })
  } catch {
    return "unavailable"
  }
}
