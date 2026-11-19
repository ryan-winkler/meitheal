import { getCurrentHAUserRoster } from "@domains/ha"
import { principalProof, requireBoardScope, scopePermits, type BoardScope } from "./board-scope"

declare const assignmentProofBrand: unique symbol
export type AssignmentProof = Readonly<{ readonly [assignmentProofBrand]: true }>
type AssignmentAdmission = Readonly<{
  boardId: string
  boardRevision: number
  authorityRevision: string
  principalKind: string
  principalId: string
  assigneeId: string
  expiresAt: number
}>
const admissions = new WeakMap<AssignmentProof, AssignmentAdmission>()

/** Resolve Core outside the SQLite writer; caller-supplied ids never constitute proof. */
export async function resolveHAAssignmentProof(
  scope: BoardScope,
  assigneeId: string,
  signal?: AbortSignal
): Promise<AssignmentProof | undefined> {
  requireBoardScope(scope)
  const actor = principalProof(scope.principal)
  if (
    !actor ||
    !(
      scopePermits(scope, { resource: "task", action: "assign" }) ||
      scopePermits(scope, { resource: "task", action: "create" })
    ) ||
    !assigneeId ||
    signal?.aborted
  )
    return
  const expiresAt = Math.min(actor.expiresAt, Date.now() + 5000)
  try {
    const roster = await getCurrentHAUserRoster(assigneeId, signal)
    if (
      !roster?.has(assigneeId) ||
      signal?.aborted ||
      Date.now() >= expiresAt ||
      !principalProof(scope.principal)
    )
      return
    const proof = Object.freeze({}) as AssignmentProof
    admissions.set(
      proof,
      Object.freeze({
        boardId: scope.boardId,
        boardRevision: scope.boardRevision,
        authorityRevision: scope.authorityRevision,
        principalKind: scope.principal.kind,
        principalId: scope.principal.id,
        assigneeId,
        expiresAt
      })
    )
    return proof
  } catch {
    return
  }
}

/** Pure writer-time proof check. No provider awaits or raw roster acceptance. */
export function assignmentProofMatches(
  proof: AssignmentProof | undefined,
  scope: BoardScope,
  assigneeId: string
): boolean {
  requireBoardScope(scope)
  const admission = proof && admissions.get(proof)
  return Boolean(
    admission &&
      principalProof(scope.principal) &&
      admission.expiresAt > Date.now() &&
      admission.boardId === scope.boardId &&
      admission.boardRevision === scope.boardRevision &&
      admission.authorityRevision === scope.authorityRevision &&
      admission.principalKind === scope.principal.kind &&
      admission.principalId === scope.principal.id &&
      admission.assigneeId === assigneeId
  )
}
