import { createHash } from "node:crypto"
import { ownedPlanning } from "./persistence/board-storage"
import { sql } from "./persistence/sql-fragment"
import { parseWorkDestinations } from "./integration-destinations"
import { featureAudienceAllowed, organizationAudienceAllowed } from "./board-feature-policy"
import type { Client } from "@libsql/client"
import { boardGrantStillCurrent, currentBoardGrantRevision } from "./persistence/board-grant-fence"
import {
  principalProof,
  limitBoardScope,
  scopeLimits,
  scopePermits,
  validateBoardScope,
  scopeServiceBindingFingerprint,
  registerBoardScope,
  requireBoardScope,
  type BoardScope,
  type ScopeResult,
  type VerifiedPrincipal,
  type WorkAction,
  type WorkOperation,
  type WorkResource
} from "./board-scope"

const resources: WorkResource[] = [
  "board",
  "task",
  "area",
  "project",
  "goal",
  "routine",
  "pillar",
  "label"
]
const actions: WorkAction[] = [
  "read",
  "search",
  "create",
  "edit",
  "propose",
  "move",
  "assign",
  "complete",
  "reopen",
  "delete",
  "manage",
  "retire",
  "restore"
]
const management = new Set<WorkAction>(["manage", "retire", "restore"])

function parsed(value: unknown): Record<string, unknown> | null {
  try {
    const object: unknown = typeof value === "string" ? JSON.parse(value) : value
    return object !== null && typeof object === "object" && !Array.isArray(object)
      ? (object as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function includesOperation(value: unknown, operation: WorkOperation): boolean {
  return (
    Array.isArray(value) &&
    value.some(
      (item) =>
        item &&
        typeof item === "object" &&
        item.resource === operation.resource &&
        item.action === operation.action
    )
  )
}

function tokenAllows(scopes: readonly string[], operation: WorkOperation): boolean {
  if (operation.resource === "board")
    return operation.action === "read" && scopes.includes("tasks:read")
  if (operation.resource === "project")
    return scopes.includes(`projects:${operation.action === "read" ? "read" : "write"}`)
  // Existing token vocabulary intentionally does not expose arbitrary planning,
  // policy or Pillar commands just because a token has a Board grant.
  if (operation.resource !== "task") return false
  if (operation.action === "search")
    return scopes.includes("search:read") || scopes.includes("tasks:read")
  if (operation.action === "propose") return scopes.includes("tasks:propose")
  const required =
    operation.action === "read"
      ? "tasks:read"
      : operation.action === "delete"
        ? "tasks:delete"
        : "tasks:write"
  return (
    scopes.includes(required) ||
    (required === "tasks:write" && scopes.includes("tasks:write:assigned"))
  )
}

function audienceAllows(row: Record<string, unknown>, principal: VerifiedPrincipal): boolean {
  if (row.audience === "everyone") return true
  if (row.audience !== "selected" || principal.kind !== "ha_user") return false
  try {
    const users: unknown = JSON.parse(String(row.selected_users))
    return Array.isArray(users) && users.includes(principal.id)
  } catch {
    return false
  }
}

async function featureAllowed(
  principal: VerifiedPrincipal,
  db: Pick<Client, "execute">,
  feature: string
): Promise<boolean> {
  const {
    rows: [row]
  } = await db.execute(sql`SELECT ${featureAudienceAllowed(principal, feature)} AS allowed`)
  return row?.allowed === 1
}

export async function validateBoardFeature(
  scope: BoardScope,
  db: Pick<Client, "execute">,
  feature: string
): Promise<boolean> {
  requireBoardScope(scope)
  for (const current of [scope, ...scopeLimits(scope)]) {
    if (
      !principalProof(current.principal) ||
      !(await featureAllowed(current.principal, db, feature))
    )
      return false
  }
  return true
}

export async function validateBoardPlacement(
  scope: BoardScope,
  db: Pick<Client, "execute">,
  placement: { areaId?: string | null; projectId?: string | null }
): Promise<boolean> {
  requireBoardScope(scope)
  // Resolve a Project's actual Area under this same snapshot. A null direct Area
  // must never bypass the audience of its Project's parent. Existing retired or
  // dangling references remain historical data; create/move commands separately
  // require current active parents before writing a new placement.
  let effectiveArea = placement.areaId ?? null
  if (placement.projectId) {
    const {
      rows: [project]
    } = await db.execute(
      sql`SELECT area_id, ${ownedPlanning(scope, "projects")} AS owned FROM projects WHERE id=${placement.projectId}`
    )
    if (project && !project.owned) return false
    if (project && typeof project.area_id === "string") effectiveArea = project.area_id
  }
  if (effectiveArea) {
    const {
      rows: [area]
    } = await db.execute(
      sql`SELECT ${ownedPlanning(scope, "areas")} AS owned FROM areas WHERE id=${effectiveArea}`
    )
    if (area && !area.owned) return false
  }
  const { rows: policies } = await db.execute({
    sql: `SELECT audience, selected_users FROM organization_access_policies WHERE board_id = ? AND
      (scope = 'household' OR (scope = 'group' AND scope_id = ?) OR (scope = 'project' AND scope_id = ?))`,
    args: [scope.boardId, effectiveArea ?? "", placement.projectId ?? ""]
  })
  return [scope, ...scopeLimits(scope)].every(
    (current) =>
      Boolean(principalProof(current.principal)) &&
      policies.every((row) => audienceAllows(row, current.principal))
  )
}

/** Common authorization for every Board; storage encoding only selects SQL representation. */
export class BoardAccessService {
  constructor(private readonly db: Client) {}

  async resolve(
    principal: VerifiedPrincipal,
    boardId: string,
    operation: WorkOperation
  ): Promise<ScopeResult> {
    if (!boardId || boardId.length > 150 || !principalProof(principal))
      return { ok: false, errorCode: "unavailable" }
    const revision = await currentBoardGrantRevision(this.db)
    if (!revision) return { ok: false, errorCode: "continuity_locked" }
    const result = await this.select(this.db, principal, boardId, operation, revision)
    if (!result.ok) return result
    if (!(await boardGrantStillCurrent(this.db, revision))) return { ok: false, errorCode: "stale" }
    return result
  }

  async revalidate(
    scope: BoardScope,
    db: Pick<Client, "execute">,
    operation: WorkOperation
  ): Promise<ScopeResult> {
    requireBoardScope(scope)
    if (!principalProof(scope.principal)) return { ok: false, errorCode: "stale" }
    if (!(await boardGrantStillCurrent(db, scope.authorityRevision)))
      return { ok: false, errorCode: "stale" }
    const result = await this.select(
      db,
      scope.principal,
      scope.boardId,
      operation,
      scope.authorityRevision,
      false
    )
    if (!result.ok) return result
    if (
      result.scope.boardRevision !== scope.boardRevision ||
      scopeServiceBindingFingerprint(result.scope) !== scopeServiceBindingFingerprint(scope)
    )
      return { ok: false, errorCode: "stale" }
    for (const limit of scopeLimits(scope)) {
      const current = await validateBoardScope(limit, db, operation)
      if (!current.ok) return current
    }
    return { ok: true, scope }
  }

  async resolveInTransaction(
    principal: VerifiedPrincipal,
    boardId: string,
    operation: WorkOperation,
    db: Pick<Client, "execute">,
    revision: string
  ): Promise<ScopeResult> {
    if (!principalProof(principal) || !(await boardGrantStillCurrent(db, revision)))
      return { ok: false, errorCode: "stale" }
    return this.select(db, principal, boardId, operation, revision)
  }

  private async select(
    db: Pick<Client, "execute">,
    principal: VerifiedPrincipal,
    boardId: string,
    operation: WorkOperation,
    revision: string,
    includeCapabilities = true
  ): Promise<ScopeResult> {
    const proof = principalProof(principal)
    if (!proof) return { ok: false, errorCode: "stale" }
    const {
      rows: [row]
    } = await db.execute(sql`SELECT board.id, board.name, board.ticket_prefix, board.state, board.revision, board.visibility, board.storage_encoding,
          policy.shared_role, policy.shared_admin_management,
          policy.deny_completion AS board_deny_completion, policy.deny_deletion AS board_deny_deletion,
          policy.deny_agent_deletion, access.role, access.deny_completion, access.deny_deletion, access.authority_limits,
          NOT EXISTS (SELECT 1 FROM organization_access_policies AS board_policy
            WHERE board_policy.board_id = board.id AND (board_policy.scope = 'household' OR
              (board_policy.scope IN ('group', 'project') AND board_policy.scope_id = ''))
              AND NOT ${organizationAudienceAllowed(principal, "board_policy")}) AS audience_allowed
        FROM task_boards AS board JOIN board_permissions AS policy ON policy.board_id = board.id
        LEFT JOIN board_access_grants AS access ON access.board_id = board.id
          AND access.principal_type = ${principal.kind} AND access.principal_id = ${principal.id}
        WHERE board.id = ${boardId} AND EXISTS (
          SELECT 1 FROM board_access_epoch WHERE singleton = 1 AND revision = ${revision}
        )`)
    if (!row) return { ok: false, errorCode: "unavailable" }
    let role = typeof row.role === "string" ? row.role : null
    if (!role && principal.kind === "ha_user" && row.visibility === "shared") {
      role =
        row.shared_admin_management === 1 && proof.administrator ? "owner" : String(row.shared_role)
    }
    if (!role) return { ok: false, errorCode: "unavailable" }
    if (row.storage_encoding !== "legacy_null_v1" && row.storage_encoding !== "scoped_v1") {
      return { ok: false, errorCode: "continuity_locked" }
    }
    const limits = parsed(row.authority_limits)
    let tokenScopes: string[] | undefined
    let assignedTo: string | null | undefined
    if (principal.kind === "agent") {
      const {
        rows: [token]
      } = await db.execute({
        sql: "SELECT scopes, assignee_id, expires_at FROM agent_tokens WHERE id = ? AND revoked = 0",
        args: [principal.tokenId]
      })
      if (
        !token ||
        (token.expires_at !== null &&
          (!Number.isFinite(Date.parse(String(token.expires_at))) ||
            Date.parse(String(token.expires_at)) <= Date.now()))
      )
        return { ok: false, errorCode: "unavailable" }
      try {
        tokenScopes = JSON.parse(String(token.scopes))
      } catch {
        return { ok: false, errorCode: "unavailable" }
      }
      if (!Array.isArray(tokenScopes) || !tokenScopes.every((item) => typeof item === "string"))
        return { ok: false, errorCode: "unavailable" }
      if (!limits) return { ok: false, errorCode: "denied" }
      assignedTo =
        typeof limits.assignedTo === "string"
          ? limits.assignedTo
          : tokenScopes.includes("tasks:write:assigned") && !tokenScopes.includes("tasks:write")
            ? typeof token.assignee_id === "string"
              ? token.assignee_id
              : null
            : undefined
      if (
        Object.hasOwn(limits, "assignedTo") &&
        (typeof limits.assignedTo !== "string" || limits.assignedTo !== token.assignee_id)
      )
        assignedTo = null
      if (typeof assignedTo === "string") {
        const { rows: assignees } = await db.execute({
          sql: "SELECT 1 FROM custom_users WHERE id = ? AND kind = 'agent'",
          args: [assignedTo]
        })
        if (assignees.length !== 1) assignedTo = null
      }
    }
    let bindingOperations: unknown
    let servicePurpose: string | undefined
    let serviceSourceId: string | undefined
    let serviceDestination:
      | Readonly<{ boardId: string; areaId?: string; projectId?: string }>
      | undefined
    let serviceBindingFingerprint: string | undefined
    if (principal.kind === "service") {
      const {
        rows: [settings]
      } = await db.execute({
        sql: "SELECT value FROM settings WHERE key = 'work-destinations'",
        args: []
      })
      const configuration = parseWorkDestinations(settings?.value)
      const binding = configuration?.bindings.find((item) => item.id === principal.bindingId)
      if (
        !binding ||
        binding.enabled !== true ||
        binding.generation !== principal.bindingGeneration ||
        binding.destination?.boardId !== boardId
      )
        return { ok: false, errorCode: "unavailable" }
      serviceSourceId = binding.sourceId
      serviceDestination = binding.destination
      serviceBindingFingerprint = createHash("sha256").update(JSON.stringify(binding)).digest("hex")
      const physicalOwner = row.storage_encoding === "legacy_null_v1" ? null : boardId
      if (binding.destination.areaId) {
        const { rows } = await db.execute({
          sql: "SELECT 1 FROM areas WHERE id=? AND owner_board_id IS ? AND retired_at IS NULL",
          args: [binding.destination.areaId, physicalOwner]
        })
        if (rows.length !== 1) return { ok: false, errorCode: "unavailable" }
      }
      if (binding.destination.projectId) {
        const { rows } = await db.execute({
          sql: "SELECT area_id FROM projects WHERE id=? AND owner_board_id IS ? AND retired_at IS NULL",
          args: [binding.destination.projectId, physicalOwner]
        })
        if (
          rows.length !== 1 ||
          (binding.destination.areaId && rows[0]?.area_id !== binding.destination.areaId)
        )
          return { ok: false, errorCode: "unavailable" }
      }
      bindingOperations = binding.allowedOperations
      servicePurpose = typeof binding.purpose === "string" ? binding.purpose : undefined
      if (!servicePurpose || limits?.purpose !== servicePurpose)
        return { ok: false, errorCode: "denied" }
      if (!limits) return { ok: false, errorCode: "denied" }
    }
    const features: Partial<Record<WorkResource, string[]>> = {
      area: ["organizer", "groups"],
      project: ["organizer", "projects"],
      goal: ["goals"],
      routine: ["routines"],
      pillar: ["pillars"]
    }
    // Revalidation proves the requested effect; only initial resolution needs
    // the complete UI capability catalogue. This avoids multiplying unrelated
    // feature queries at every SQL/commit boundary.
    const requestedFeatures = includeCapabilities
      ? Object.values(features).flat()
      : (features[operation.resource] ?? [])
    const rights = new Map(
      await Promise.all(
        [...new Set(requestedFeatures)].map(
          async (feature) => [feature, await featureAllowed(principal, db, feature)] as const
        )
      )
    )
    const allowed = (intent: WorkOperation) => {
      if (intent.action === "search" && intent.resource !== "task") return false
      if (
        principal.kind === "agent" &&
        intent.resource === "task" &&
        !["read", "search"].includes(intent.action) &&
        assignedTo === null
      )
        return false
      if (!(features[intent.resource] ?? []).every((feature) => rights.get(feature))) return false
      if (
        row.state !== "active" &&
        !(intent.resource === "board" && ["read", "restore"].includes(intent.action))
      )
        return false
      if (!["read", "search"].includes(intent.action) && role === "viewer") return false
      if (
        (management.has(intent.action) ||
          (intent.resource === "board" && intent.action !== "read")) &&
        role !== "owner"
      )
        return false
      if (
        ["complete", "reopen"].includes(intent.action) &&
        (row.board_deny_completion === 1 || row.deny_completion === 1)
      )
        return false
      if (
        ["delete", "retire"].includes(intent.action) &&
        (row.board_deny_deletion === 1 ||
          row.deny_deletion === 1 ||
          (principal.kind === "agent" && row.deny_agent_deletion === 1))
      )
        return false
      if (
        principal.kind === "agent" &&
        (!tokenAllows(tokenScopes!, intent) ||
          !(
            includesOperation(limits?.operations, intent) ||
            (intent.action === "search" &&
              includesOperation(limits?.operations, { resource: "task", action: "read" }))
          ))
      )
        return false
      if (
        principal.kind === "service" &&
        (!includesOperation(limits?.operations, intent) ||
          !includesOperation(bindingOperations, intent))
      )
        return false
      return true
    }
    if (!allowed(operation) || row.audience_allowed !== 1 || !principalProof(principal))
      return { ok: false, errorCode: "denied" }
    const scope = registerBoardScope(
      {
        boardId,
        principal,
        authorityRevision: revision,
        boardRevision: Number(row.revision),
        capabilities: {
          operations: includeCapabilities
            ? resources
                .flatMap((resource) => actions.map((action) => ({ resource, action })))
                .filter(allowed)
            : [operation]
        }
      },
      {
        storageEncoding: row.storage_encoding,
        assignedTo,
        servicePurpose,
        serviceSourceId,
        serviceDestination,
        serviceBindingFingerprint,
        access: Object.freeze({
          id: boardId,
          name: String(row.name),
          ticketPrefix: String(row.ticket_prefix),
          state: row.state as "active" | "archived" | "retired",
          revision: Number(row.revision),
          role: role as "owner" | "member" | "viewer" | "service",
          denyCompletion: row.board_deny_completion === 1 || row.deny_completion === 1,
          denyDeletion:
            row.board_deny_deletion === 1 ||
            row.deny_deletion === 1 ||
            (principal.kind === "agent" && row.deny_agent_deletion === 1),
          ...(allowed({ resource: "board", action: "manage" })
            ? {
                policy: {
                  denyCompletion: row.board_deny_completion === 1,
                  denyDeletion: row.board_deny_deletion === 1,
                  denyAgentDeletion: row.deny_agent_deletion === 1,
                  visibility: row.visibility as "shared" | "restricted",
                  sharedRole: row.shared_role as "member" | "viewer",
                  sharedAdminManagement: row.shared_admin_management === 1
                }
              }
            : {})
        }),
        validate: (transaction, requested) => this.revalidate(scope, transaction, requested)
      }
    )
    if (includeCapabilities && proof.ingressPrincipal) {
      const limit = await this.select(db, proof.ingressPrincipal, boardId, operation, revision)
      if (!limit.ok) return limit
      const constrained = limitBoardScope(scope, limit.scope)
      if (!scopePermits(constrained, operation)) return { ok: false, errorCode: "denied" }
      return { ok: true, scope: constrained }
    }
    return { ok: true, scope }
  }
}
