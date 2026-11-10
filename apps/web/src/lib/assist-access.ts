import { verifyCurrentHAAdministrator } from "@domains/ha/current-admin"
import { apiProblem } from "./api-response"
import { requireSystemSettingsAdmin } from "./settings-security"
import { verifiedIngressUser } from "./verified-ingress-user"

export const assistResponseHeaders = { "cache-control": "private, no-store" }

/** Assist executes with the App credential, so an ingress grant must still be current in Core. */
export async function requireAssistAdministrator(request: Request, locals: App.Locals): Promise<Response | null> {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) {
    denied.headers.set("cache-control", assistResponseHeaders["cache-control"])
    return denied
  }
  if (!process.env.SUPERVISOR_TOKEN) return null

  const user = verifiedIngressUser(locals)
  const status = user?.isAdmin ? await verifyCurrentHAAdministrator(user.id, request.signal) : "denied"
  if (status === "allowed") return null
  if (status === "unavailable") {
    return apiProblem({
      status: 503,
      detail: "Could not verify current administrator access with Home Assistant.",
      extraHeaders: assistResponseHeaders,
    })
  }
  return apiProblem({
    status: 403,
    detail: "Assist requires an active Home Assistant administrator.",
    extraHeaders: assistResponseHeaders,
  })
}
