import { verifyCurrentHAAdministrator } from "@domains/ha/current-admin"
import { canManageSystemSettings } from "./settings-security"
import { verifiedIngressUser } from "./verified-ingress-user"

export const labelMutationHeaders = { "cache-control": "private, no-store" }

export function labelMutationFailure(status: number, errorCode: string, detail: string) {
  return Response.json({ ok: false, errorCode, detail }, { status, headers: labelMutationHeaders })
}

export function labelMutationContextFailure(request: Request, locals: App.Locals) {
  if (request.signal.aborted) return labelMutationFailure(499, "cancelled", "The label change was cancelled.")
  const user = verifiedIngressUser(locals)
  if (!canManageSystemSettings(request, locals) || locals.agentToken ||
      (process.env.SUPERVISOR_TOKEN && (!user || !locals.ingressPath))) {
    return labelMutationFailure(403, "denied", "Open Labels with a current Home Assistant administrator account or a local standalone operator session.")
  }
  return null
}

/** Run after bounded body parsing, immediately before repository work. */
export async function requireLabelMutationAdministrator(request: Request, locals: App.Locals) {
  const denied = labelMutationContextFailure(request, locals)
  if (denied) return denied
  const user = verifiedIngressUser(locals)
  if (user) {
    const current = await verifyCurrentHAAdministrator(user.id, request.signal)
    if (request.signal.aborted) return labelMutationFailure(499, "cancelled", "The label change was cancelled.")
    if (current === "unavailable") return labelMutationFailure(503, "unavailable", "Home Assistant could not verify administrator access. Try again.")
    if (current !== "allowed") return labelMutationFailure(403, "denied", "Only a current Home Assistant administrator can change shared labels.")
  }
  return null
}
