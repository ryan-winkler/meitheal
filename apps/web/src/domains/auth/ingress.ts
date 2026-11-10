import { getIngressTransport, type IngressTransport } from "../../../scripts/ingress-transport.mjs"

const ingressPathPattern = /^(\/api\/hassio_ingress\/[A-Za-z0-9_-]{1,128})\/*$/
const userIdPattern = /^[A-Za-z0-9_-]{1,128}$/

export interface IngressContext {
  ingressPath?: string
  behindIngress: boolean
  hassUserId?: string
  hassIsAdmin: boolean
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
  return { ingressPath, behindIngress: true, hassUserId: userId, hassIsAdmin: groups?.includes("system-admin") ?? false }
}
