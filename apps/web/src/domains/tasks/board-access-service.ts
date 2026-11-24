import { createHash } from "node:crypto"
import { ownedPlanning, storageBoardId } from "./persistence/board-storage"
import { joinSql, sql } from "./persistence/sql-fragment"
import { parseWorkDestinations } from "./integration-destinations"
import { featureAudienceAllowed, organizationAudienceAllowed } from "./board-feature-policy"
import type { Client } from "@libsql/client"
import { localReaderCacheToken, tagBoardPolicyRead } from "../../../scripts/database-client.mjs"
import { boardGrantStillCurrent, currentBoardGrantRevision } from "./persistence/board-grant-fence"
import {
  principalProof,
  limitBoardScope,
  scopeAssignedTo,
  scopeLimits,
  scopePermits,
  validateBoardOperations,
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
const ALL_GATED_FEATURES = ["organizer", "groups", "projects", "goals", "routines", "pillars"] as const
const MAX_SNAPSHOT_ENTRIES = 256
const snapshotReads = new WeakMap<object, Map<string, { generation: string; value: unknown }>>()
type ReaderCacheToken = { owner: object; token: string }
type PlacementPolicySnapshot = { invalid: boolean; policies: Array<Record<string, unknown>> }
const placementSnapshotCache = new WeakMap<object, { token: string; entries: Map<string, PlacementPolicySnapshot> }>()

/**
 * Policy rows are a pure function of the principal and what one unchanged
 * SQLite view returns. Reuse them for the same reader until its data,
 * schema or own writes change. Every caller still evaluates the complete
 * decision, the grant marker, the live epoch and the principal proof.
 */
async function snapshotReadEntry<T>(
  db: Pick<Client, "execute">,
  principal: VerifiedPrincipal,
  key: string,
  read: () => Promise<T>,
  useCache = true,
  knownState?: ReaderCacheToken
): Promise<{ value: T; hit: boolean }> {
  if (!useCache || !principalProof(principal)) return { value: await read(), hit: false }
  const state = knownState ?? localReaderCacheToken(db)
  if (!state) return { value: await read(), hit: false }
  let values = snapshotReads.get(state.owner)
  if (!values) snapshotReads.set(state.owner, (values = new Map()))
  const cacheKey = `${principal.kind}\0${principal.id}\0${key}`
  const known = values.get(cacheKey)
  if (known?.generation === state.token) {
    values.delete(cacheKey)
    values.set(cacheKey, known)
    return { value: known.value as T, hit: true }
  }
  const value = await read()
  // Keep a result only if nothing changed while it was being read.
  if (localReaderCacheToken(db)?.token === state.token) {
    if (values.has(cacheKey)) values.delete(cacheKey)
    else if (values.size >= MAX_SNAPSHOT_ENTRIES) {
      const oldest = values.keys().next().value
      if (oldest !== undefined) values.delete(oldest)
    }
    values.set(cacheKey, { generation: state.token, value })
  } else {
    values.delete(cacheKey)
  }
  return { value, hit: false }
}

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

function agentHasOperationSnapshot(operations: unknown, intent: WorkOperation): boolean {
  if (includesOperation(operations, intent)) return true
  if (intent.action === "search" && includesOperation(operations, { resource: "task", action: "read" })) return true
  // Support legacy agent credentials minted before routine operations were snapshotted.
  if (intent.resource === "routine") {
    if (intent.action === "read") return includesOperation(operations, { resource: "task", action: "read" })
    if (intent.action === "create") return includesOperation(operations, { resource: "task", action: "create" })
    if (intent.action === "edit") {
      return (
        includesOperation(operations, { resource: "task", action: "create" }) &&
        includesOperation(operations, { resource: "task", action: "edit" })
      )
    }
    if (intent.action === "delete") return includesOperation(operations, { resource: "task", action: "delete" })
  }
  return false
}

function tokenAllows(scopes: readonly string[], operation: WorkOperation): boolean {
  if (operation.resource === "board")
    return operation.action === "read" && scopes.includes("tasks:read")
  if (operation.resource === "project")
    return scopes.includes(`projects:${operation.action === "read" ? "read" : "write"}`)
  if (operation.resource === "routine") {
    if (operation.action === "read") return scopes.includes("tasks:read")
    if (operation.action === "create" || operation.action === "edit") return scopes.includes("tasks:write")
    if (operation.action === "delete") return scopes.includes("tasks:delete")
    return false
  }
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

async function allowedFeaturesEntry(
  principal: VerifiedPrincipal,
  db: Pick<Client, "execute">,
  features: readonly string[],
  useCache = true,
  knownState?: ReaderCacheToken
): Promise<{ rights: Set<string>; hit: boolean }> {
  if (!features.length) return { rights: new Set(), hit: true }
  const entry = await snapshotReadEntry(
    db,
    principal,
    `features:${features.join(",")}`,
    async () => {
      const { rows } = await db.execute(joinSql(features.map(feature => sql`SELECT ${feature} AS feature,
        ${featureAudienceAllowed(principal, feature)} AS allowed`), " UNION ALL "))
      return rows.filter(row => row.allowed === 1).map(row => String(row.feature))
    },
    useCache,
    knownState
  )
  return { rights: new Set(entry.value), hit: entry.hit }
}

async function allowedFeatures(
  principal: VerifiedPrincipal,
  db: Pick<Client, "execute">,
  features: readonly string[],
  useCache = true
): Promise<Set<string>> {
  return (await allowedFeaturesEntry(principal, db, features, useCache)).rights
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
      !(await allowedFeatures(current.principal, db, [feature])).has(feature)
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
  const state = localReaderCacheToken(db)
  const cacheKey = `${scope.boardId}\0${storageBoardId(scope) ?? ""}\0${placement.areaId ?? ""}\0${placement.projectId ?? ""}`
  const existing = state ? placementSnapshotCache.get(state.owner) : undefined
  let snapshot = existing && existing.token === state!.token ? existing.entries.get(cacheKey) : undefined
  if (!snapshot) {
    // Resolve a Project's actual Area under this same snapshot. A null direct Area
    // must never bypass the audience of its Project's parent. Existing retired or
    // dangling references remain historical data; create/move commands separately
    // require current active parents before writing a new placement.
    let effectiveArea = placement.areaId ?? null
    let invalid = false
    if (placement.projectId) {
      const {
        rows: [project]
      } = await db.execute(
        sql`SELECT area_id, ${ownedPlanning(scope, "projects")} AS owned FROM projects WHERE id=${placement.projectId}`
      )
      if (project && !project.owned) invalid = true
      if (!invalid && project && typeof project.area_id === "string") effectiveArea = project.area_id
    }
    if (!invalid && effectiveArea) {
      const {
        rows: [area]
      } = await db.execute(
        sql`SELECT ${ownedPlanning(scope, "areas")} AS owned FROM areas WHERE id=${effectiveArea}`
      )
      if (area && !area.owned) invalid = true
    }
    let policies: Array<Record<string, unknown>> = []
    if (!invalid) {
      const result = await db.execute({
        sql: `SELECT audience, selected_users FROM organization_access_policies WHERE board_id = ? AND
          (scope = 'household' OR (scope = 'group' AND scope_id = ?) OR (scope = 'project' AND scope_id = ?))`,
        args: [scope.boardId, effectiveArea ?? "", placement.projectId ?? ""]
      })
      policies = result.rows as Array<Record<string, unknown>>
    }
    snapshot = { invalid, policies }
    if (state && localReaderCacheToken(db)?.token === state.token) {
      let holder = placementSnapshotCache.get(state.owner)
      if (!holder || holder.token !== state.token) {
        holder = { token: state.token, entries: new Map() }
        placementSnapshotCache.set(state.owner, holder)
      }
      if (holder.entries.has(cacheKey)) holder.entries.delete(cacheKey)
      else if (holder.entries.size >= MAX_SNAPSHOT_ENTRIES) {
        const oldest = holder.entries.keys().next().value
        if (oldest !== undefined) holder.entries.delete(oldest)
      }
      holder.entries.set(cacheKey, snapshot)
    }
  }
  if (snapshot.invalid) return false
  return [scope, ...scopeLimits(scope)].every(
    (current) =>
      Boolean(principalProof(current.principal)) &&
      snapshot.policies.every((row) => audienceAllows(row, current.principal))
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
    const result = await this.select(this.db, principal, boardId, [operation], revision)
    if (!result.ok) return result
    if (!(await boardGrantStillCurrent(this.db, revision))) return { ok: false, errorCode: "stale" }
    return result
  }

  async revalidate(
    scope: BoardScope,
    db: Pick<Client, "execute">,
    operation: WorkOperation | readonly WorkOperation[]
  ): Promise<ScopeResult> {
    requireBoardScope(scope)
    const operations = "resource" in operation ? [operation] : operation
    if (!operations.length) return { ok: false, errorCode: "denied" }
    if (!principalProof(scope.principal)) return { ok: false, errorCode: "stale" }
    if (!(await boardGrantStillCurrent(db, scope.authorityRevision)))
      return { ok: false, errorCode: "stale" }
    const result = await this.select(
      db,
      scope.principal,
      scope.boardId,
      operations,
      scope.authorityRevision,
      scope
    )
    if (!result.ok) return result
    for (const limit of scopeLimits(scope)) {
      const current = await validateBoardOperations(limit, db, operations)
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
    return this.select(db, principal, boardId, [operation], revision)
  }

  private async select(
    db: Pick<Client, "execute">,
    principal: VerifiedPrincipal,
    boardId: string,
    operations: readonly WorkOperation[],
    revision: string,
    existingScope?: BoardScope
  ): Promise<ScopeResult> {
    // Retry on mid-resolution token drift so unrelated concurrent writes (such as
    // gamification stats updates) trigger one fresh snapshot instead of a spurious error.
    const first = await this.selectSnapshot(db, principal, boardId, operations, revision, existingScope, true)
    if (first) return first
    const second = await this.selectSnapshot(db, principal, boardId, operations, revision, existingScope, true)
    if (second) return second
    const fallback = await this.selectSnapshot(db, principal, boardId, operations, revision, existingScope, false)
    return fallback ?? { ok: false, errorCode: "stale" }
  }

  private async selectSnapshot(
    db: Pick<Client, "execute">,
    principal: VerifiedPrincipal,
    boardId: string,
    operations: readonly WorkOperation[],
    revision: string,
    existingScope?: BoardScope,
    useCache = true
  ): Promise<ScopeResult | null> {
    const proof = principalProof(principal)
    if (!proof) return { ok: false, errorCode: "stale" }
    const tokenState = useCache ? localReaderCacheToken(db) : undefined
    const { value: row, hit: policyHit } = await snapshotReadEntry(db, principal, `policy:${boardId}\0${revision}`, async () => {
      const {
        rows: [policy]
      } = await db.execute(tagBoardPolicyRead(sql`SELECT board.id, board.name, board.ticket_prefix, board.state, board.revision, board.visibility, board.storage_encoding,
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
        )`))
      return policy
    }, useCache, tokenState)
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
    const requestedFeatures = !existingScope
      ? ALL_GATED_FEATURES
      : operations.flatMap(operation => features[operation.resource] ?? [])
    const uniqueFeatures = !existingScope || requestedFeatures.length <= 1
      ? requestedFeatures
      : [...new Set(requestedFeatures)]
    const { rights } = await allowedFeaturesEntry(
      principal,
      db,
      uniqueFeatures,
      useCache,
      policyHit && principal.kind !== "agent" && principal.kind !== "service" ? tokenState : undefined
    )
    const allowed = (intent: WorkOperation) => {
      if (intent.action === "search" && intent.resource !== "task") return false
      if (
        principal.kind === "agent" &&
        intent.resource === "routine" &&
        intent.action !== "read" &&
        assignedTo !== undefined
      )
        return false
      if (
        principal.kind === "agent" &&
        intent.resource !== "board" &&
        !["read", "search"].includes(intent.action) &&
        assignedTo === null
      )
        return false
      if (!(features[intent.resource] ?? []).every((feature) => rights.has(feature))) return false
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
        (!tokenAllows(tokenScopes!, intent) || !agentHasOperationSnapshot(limits?.operations, intent))
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
    if (!operations.every(allowed) || row.audience_allowed !== 1 || !principalProof(principal))
      return { ok: false, errorCode: "denied" }
    if (tokenState && localReaderCacheToken(db)?.token !== tokenState.token) {
      return null
    }
    if (existingScope) {
      const taskWrite = operations.some(
        (item) =>
          (item.resource === "task" || item.resource === "routine") &&
          item.action !== "read" &&
          item.action !== "search"
      )
      if (Number(row.revision) !== existingScope.boardRevision ||
        (taskWrite && assignedTo !== scopeAssignedTo(existingScope)) ||
        serviceBindingFingerprint !== scopeServiceBindingFingerprint(existingScope)) {
        return { ok: false, errorCode: "stale" }
      }
      return { ok: true, scope: existingScope }
    }
    const scope = registerBoardScope(
      {
        boardId,
        principal,
        authorityRevision: revision,
        boardRevision: Number(row.revision),
        capabilities: {
          operations: resources
            .flatMap((resource) => actions.map((action) => ({ resource, action })))
            .filter(allowed)
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
    if (proof.ingressPrincipal) {
      const limit = await this.selectSnapshot(db, proof.ingressPrincipal, boardId, operations, revision, undefined, useCache)
      if (!limit) return null
      if (!limit.ok) return limit
      const constrained = limitBoardScope(scope, limit.scope)
      if (!operations.every(operation => scopePermits(constrained, operation))) return { ok: false, errorCode: "denied" }
      if (tokenState && localReaderCacheToken(db)?.token !== tokenState.token) {
        return null
      }
      return { ok: true, scope: constrained }
    }
    return { ok: true, scope }
  }
}
