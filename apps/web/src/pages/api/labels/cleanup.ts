import type { APIRoute } from "astro"
import { z } from "zod"
import { verifyCurrentHAAdministrator } from "@domains/ha/current-admin"
import { UnusedLabelRepository } from "@domains/labels"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { readWithinLimit } from "@lib/bounded-body"
import { canManageSystemSettings } from "@lib/settings-security"
import { verifiedIngressUser } from "@lib/verified-ingress-user"

const headers = { "cache-control": "private, no-store" }
const identifier = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const actions = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("preview"), afterId: identifier.nullable() }),
  z.strictObject({ action: z.literal("remove"), labels: z.array(z.strictObject({
    id: identifier, revision: z.string().regex(/^[a-f0-9]{64}$/),
  })).min(1).max(25).refine(labels => new Set(labels.map(label => label.id)).size === labels.length) }),
])

function failure(status: number, errorCode: string, detail: string, extra: Record<string, string> = {}) {
  return Response.json({ ok: false, errorCode, detail }, { status, headers: { ...headers, ...extra } })
}

function sameOrigin(request: Request, ingress: string | undefined): boolean {
  if (request.headers.get("sec-fetch-site") !== "same-origin" || request.headers.get("sec-fetch-mode") !== "same-origin") return false
  try {
    const source = new URL(request.headers.get("referer") ?? "")
    return (source.protocol === "http:" || source.protocol === "https:") && source.origin === request.headers.get("origin") &&
      (ingress ? source.pathname.startsWith(ingress + "/") : source.origin === new URL(request.url).origin)
  } catch {
    return false
  }
}

export const ALL: APIRoute = () => failure(405, "method", "Review label cleanup with a POST request.", { allow: "POST" })

export const POST: APIRoute = async ({ request, locals }) => {
  const user = verifiedIngressUser(locals)
  if (!canManageSystemSettings(request, locals) || locals.agentToken ||
      (process.env.SUPERVISOR_TOKEN && (!user || !locals.ingressPath)) || !sameOrigin(request, locals.ingressPath)) {
    return failure(403, "denied", "Open Labels in an administrator browser session.")
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return failure(415, "media", "Send label cleanup requests as application/json.")
  }
  const limit = 8 * 1024
  if (Number(request.headers.get("content-length")) > limit) return failure(413, "tooLarge", "Select at most 25 labels.")
  let parsed
  const reading = AbortSignal.any([request.signal, AbortSignal.timeout(5000)])
  try {
    const body = await readWithinLimit(request.body, limit, reading)
    if (!body) return failure(413, "tooLarge", "Select at most 25 labels.")
    parsed = actions.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)))
  } catch {
    if (request.signal.aborted) return failure(499, "cancelled", "The cleanup request was cancelled.")
    if (reading.aborted) return failure(503, "unavailable", "The cleanup request timed out. Review unused labels again.")
    return failure(400, "invalid", "Send a valid UTF-8 label cleanup action.")
  }
  if (!parsed.success) return failure(400, "invalid", "Preview unused labels before selecting up to 25 distinct labels.")
  if (user) {
    const current = await verifyCurrentHAAdministrator(user.id, request.signal)
    if (request.signal.aborted) return failure(499, "cancelled", "The cleanup request was cancelled.")
    if (current === "unavailable") return failure(503, "unavailable", "Home Assistant could not verify administrator access. Try again.")
    if (current !== "allowed") return failure(403, "denied", "Only a current Home Assistant administrator can clean up labels.")
  }
  if (request.signal.aborted) return failure(499, "cancelled", "The cleanup request was cancelled.")
  try {
    await ensureSchema()
    if (request.signal.aborted) return failure(499, "cancelled", "The cleanup request was cancelled.")
    const repository = new UnusedLabelRepository(getPersistenceClient())
    const action = parsed.data
    const result = action.action === "preview" ? await repository.preview(action.afterId) : await repository.remove(action.labels)
    if (!result.ok) {
      return result.errorCode === "stale"
        ? failure(409, "stale", "A selected label changed or is now in use. Review unused labels again.")
        : failure(409, "blocked", "Stored label selections need attention before cleanup. Check the Labels runbook.")
    }
    return Response.json(result, { headers })
  } catch {
    return failure(503, "unavailable", "Could not complete label cleanup. Review the current labels before trying again.")
  }
}
