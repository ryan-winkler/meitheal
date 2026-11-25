import { getIngressTransport } from "../../scripts/ingress-transport.mjs"
import { localReaderCacheToken } from "../../scripts/database-client.mjs"
import { readCurrentHARole } from "@domains/ha/current-admin"
import { cacheTrustedIngressUser, currentSupervisorFingerprint } from "@domains/ha/ha-user-cache"
import { BoardAccessService } from "@domains/tasks/board-access-service"
import { currentBoardGrantRevision } from "@domains/tasks/persistence/board-grant-fence"
import { ContinuityLockedError } from "@domains/tasks/persistence/continuity-client"
import {
  registerVerifiedPrincipal,
  principalProof,
  type ScopeResult,
  type VerifiedPrincipal,
  type WorkOperation
} from "@domains/tasks/board-scope"
import { ensureSchema, getPersistenceClient, listSharedGoals } from "@domains/tasks"
import { boardSessionProof } from "./named-board-request"
import { canManageSystemSettings } from "./settings-security"
import { verifiedIngressUser } from "./verified-ingress-user"
import { timingSafeEqual } from "node:crypto"

// In-request principal proofs must outlive normal SQLite writes and slow HA responses
// (middleware allows up to 25s for mutations) so requests never spuriously fail with 409 Conflict.
const PRINCIPAL_PROOF_TTL_MS = 30_000

type RequestContext = { request: Request; locals: App.Locals }
type RecordScope = {
  resource: "task" | "area" | "project" | "goal" | "routine" | "pillar"
  id: string
}
type RequestScopeOptions = {
  operation: WorkOperation
  boardId?: string | undefined
  record?: RecordScope | undefined
  write?: boolean
}
const ingressPrincipals = new WeakMap<Request, Map<boolean, Promise<VerifiedPrincipal | null>>>()
const requestPrincipals = new WeakMap<Request, Map<boolean, Promise<VerifiedPrincipal | null>>>()
const operatorIdentityCache = new WeakMap<object, { token: string; value: string | null }>()
const captureDefaultCache = new WeakMap<object, { token: string; preferences: unknown; fallback: unknown }>()

function validBrowserProof(request: Request, actorId: string): boolean {
  const presented = request.headers.get("x-meitheal-board-session")
  return Boolean(
    presented &&
      /^[a-f0-9]{64}$/.test(presented) &&
      timingSafeEqual(Buffer.from(presented, "hex"), Buffer.from(boardSessionProof(actorId), "hex"))
  )
}

/** Independently verify only genuine Supervisor identity, including when a token is primary. */
export function verifiedBoardIngressPrincipal(
  context: RequestContext,
  write = false
): Promise<VerifiedPrincipal | null> {
  let cache = ingressPrincipals.get(context.request)
  if (!cache) {
    cache = new Map()
    ingressPrincipals.set(context.request, cache)
  }
  let result = cache.get(write)
  if (!result) {
    result = loadIngressPrincipal(context, write)
    cache.set(write, result)
  }
  return result
}

function trustedIngressUser(locals: App.Locals) {
  // Removing token precedence here does not change global administrator checks.
  const identity = { ...locals }
  delete identity.agentToken
  return verifiedIngressUser(identity)
}

async function loadIngressPrincipal(
  { request, locals }: RequestContext,
  write: boolean
): Promise<VerifiedPrincipal | null> {
  const user = trustedIngressUser(locals)
  if (!user || (write && !validBrowserProof(request, user.id))) return null
  let role = await readCurrentHARole(user.id, request.signal, { allowCachedFallback: true })
  if (role === "denied") return null

  // If Home Assistant Core WebSocket is temporarily unreachable or restarting,
  // bootstrap/preserve access from the trusted Supervisor ingress identity
  // (already verified by Supervisor on this request) without letting revoked users back in.
  if (role === "unavailable") {
    const fingerprint = currentSupervisorFingerprint()
    if (fingerprint) {
      const cached = await cacheTrustedIngressUser({
        userId: user.id,
        displayName: locals.hassDisplayName,
        username: locals.hassUserName,
        isAdmin: user.isAdmin,
        fingerprint,
      })
      if (!cached) return null
      role = cached.role
    } else {
      role = user.isAdmin ? "admin" : "member"
    }
  }

  if (request.signal.aborted) return null
  return registerVerifiedPrincipal(
    { kind: "ha_user", id: user.id },
    {
      expiresAt: Date.now() + PRINCIPAL_PROOF_TTL_MS,
      administrator: role === "admin"
    }
  )
}

