import { getIngressTransport } from "../../scripts/ingress-transport.mjs"

export function verifiedIngressUser(locals: App.Locals): { id: string, isAdmin: boolean } | null {
  const transport = getIngressTransport()
  if (!transport?.fromSupervisor || !transport.identityHeadersSafe
    || !locals.behindIngress || !locals.hassUserId || locals.agentToken) {
    return null
  }
  return { id: locals.hassUserId, isAdmin: locals.hassIsAdmin }
}
