import { readCurrentHARole } from "@domains/ha/current-admin"
import { apiProblem } from "./api-response"
import { canManageSystemSettings } from "./settings-security"
import { verifiedIngressUser } from "./verified-ingress-user"

const noStore = { "cache-control": "private, no-store" }

export async function currentSettingsAccess(request: Request, locals: App.Locals, requireAdmin: boolean): Promise<{ admin: boolean } | Response> {
  if (!process.env.SUPERVISOR_TOKEN && canManageSystemSettings(request, locals)) return { admin: true }

  const user = verifiedIngressUser(locals)
  if (user && (!requireAdmin || user.isAdmin)) {
    const role = await readCurrentHARole(user.id, request.signal)
    const admin = user.isAdmin && role === "admin"
    if (admin || (!requireAdmin && (role === "member" || role === "admin"))) return { admin }
    if (role === "unavailable") {
      return apiProblem({ status: 503, detail: "Home Assistant could not verify your current access. Check the Core connection and retry.", extraHeaders: noStore })
    }
  }
  return apiProblem({
    status: 403,
    detail: requireAdmin ? "Use a current Home Assistant administrator or local standalone operator session."
      : "Open Meitheal with an active Home Assistant household account or local standalone operator session.",
    extraHeaders: noStore,
  })
}
