import { stripHtml } from "@lib/strip-html"
import { getIngressTransport, type IngressTransport } from "../../../scripts/ingress-transport.mjs"

const ingressPathPattern = /^(\/api\/hassio_ingress\/[A-Za-z0-9_-]{1,128})\/*$/
const userIdPattern = /^[A-Za-z0-9_-]{1,128}$/

export interface IngressContext {
  ingressPath?: string
  behindIngress: boolean
  hassUserId?: string
  hassDisplayName?: string
  hassUserName?: string
  hassIsAdmin: boolean
}

function sanitizeIngressHeaderName(raw: string | null): string | undefined {
  if (!raw) return undefined
  // Supervisor may pass UTF-8 or Latin-1 encoded display names; strip HTML/control chars safely.
  const cleaned = stripHtml(raw)
    .replace(/[<>\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, 128)
  return cleaned || undefined
}

export function resolveIngressContext(
  headers: Headers,
  transport: IngressTransport | undefined = getIngressTransport(),
): IngressContext {
  if (!transport?.fromSupervisor) return { behindIngress: false, hassIsAdmin: false }

  const path = transport.configuredPath ?? headers.get("x-ingress-path")
  const ingressPath = path?.match(ingressPathPattern)?.[1]
  if (!ingressPath) return { behindIngress: false, hassIsAdmin: false }

  const userId = headers.get("x-remote-user-id")
  if (!transport.identityHeadersSafe || !userId || !userIdPattern.test(userId)) {
    return { ingressPath, behindIngress: true, hassIsAdmin: false }
  }

  const groups = headers.get("x-remote-user-groups")?.split(",").map(group => group.trim())
  const hassDisplayName = sanitizeIngressHeaderName(headers.get("x-remote-user-display-name"))
  const hassUserName = sanitizeIngressHeaderName(headers.get("x-remote-user-name"))
  return {
    ingressPath,
    behindIngress: true,
    hassUserId: userId,
    ...(hassDisplayName ? { hassDisplayName } : {}),
    ...(hassUserName ? { hassUserName } : {}),
    hassIsAdmin: groups?.includes("system-admin") ?? false,
  }
}
