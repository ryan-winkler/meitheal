import type { Client } from "@libsql/client"
import { createHash } from "node:crypto"

export type WorkResource =
  | "board"
  | "task"
  | "area"
  | "project"
  | "goal"
  | "routine"
  | "pillar"
  | "label"
export type WorkAction =
  | "read"
  | "search"
  | "create"
  | "edit"
  | "propose"
  | "move"
  | "assign"
  | "complete"
  | "reopen"
  | "delete"
  | "manage"
  | "retire"
  | "restore"
export type WorkOperation = Readonly<{ resource: WorkResource; action: WorkAction }>
export type BoardCapabilities = Readonly<{ operations: readonly WorkOperation[] }>
export type VerifiedPrincipal = Readonly<
  | { kind: "ha_user"; id: string }
  | { kind: "agent"; id: string; tokenId: string }
  | { kind: "service"; id: string; bindingId: string; bindingGeneration: number }
  | { kind: "local_operator"; id: string }
>
export type BoardScope = Readonly<{
  boardId: string
  principal: VerifiedPrincipal
  authorityRevision: string
  boardRevision: number
  capabilities: BoardCapabilities
}>
export type ScopeFailure = "unavailable" | "denied" | "continuity_locked" | "stale"
export type BoardAccessView = Readonly<{
  id: string
  name: string
  ticketPrefix: string
  state: "active" | "archived" | "retired"
  revision: number
  role: "owner" | "member" | "viewer" | "service"
  denyCompletion: boolean
  denyDeletion: boolean
  policy?: {
    denyCompletion: boolean
    denyDeletion: boolean
    denyAgentDeletion: boolean
    visibility: "shared" | "restricted"
    sharedRole: "member" | "viewer"
    sharedAdminManagement: boolean
  }
}>
export type ScopeResult = { ok: true; scope: BoardScope } | { ok: false; errorCode: ScopeFailure }
export type TaskPlacement = {
  areaId: string | null
  projectId: string | null
  goalId: string | null
}
export type WorkspaceContext = { boardId: string; areaId?: string; projectId?: string }

type PrincipalProof = {
  expiresAt: number
  administrator: boolean
  tokenScopes?: readonly string[]
  assignedTo?: string | null | undefined
  ingressPrincipal?: VerifiedPrincipal
}
type ScopeState = {
  storageEncoding: "legacy_null_v1" | "scoped_v1"
  assignedTo?: string | null | undefined
  servicePurpose?: string | undefined
  serviceSourceId?: string | undefined
  serviceDestination?:
    | Readonly<{ boardId: string; areaId?: string; projectId?: string }>
    | undefined
  serviceBindingFingerprint?: string | undefined
  access: BoardAccessView
  limitedBy?: readonly BoardScope[]
  intakeSubmission?: Readonly<{
    intakeId: string
    laneId: string
    recipientUserId: string | null
    status: string
  }>
  validate: (db: Pick<Client, "execute">, operation: WorkOperation) => Promise<ScopeResult>
}
const principals = new WeakMap<VerifiedPrincipal, PrincipalProof>()
const scopes = new WeakMap<BoardScope, ScopeState>()
const fencedScopeReaders = new WeakMap<object, (scope: BoardScope, operation: WorkOperation) => Promise<ScopeResult>>()

/** Only continuity adapters register their metadata-only validation path. */
export function registerFencedScopeReader(
  reader: Pick<Client, "execute">,
  validate: (scope: BoardScope, operation: WorkOperation) => Promise<ScopeResult>
): void {
  fencedScopeReaders.set(reader, validate)
}

// Internal factories: deliberately omitted from the tasks public barrel. Only the
// trusted HTTP/automation adapters may register independently verified identities.
export function registerVerifiedPrincipal(
  principal: VerifiedPrincipal,
  proof: PrincipalProof
): VerifiedPrincipal {
  const value = Object.freeze({ ...principal }) as VerifiedPrincipal
  if (
    proof.ingressPrincipal &&
    (value.kind !== "agent" ||
      proof.ingressPrincipal.kind !== "ha_user" ||
      !principalProof(proof.ingressPrincipal))
  )
    throw new Error("Current verified ingress participant required")
  principals.set(value, Object.freeze({ ...proof }))
  return value
}

export function principalProof(principal: VerifiedPrincipal): PrincipalProof | undefined {
  const proof = principals.get(principal)
  return proof &&
    proof.expiresAt > Date.now() &&
    (!proof.ingressPrincipal || principalProof(proof.ingressPrincipal))
    ? proof
    : undefined
}

export function registerBoardScope(scope: BoardScope, state: ScopeState): BoardScope {
  if (!principalProof(scope.principal)) throw new Error("Verified Board principal required")
  const value = Object.freeze({
    ...scope,
    capabilities: Object.freeze({
      operations: Object.freeze(
        scope.capabilities.operations.map((operation) => Object.freeze({ ...operation }))
      )
    })
  })
  scopes.set(value, state)
  return value
}

