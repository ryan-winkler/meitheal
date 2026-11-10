import { getIngressTransport } from "../../scripts/ingress-transport.mjs"
import { apiProblem } from "./api-response"

export const REDACTED_SETTING_VALUE = "••••••••"

const credentialName = /(?:^|[-_])(?:api[-_]?key|credential|password|secret|token)(?:$|[-_])/i
const systemSettingPrefix = /^(?:agent[-_]protocols|ai|cal|caldav|calendar|grocy|ha|loki|n8n|todo|vikunja|webhook)[-_]/i
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"])
const localPeers = new Set(["127.0.0.1", "::1"])

export function isSecretSetting(key: string): boolean {
  return credentialName.test(key) || key.toLowerCase() === "license_key"
}

export function isSystemSetting(key: string): boolean {
  return isSecretSetting(key) || systemSettingPrefix.test(key) || key === "custom_theme_css" || key === "custom_theme_name"
}

/** Integration administration belongs to verified HA admins or local standalone operators. */
export function canManageSystemSettings(request: Request, locals: Pick<App.Locals, "hassIsAdmin" | "agentToken">): boolean {
  if (locals.agentToken) return false
  if (locals.hassIsAdmin) return true
  if (process.env.SUPERVISOR_TOKEN || !localHosts.has(new URL(request.url).hostname)) return false
  const peer = getIngressTransport()?.peer
  return peer ? localPeers.has(peer) : import.meta.env?.DEV === true
}

export function requireSystemSettingsAdmin(request: Request, locals: Pick<App.Locals, "hassIsAdmin" | "agentToken">): Response | null {
  if (canManageSystemSettings(request, locals)) return null
  return apiProblem({
    status: 403,
    title: "Admin Required",
    detail: "Use an administrator session in Home Assistant or manage standalone settings from the local machine.",
  })
}
