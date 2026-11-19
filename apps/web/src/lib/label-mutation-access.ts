import { verifyCurrentHAAdministrator } from "@domains/ha"
import { getPersistenceClient, scopePermits, validateBoardScope, type BoardScope } from "@domains/tasks"

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

/** Recheck Board authority and the current Core role used for Household management. */
export async function requireLabelBoardManager(request: Request, locals: App.Locals, scope: BoardScope) {
  const denied = labelMutationContextFailure(request, locals, scope)
  if (denied) return denied
  if (scope.boardId === "household" && scope.principal.kind === "ha_user") {
    const status = await verifyCurrentHAAdministrator(scope.principal.id, request.signal)
    if (request.signal.aborted) return labelMutationFailure(499, "cancelled", "The label change was cancelled.")
    if (status === "unavailable") return labelMutationFailure(503, "unavailable", "Home Assistant could not verify administrator access. Try again.")
    if (status === "denied") return labelMutationFailure(403, "denied", "Only a current Home Assistant administrator can change Household labels.")
  }
  const current = await validateBoardScope(scope, getPersistenceClient(), { resource: "board", action: "manage" })
  return current.ok ? null : labelMutationFailure(current.errorCode === "stale" ? 409 : current.errorCode === "continuity_locked" ? 503 : 403,
    current.errorCode, "Board access changed. Refresh Labels before continuing.")
}