/** No request payload/header may claim a principal kind or bypass the trusted transport. */
export function verifiedBoardRequestPrincipal(
  context: RequestContext,
  write = false
): Promise<VerifiedPrincipal | null> {
  let cache = requestPrincipals.get(context.request)
  if (!cache) {
    cache = new Map()
    requestPrincipals.set(context.request, cache)
  }
  let principal = cache.get(write)
  if (!principal) {
    principal = loadPrincipal(context, write)
    cache.set(write, principal)
  }
  return principal
}

async function loadPrincipal(
  { request, locals }: RequestContext,
  write: boolean
): Promise<VerifiedPrincipal | null> {
  if (locals.agentToken) {
    const agent = locals.agentToken
    const transport = getIngressTransport()
    const ingress = Boolean(transport?.fromSupervisor && locals.behindIngress)
    const ingressPrincipal = ingress
      ? await verifiedBoardIngressPrincipal({ request, locals }, write)
      : null
    const ingressProof = ingressPrincipal ? principalProof(ingressPrincipal) : undefined
    if (ingress && (!ingressPrincipal || !ingressProof)) return null
    return registerVerifiedPrincipal(
      { kind: "agent", id: agent.tokenId, tokenId: agent.tokenId },
      {
        expiresAt: Date.now() + PRINCIPAL_PROOF_TTL_MS,
        administrator: false,
        tokenScopes: agent.scopes,
        assignedTo: agent.assigneeId,
        ...(ingressPrincipal ? { ingressPrincipal, expiresAt: ingressProof!.expiresAt } : {})
      }
    )
  }
  const user = trustedIngressUser(locals)
  if (user) return verifiedBoardIngressPrincipal({ request, locals }, write)
  if (!process.env.SUPERVISOR_TOKEN && canManageSystemSettings(request, locals)) {
    await ensureSchema()
    const db = getPersistenceClient()
    const state = localReaderCacheToken(db)
    let identityValue: string | null | undefined =
      state && operatorIdentityCache.get(state.owner)?.token === state.token
        ? operatorIdentityCache.get(state.owner)!.value
        : undefined
    if (identityValue !== undefined) {
      if (!(await currentBoardGrantRevision(db))) throw new ContinuityLockedError()
    } else {
      const {
        rows: [identity]
      } = await db.execute({
        sql: "SELECT value FROM app_settings WHERE key = 'local_operator_identity'",
        args: []
      })
      identityValue = typeof identity?.value === "string" && identity.value ? identity.value : null
      if (state && localReaderCacheToken(db)?.token === state.token) {
        operatorIdentityCache.set(state.owner, { token: state.token, value: identityValue })
      }
    }
    if (!identityValue) return null
    if (write && !validBrowserProof(request, identityValue)) return null
    return registerVerifiedPrincipal(
      { kind: "local_operator", id: identityValue },
      {
        expiresAt: Date.now() + PRINCIPAL_PROOF_TTL_MS,
        administrator: true
      }
    )
  }
  return null
}

function selector(request: Request, pathId?: string): { ok: true; id?: string } | { ok: false } {
  const url = new URL(request.url)
  const queryIds = url.searchParams.getAll("board_id")
  const aliasIds = url.searchParams.getAll("board")
  if (queryIds.length > 1 || aliasIds.length > 1) return { ok: false }
  const values = [
    pathId,
    request.headers.get("x-meitheal-board-id"),
    queryIds[0],
    aliasIds[0]
  ].filter((value) => value !== undefined && value !== null)
  if (
    values.some((value) => !value || value.length > 150 || value.includes("\0")) ||
    new Set(values).size > 1
  )
    return { ok: false }
  return { ok: true, ...(values[0] ? { id: values[0] } : {}) }
}

