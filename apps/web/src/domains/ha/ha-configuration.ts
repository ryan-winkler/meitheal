/** Resolve credentials without exposing them through status or logs. */
export interface HAConfiguration {
  baseUrl: string
  token: string
  source: "supervisor" | "settings" | "environment"
}

export function resolveHAConfiguration(
  env: { SUPERVISOR_TOKEN?: string; HA_BASE_URL?: string; HA_TOKEN?: string },
  settings: Record<string, unknown> = {},
): HAConfiguration | null {
  if (env.SUPERVISOR_TOKEN) return { baseUrl: "http://supervisor/core", token: env.SUPERVISOR_TOKEN, source: "supervisor" }
  const savedUrl = typeof settings.ha_url === "string" ? settings.ha_url.trim() : ""
  const savedToken = typeof settings.ha_token === "string" ? settings.ha_token.trim() : ""
  const saved = Boolean(savedUrl && savedToken)
  const baseUrl = saved ? savedUrl : env.HA_BASE_URL
  const token = saved ? savedToken : env.HA_TOKEN
  if (!baseUrl || !token) return null
  let url: URL
  try { url = new URL(baseUrl) } catch { throw new Error("Home Assistant URL must be a valid HTTP(S) URL") }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Home Assistant URL must use HTTP(S), without embedded credentials, query or fragment")
  }
  return { baseUrl: url.toString().replace(/\/+$/, ""), token, source: saved ? "settings" : "environment" }
}
