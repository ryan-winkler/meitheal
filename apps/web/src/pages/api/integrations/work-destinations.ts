import type { APIRoute } from "astro"
import { getPersistenceClient, readWorkDestinations, parseWorkDestinations, saveWorkBinding } from "@domains/tasks"
import { withBoardScope, boardScopeResponse } from "@lib/board-http"
import { resolveBoardRequestScope } from "@lib/board-request-context"
import { currentSettingsAccess } from "@lib/current-settings-access"
import { apiJson, apiError } from "@lib/api-response"

export const GET: APIRoute = withBoardScope({ resource: "board", action: "manage" }, async (_context, scope) => {
  const configuration = await readWorkDestinations(getPersistenceClient())
  if (!configuration) return apiError("Integration approval is unavailable.", 503)
  return apiJson({ revision: configuration.revision, bindings: configuration.bindings.filter(binding => binding.destination.boardId === scope.boardId) })
}, { write: false })

export const PUT: APIRoute = async context => {
  const selected = await resolveBoardRequestScope(context, { operation: { resource: "board", action: "manage" }, write: true })
  if (!selected.ok) return boardScopeResponse(selected.errorCode)
  const body: unknown = await context.request.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body)) return apiError("Review a source, destination and allowed actions.", 400)
  const input = body as Record<string, unknown>
  const candidate = parseWorkDestinations({ version: 1, revision: input.revision, bindings: [input.binding] })
  const binding = candidate?.bindings[0]
  if (!candidate || !binding || binding.destination.boardId !== selected.scope.boardId) return apiError("Choose this Board as the destination.", 400)
  const access = await currentSettingsAccess(context.request, context.locals, binding.integration !== "builtin")
  if (access instanceof Response) return access
  const saved = await saveWorkBinding(getPersistenceClient(), selected.scope.principal, candidate.revision, binding)
  if (!saved.ok) return apiError("Approval changed or this destination is unavailable. Refresh before saving.", 409)
  // This receipt reports the committed configuration only. The changed epoch
  // intentionally requires the client to refresh its work access before reuse.
  return apiJson({ ok: true, binding: saved.binding, refresh_required: true })
}