async function recordBoard(record: RecordScope): Promise<string | null> {
  const db = getPersistenceClient()
  const table = {
    task: "tasks",
    area: "areas",
    project: "projects",
    goal: "goals",
    routine: "task_templates",
    pillar: "pillars"
  }[record.resource]
  const owner = record.resource === "task" ? "task_board_id" : "owner_board_id"
  const key = record.resource === "task" ? normalizeTaskLocatorKey(record.id) : null
  const {
    rows: [row]
  } = await db.execute({
    sql: `SELECT COALESCE(record.${owner}, legacy.id) AS board_id FROM ${table} AS record
      LEFT JOIN task_boards AS legacy ON legacy.storage_encoding = 'legacy_null_v1'
      WHERE ${key !== null ? "(record.id = ? OR record.ticket_ref = ? OR (record.task_board_id IS NULL AND legacy.ticket_prefix || '-' || record.ticket_number = ?))" : "record.id = ?"}
      ${record.resource === "pillar" ? "AND record.user_id = 'default'" : ""}`,
    args: key !== null ? [record.id, key, key] : [record.id]
  })
  return typeof row?.board_id === "string" ? row.board_id : null
}

/** Preserve existing case-insensitive and zero-padded ticket bookmarks without changing opaque IDs. */
export function normalizeTaskLocatorKey(value: string): string | null {
  const match = /^([a-z][a-z0-9]{1,9}|[a-z2-7]{8})-(\d+)$/i.exec(value)
  const number = match ? Number(match[2]) : 0
  return match && Number.isSafeInteger(number) && number > 0
    ? `${match[1]!.toUpperCase()}-${number}`
    : null
}

async function captureDefault(principal: VerifiedPrincipal): Promise<string | null> {
  const db = getPersistenceClient()
  const state = localReaderCacheToken(db)
  let row: { preferences: unknown; fallback: unknown } | undefined =
    state && captureDefaultCache.get(state.owner)?.token === state.token
      ? captureDefaultCache.get(state.owner)
      : undefined
  if (row) {
    if (!(await currentBoardGrantRevision(db))) throw new ContinuityLockedError()
  } else {
    const { rows: [fetched] } = await db.execute(
      `SELECT (SELECT value FROM settings WHERE key = 'capture-board-preferences') AS preferences,
        (SELECT value FROM app_settings WHERE key = 'default_capture_board_id') AS fallback`
    )
    row = { preferences: fetched?.preferences ?? null, fallback: fetched?.fallback ?? null }
    if (state && localReaderCacheToken(db)?.token === state.token) {
      captureDefaultCache.set(state.owner, { token: state.token, ...row })
    }
  }
  try {
    const preferences = row.preferences == null ? null : JSON.parse(String(row.preferences))
    const preferred = preferences?.[`${principal.kind}:${principal.id}`]
    if (typeof preferred === "string" && preferred) return preferred
  } catch {
    /* An invalid preference does not choose a different Board. */ return null
  }
  return typeof row.fallback === "string" ? row.fallback : null
}

export async function resolveBoardRequestScope(
  context: RequestContext,
  options: RequestScopeOptions
): Promise<ScopeResult> {
  await ensureSchema()
  const selected = selector(context.request, options.boardId)
  if (!selected.ok) return { ok: false, errorCode: "unavailable" }
  const principal = await verifiedBoardRequestPrincipal(
    context,
    options.write ?? options.operation.action !== "read"
  )
  if (!principal) return { ok: false, errorCode: "denied" }
  let boardId = selected.id
  if (options.record) {
    const actual = await recordBoard(options.record)
    if (!actual) return { ok: false, errorCode: "unavailable" }
    if (boardId && boardId !== actual) {
      // Only an explicitly selected receiving Board may expose a shared Goal.
      // The projection verifies a current share and publishes no private source fields.
      if (
        options.record.resource !== "goal" ||
        options.operation.resource !== "goal" ||
        options.operation.action !== "read"
      )
        return { ok: false, errorCode: "unavailable" }
      const receiving = await new BoardAccessService(getPersistenceClient()).resolve(
        principal,
        boardId,
        options.operation
      )
      if (!receiving.ok) return receiving
      const shared = await listSharedGoals(
        getPersistenceClient(),
        receiving.scope,
        { goalId: options.record.id },
        context.request.signal
      )
      return shared.length ? receiving : { ok: false, errorCode: "unavailable" }
    }
    boardId = actual
  }
  boardId ??= (await captureDefault(principal)) ?? undefined
  if (!boardId) return { ok: false, errorCode: "unavailable" }
  return new BoardAccessService(getPersistenceClient()).resolve(
    principal,
    boardId,
    options.operation
  )
}
