import type { APIRoute } from "astro"
import { z } from "zod"
import { verifyCurrentHAAdministrator } from "@domains/ha/current-admin"
import { resolveRecentActivityActor } from "@lib/recent-activity-actor"
import { verifiedIngressUser } from "@lib/verified-ingress-user"
import { TaskHandoff } from "@domains/tasks/persistence/task-handoff"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { apiProblem } from "@lib/api-response"
import { readHandoffRequest } from "@lib/handoff-request"
import { isCsrfAllowed } from "@domains/auth/ingress-policy"
import { formatTicketKey } from "@lib/ticket-key"
import { dispatchTaskEvent } from "@lib/webhook-dispatcher"

const inputSchema = z.strictObject({
  action: z.enum(["accept", "reject"]),
  proposal_hash: z.string().regex(/^[a-f0-9]{64}$/),
})
const headers = { "Cache-Control": "no-store" }

export const POST: APIRoute = async ({ request, locals, params }) => {
  if (locals.hassIsAdmin !== true || locals.agentToken) {
    return apiProblem({ status: 403, detail: "A Home Assistant administrator must review the proposal.", extraHeaders: headers })
  }
  const user = verifiedIngressUser(locals)
  if (!user?.isAdmin) return apiProblem({ status: 403, detail: "Open the review queue through authenticated Home Assistant ingress.", extraHeaders: headers })
  const authority = await verifyCurrentHAAdministrator(user.id, request.signal)
  if (authority !== "allowed") return apiProblem({ status: authority === "unavailable" ? 503 : 403,
    detail: authority === "unavailable" ? "Home Assistant could not verify administrator access. Try again." : "A current Home Assistant administrator must review the proposal.", extraHeaders: headers })
  const host = request.headers.get("host") ?? ""
  const origin = request.headers.get("origin")
  if (!isCsrfAllowed({
    behindIngress: false, isDev: false, host,
    origin, referer: origin ? null : request.headers.get("referer"),
  })) {
    return apiProblem({ status: 403, detail: "Open the review queue and submit the decision from the same site.", extraHeaders: headers })
  }
  const input = inputSchema.safeParse(await readHandoffRequest(request))
  if (!input.success) {
    return apiProblem({ status: 400, detail: "Provide an approval decision and the reviewed proposal hash.", extraHeaders: headers })
  }

  await ensureSchema()
  const client = getPersistenceClient()
  const result = await new TaskHandoff(client).decide(params.id!, input.data.proposal_hash, input.data.action, resolveRecentActivityActor(locals))
  if (!result.ok) return apiProblem({ status: result.status, detail: result.error, extraHeaders: headers })

  // Record the activity and dispatch the usual task update event.
  if (result.changes) {
    const repo = new TaskRepository(client)
    await repo.logActivity(result.id, Object.entries(result.changes).flatMap(([field, change]) =>
      change ? [{ field, oldValue: change.from, newValue: change.to }] : [],
    )).catch(() => {})
    void repo.findById(result.id).then(task => {
      if (task) return dispatchTaskEvent("task.updated", { ...task, ticket_key: formatTicketKey(Number(task.ticket_number) || null) })
    }).catch(() => {})
  }
  return Response.json({ ok: true, id: result.id, action: input.data.action }, { headers })
}
