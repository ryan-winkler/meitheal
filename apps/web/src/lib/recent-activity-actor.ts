import {
  recentActivityPersonKey,
  sanitizeOriginKind,
  sanitizeOriginName,
  sanitizeOriginTarget,
  type RecentTaskActor,
  type VerifiedActivityProvenance,
} from "@domains/tasks/persistence/recent-activity"
import type { Locale } from "./locale"
import { verifiedIngressUser } from "./verified-ingress-user"

export interface ProvenanceLink {
  href: string
  label: string
  isInternal: boolean
  haTarget?: string
  isExternalHa: boolean
}

export function resolveRecentActivityActor(locals: App.Locals, request?: Request): RecentTaskActor {
  if (locals.agentToken) {
    const headers = request?.headers
    const originKind = sanitizeOriginKind(headers?.get("X-Meitheal-Origin-Kind")) ?? "agent_token"
    const originName = sanitizeOriginName(headers?.get("X-Meitheal-Origin-Name"))
    const originTarget = sanitizeOriginTarget(headers?.get("X-Meitheal-Origin-Target"))
    const provenance: VerifiedActivityProvenance = {
      tokenName: sanitizeOriginName(locals.agentToken.tokenName) ?? "Agent token",
      originKind,
      originName,
      originTarget,
    }
    return { kind: "agent", personKey: null, provenance }
  }
  const user = verifiedIngressUser(locals)
  if (user) return { kind: "human", personKey: recentActivityPersonKey(user.id) }
  return { kind: "system", personKey: null }
}

export function formatVerifiedAgentAuthor(provenance: VerifiedActivityProvenance): string {
  const tokenName = provenance.tokenName
  const originKind = provenance.originKind ?? "agent_token"
  const originName = provenance.originName

  if (originKind === "ha_automation" && originName) {
    const label = /^automation\b/i.test(originName) ? originName : `Automation "${originName}"`
    return `${label} (via token "${tokenName}")`
  }
  if (originKind === "ha_script" && originName) {
    const label = /^script\b/i.test(originName) ? originName : `Script "${originName}"`
    return `${label} (via token "${tokenName}")`
  }
  if (originName) {
    return `${originName} (via token "${tokenName}")`
  }
  if (originKind === "mcp") {
    return `MCP client (via token "${tokenName}")`
  }
  if (originKind === "webhook") {
    return `Webhook (via token "${tokenName}")`
  }
  return `Token "${tokenName}"`
}

export function resolveVerifiedProvenanceLink(
  provenance: VerifiedActivityProvenance,
  haBaseUrl: string | null,
  locale: Locale,
): ProvenanceLink {
  const safeTarget = sanitizeOriginTarget(provenance.originTarget)
  const isSettingsTarget = safeTarget !== null && (
    safeTarget === "/settings"
    || safeTarget.startsWith("/settings#")
    || safeTarget.startsWith("/settings?")
    || safeTarget.startsWith("/settings/")
  )
  if (safeTarget && !isSettingsTarget) {
    const label =
      provenance.originKind === "conversation_agent"
        ? (locale === "ga" ? "Oscail Cúntóirí Gutha" : "Open Voice Assistants")
        : provenance.originKind === "ha_automation"
          ? (locale === "ga" ? "Oscail uathoibriú" : "Open automation")
          : provenance.originKind === "ha_script"
            ? (locale === "ga" ? "Oscail script" : "Open script")
            : (locale === "ga" ? "Oscail foinse" : "Open source")
    return {
      href: haBaseUrl ? new URL(safeTarget, haBaseUrl).toString() : safeTarget,
      label,
      isInternal: false,
      ...(haBaseUrl ? {} : { haTarget: safeTarget }),
      isExternalHa: true,
    }
  }
  return {
    href: safeTarget ?? "/settings#agent-tokens-card",
    label: locale === "ga" ? "Bainistigh comharthaí gníomhaire" : "Manage agent tokens",
    isInternal: true,
    isExternalHa: false,
  }
}
