import type { APIRoute } from "astro"
import { z } from "zod"
import { hasScope } from "@meitheal/domain-auth"
import { TaskHandoff } from "@domains/tasks/persistence/task-handoff"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { apiProblem } from "@lib/api-response"
import { readHandoffRequest } from "@lib/handoff-request"
import { sanitize } from "@lib/sanitize"

const lease = z.uuid()
const inputSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("claim") }),
  z.strictObject({ action: z.literal("release"), lease }),
  z.strictObject({
    action: z.literal("propose"),
    lease,
    summary: z.string().trim().min(1).max(500),
    updates: z.strictObject({
      title: z.string().trim().min(1).max(500).transform(sanitize).pipe(z.string().trim().min(1).max(500)).optional(),
      description: z.string().max(10_000).transform(sanitize).pipe(z.string().max(10_000)).optional(),
    }).refine(updates => updates.title !== undefined || updates.description !== undefined),
  }),
])
const headers = { "Cache-Control": "no-store" }

export const POST: APIRoute = async ({ request, locals, params }) => {
  const token = locals.agentToken
  if (!token) return apiProblem({
    status: 401, detail: "Use a Meitheal token with the tasks:propose scope.",
    extraHeaders: { ...headers, "WWW-Authenticate": "Bearer" },
  })
  if (!hasScope(token.scopes, "tasks:propose")) return apiProblem({
    status: 403, detail: "This token requires the tasks:propose scope.", extraHeaders: headers,
  })
  const input = inputSchema.safeParse(await readHandoffRequest(request))
  if (!input.success) return apiProblem({
    status: 400, detail: "Provide a claim, release, or propose action. Proposals require the claim lease, a summary, and a title or description update.",
    extraHeaders: headers,
  })

  await ensureSchema()
  const result = await new TaskHandoff(getPersistenceClient()).agentAction(params.id!, {
    id: token.tokenId, name: token.tokenName,
  }, input.data)
  return result.ok ? Response.json(result, { headers })
    : apiProblem({ status: result.status, detail: result.error, extraHeaders: headers })
}
