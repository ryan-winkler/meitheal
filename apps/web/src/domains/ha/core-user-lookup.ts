import { openHACoreSocket } from "./ha-connection"

const timeoutMs = 3_000
const maxReplyBytes = 256 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Read the current Core users over a dedicated, time- and size-bounded socket. */
export async function readCurrentHACoreUsers(signal?: AbortSignal): Promise<unknown> {
  const token = process.env.SUPERVISOR_TOKEN
  if (!token || signal?.aborted) return undefined

  try {
    const socket = openHACoreSocket(token, { maxPayload: maxReplyBytes, perMessageDeflate: false })
    return await new Promise<unknown>(resolve => {
      let phase: "challenge" | "auth" | "result" = "challenge"
      let settled = false
      const timer = setTimeout(unavailable, timeoutMs)
      function finish(result: unknown) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener("abort", unavailable)
        socket.terminate()
        resolve(result)
      }
      function unavailable() { finish(undefined) }
      signal?.addEventListener("abort", unavailable, { once: true })
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
            finish(message.result)
          } else {
            unavailable()
          }
        } catch {
          unavailable()
        }
      })
    })
  } catch {
    return undefined
  }
}