export function requireBoardScope(scope: BoardScope): void {
  if (!scopes.has(scope)) throw new Error("A verified BoardScope is required")
}

/** Internal, restrictive intersection; never exported through the public barrel. */
export function limitBoardScope(primary: BoardScope, limit: BoardScope): BoardScope {
  requireBoardScope(primary)
  requireBoardScope(limit)
  if (
    primary.principal.kind !== "agent" ||
    principalProof(primary.principal)?.ingressPrincipal !== limit.principal ||
    limit.principal.kind !== "ha_user" ||
    primary.boardId !== limit.boardId ||
    primary.authorityRevision !== limit.authorityRevision ||
    primary.boardRevision !== limit.boardRevision ||
    scopeLimits(primary).length ||
    scopeLimits(limit).length
  )
    throw new Error("Matching verified Board authority required")
  const state = scopes.get(primary)!
  const limitingAccess = scopeBoardAccess(limit)
  return registerBoardScope(
    {
      ...primary,
      capabilities: {
        operations: primary.capabilities.operations.filter((operation) =>
          scopePermits(limit, operation)
        )
      }
    },
    {
      ...state,
      limitedBy: Object.freeze([limit]),
      access: Object.freeze({
        ...state.access,
        denyCompletion: state.access.denyCompletion || limitingAccess.denyCompletion,
        denyDeletion: state.access.denyDeletion || limitingAccess.denyDeletion
      })
    }
  )
}

export function scopeLimits(scope: BoardScope): readonly BoardScope[] {
  requireBoardScope(scope)
  return scopes.get(scope)!.limitedBy ?? []
}

/** Internal physical storage descriptor; never serialize or export from index.ts. */
export function boardScopeStorage(scope: BoardScope): ScopeState["storageEncoding"] {
  requireBoardScope(scope)
  return scopes.get(scope)!.storageEncoding
}

/** Undefined means no assignment ceiling; null means no eligible assigned identity. */
export function scopeAssignedTo(scope: BoardScope): string | null | undefined {
  requireBoardScope(scope)
  return scopes.get(scope)!.assignedTo
}

export function scopeServicePurpose(scope: BoardScope): string | undefined {
  requireBoardScope(scope)
  return scopes.get(scope)!.servicePurpose
}

/** Private provider placement ceiling proved from its current persisted binding. */
export function scopeServiceSourceId(scope: BoardScope): string | undefined {
  requireBoardScope(scope)
  return scopes.get(scope)!.serviceSourceId
}

export function scopeServiceDestination(
  scope: BoardScope
): Readonly<{ boardId: string; areaId?: string; projectId?: string }> | undefined {
  requireBoardScope(scope)
  return scopes.get(scope)!.serviceDestination
}
export function scopeServiceBindingFingerprint(scope: BoardScope): string | undefined {
  requireBoardScope(scope)
  return scopes.get(scope)!.serviceBindingFingerprint
}

export function scopeBoardAccess(scope: BoardScope): BoardAccessView {
  requireBoardScope(scope)
  return scopes.get(scope)!.access
}

/** Private command ceiling for a sender; never a readable Board membership. */
export function scopeIntakeSubmission(scope: BoardScope): ScopeState["intakeSubmission"] {
  requireBoardScope(scope)
  return scopes.get(scope)!.intakeSubmission
}

/** Existing comment/reaction ownership keys retain their durable actor identity. */
export function scopeCommentOwnerKey(scope: BoardScope): string | null {
  requireBoardScope(scope)
  if (scope.principal.kind !== "ha_user" && scope.principal.kind !== "agent") return null
  const kind = scope.principal.kind === "ha_user" ? "home-assistant" : "automation"
  return createHash("sha256").update(`comment-owner:${kind}:${scope.principal.id}`).digest("hex")
}

export function scopeMentionRecipientKey(scope: BoardScope): string | null {
  requireBoardScope(scope)
  return scope.principal.kind === "ha_user"
    ? createHash("sha256")
        .update(`comment-mention:${scope.principal.id}`)
        .digest("hex")
        .slice(0, 32)
    : null
}

export async function validateBoardScope(
  scope: BoardScope,
  db: Pick<Client, "execute">,
  operation: WorkOperation
): Promise<ScopeResult> {
  requireBoardScope(scope)
  const fenced = fencedScopeReaders.get(db)
  if (fenced) return fenced(scope, operation)
  const result = await scopes.get(scope)!.validate(db, operation)
  if (!result.ok) return result
  for (const limit of scopeLimits(scope)) {
    const current = await validateBoardScope(limit, db, operation)
    if (!current.ok) return current
  }
  return { ok: true, scope }
}

export function scopePermits(scope: BoardScope, operation: WorkOperation): boolean {
  requireBoardScope(scope)
  return scope.capabilities.operations.some(
    (item) => item.resource === operation.resource && item.action === operation.action
  )
}
