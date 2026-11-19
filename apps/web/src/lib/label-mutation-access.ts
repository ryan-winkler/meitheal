import { getPersistenceClient } from "@domains/tasks"
import { scopePermits, validateBoardScope, type BoardScope } from "@domains/tasks/board-scope"

export const labelMutationHeaders = { "cache-control": "private, no-store" }
export function labelMutationFailure(status: number, errorCode: string, detail: string) {
  return Response.json({ ok: false, errorCode, detail }, { status, headers: labelMutationHeaders })
}

export function labelMutationContextFailure(request: Request, locals: App.Locals, scope: BoardScope) {
  if (request.signal.aborted) return labelMutationFailure(499, "cancelled", "The label change was cancelled.")
  if (locals.agentToken || !["ha_user", "local_operator"].includes(scope.principal.kind) ||
    !scopePermits(scope, { resource: "board", action: "manage" })) {
    return labelMutationFailure(403, "denied", "Manage this Board to change its label definitions.")
  }
  return null
}

/** Recheck the exact Board manager, independently of application administration. */
export async function requireLabelBoardManager(request: Request, locals: App.Locals, scope: BoardScope) {
  const denied = labelMutationContextFailure(request, locals, scope)
  if (denied) return denied
  const current = await validateBoardScope(scope, getPersistenceClient(), { resource: "board", action: "manage" })
  return current.ok ? null : labelMutationFailure(current.errorCode === "stale" ? 409 : current.errorCode === "continuity_locked" ? 503 : 403,
    current.errorCode, "Board access changed. Refresh Labels before continuing.")
}
