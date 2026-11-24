import { verifyCurrentHAAdministrator } from "@domains/ha/current-admin"
import { ensureSchema, getPersistenceClient, SettingsRepository } from "@domains/tasks"
import { apiProblem } from "./api-response"
import { requireSystemSettingsAdmin } from "./settings-security"
import { verifiedIngressUser } from "./verified-ingress-user"

export const assistResponseHeaders = { "cache-control": "private, no-store" }

async function assistDisabledResponse(): Promise<Response | null> {
  await ensureSchema()
  const settings = await new SettingsRepository(getPersistenceClient()).getByKeys(["ai_assist_disabled"]).catch(() => ({} as Record<string, unknown>))
  const disabled = settings.ai_assist_disabled === true || settings.ai_assist_disabled === "true"
  if (!disabled) return null
  return new Response(
    JSON.stringify({
      type: "https://meitheal.local/problems/forbidden",
      title: "AI Assist Disabled",
      status: 403,
      detail: "AI Assist is disabled by an administrator.",
      error: "AI Assist is disabled by an administrator.",
      code: "ai_assist_disabled",
    }),
    {
      status: 403,
      headers: {
        "content-type": "application/problem+json",
        ...assistResponseHeaders,
      },
    },
  )
}

/** Assist executes with the App credential, so an ingress grant must still be current in Core. */
export async function requireAssistAdministrator(request: Request, locals: App.Locals): Promise<Response | null> {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) {
    denied.headers.set("cache-control", assistResponseHeaders["cache-control"])
    return denied
  }
  if (!process.env.SUPERVISOR_TOKEN) {
    return assistDisabledResponse()
  }

  const user = verifiedIngressUser(locals)
  const status = user?.isAdmin ? await verifyCurrentHAAdministrator(user.id, request.signal) : "denied"
  if (status === "allowed") return assistDisabledResponse()
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
