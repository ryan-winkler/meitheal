import { getIngressTransport } from "../../scripts/ingress-transport.mjs"
import { apiProblem } from "./api-response"

export const REDACTED_SETTING_VALUE = "••••••••"

const credentialName = /(?:^|[-_])(?:api[-_]?key|private[-_]?key|credential|password|secret|token)(?:$|[-_])/i
const systemSettingPrefix = /^(?:agent[-_]protocols|ai|cal|caldav|calendar|grocy|ha|loki|n8n|plugin|todo|vikunja|webhook|webserver)[-_]/i
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"])
const localPeers = new Set(["127.0.0.1", "::1"])
const devPreviewHost = /(?:^|\.)(?:run\.app|googleusercontent\.com|usercontent\.goog|web\.app)$/i
const cloudRunPreviewHost = /^(?:ais-(?:dev|pre)-[a-z0-9-]+(?:\.[a-z0-9-]+)?\.run\.app|.*\.(?:googleusercontent\.com|usercontent\.goog))$/i

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
  if (process.env.SUPERVISOR_TOKEN) return false
  const hostname = new URL(request.url).hostname
  const isDev = import.meta.env?.DEV === true
  const isLocalHost = localHosts.has(hostname)
  const isDevPreviewHost = isDev && devPreviewHost.test(hostname)
  const isCloudRunPreviewHost = Boolean(process.env.K_SERVICE) && cloudRunPreviewHost.test(hostname)
  if (!isLocalHost && !isDevPreviewHost && !isCloudRunPreviewHost) return false
  if (isDevPreviewHost || isCloudRunPreviewHost) return true
  const peer = getIngressTransport()?.peer
  if (peer) return localPeers.has(peer)
  return isDev
}

export function requireSystemSettingsAdmin(request: Request, locals: Pick<App.Locals, "hassIsAdmin" | "agentToken">): Response | null {
  if (canManageSystemSettings(request, locals)) return null
  return apiProblem({
    status: 403,
    title: "Admin Required",
    detail: "Use an administrator session in Home Assistant or manage standalone settings from the local machine.",
  })
}
