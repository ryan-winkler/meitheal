import { randomUUID } from "node:crypto"
import type { Client } from "@libsql/client"
import { BoardAccessService, validateBoardPlacement } from "./board-access-service"
import {
  principalProof,
  validateBoardScope,
  type VerifiedPrincipal,
  type BoardScope
} from "./board-scope"
import {
  readWorkDestinations,
  parseWorkDestinations,
  type WorkBinding
} from "./integration-destinations"
import { ownedPlanning } from "./persistence/board-storage"
import { sql } from "./persistence/sql-fragment"
import { changeBoardGrants } from "./persistence/board-grant-fence"

const coreIntegrations = new Set([
  "calendar",
  "calendar_reminder",
  "todo",
  "ha_events",
  "notification",
  "notification_action"
])
const coreKeys = new Set(["ha_url", "ha-url", "ha_token", "ha-token"])
const endpointKeys = new Set([
  "ha_url",
  "ha-url",
  "grocy_url",
  "caldav_url",
  "webhook_endpoint",
  "n8n_webhook_url"
])
const integrationKeys: Record<string, readonly string[]> = {
  calendar_reminder: ["calendar_", "calendar-", "cal_entity"],
  todo: ["todo_"],
  calendar: ["calendar_", "calendar-", "cal_entity"],
  caldav: ["caldav_"],
  grocy: ["grocy_"],
  webhook: ["webhook_", "n8n_"],
  notification: ["notification_"],
  notification_action: ["notification_"]
}
export function isWorkIntegrationSetting(key: string): boolean {
  return (
    coreKeys.has(key) ||
    Object.values(integrationKeys).some((prefixes) =>
      prefixes.some((prefix) => key.startsWith(prefix))
    )
  )
}
function profileAffects(integration: string, key: string): boolean {
  return (
    (coreIntegrations.has(integration) && coreKeys.has(key)) ||
    (integrationKeys[integration] ?? []).some((prefix) => key.startsWith(prefix)) ||
    (integration === "ha_events" && key.startsWith("n8n_"))
  )
}
function decoded(value: string | undefined): unknown {
  if (value === undefined) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
/** Compare persisted JSON values and historical scalar encodings without changing their bytes. */
export function sameWorkIntegrationSetting(
  left: string | undefined,
  right: string | undefined
): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, canonical(item)])
          )
        : value
  return JSON.stringify(canonical(decoded(left))) === JSON.stringify(canonical(decoded(right)))
}

declare const approvalBrand: unique symbol
export type WorkIntegrationSettingsApproval = Readonly<{ [approvalBrand]: true }>
type Approval = {
  principal: VerifiedPrincipal
  revision: string
  keys: readonly string[]
  values: ReadonlyMap<string, string | undefined>
  owners: readonly BoardScope[]
  expiresAt: number
}
const approvals = new WeakMap<WorkIntegrationSettingsApproval, Approval>()
async function profileValues(db: Pick<Client, "execute">, keys: readonly string[]) {
  const values = new Map<string, string | undefined>()
  for (const key of keys) {
    const {
      rows: [row]
    } = await db.execute({ sql: "SELECT value FROM settings WHERE key=?", args: [key] })
    values.set(key, typeof row?.value === "string" ? row.value : undefined)
  }
  return values
}

/** Finite preflight for remote key creation; contains no serializable authority or credentials. */
export async function prepareWorkIntegrationSettings(
  db: Client,
  principal: VerifiedPrincipal,
  keys: readonly string[]
): Promise<WorkIntegrationSettingsApproval | null> {
  const proof = principalProof(principal)
  if (
    !proof?.administrator ||
    !keys.length ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => !isWorkIntegrationSetting(key))
  )
    return null
  const expiresAt = Math.min(proof.expiresAt, Date.now() + 5_000)
  const configuration = await readWorkDestinations(db)
  if (!configuration) return null
  const affected = configuration.bindings.filter(
    (binding) => !binding.retired && keys.some((key) => profileAffects(binding.integration, key))
  )
  const owners: BoardScope[] = []
  for (const boardId of new Set(affected.map((binding) => binding.destination.boardId))) {
    const scope = await new BoardAccessService(db).resolve(principal, boardId, {
      resource: "board",
      action: "manage"
    })
    if (!scope.ok) return null
    owners.push(scope.scope)
  }
  const value = Object.freeze({}) as WorkIntegrationSettingsApproval
  approvals.set(value, {
    principal,
    revision: configuration.revision,
    keys: [...keys].sort(),
    values: await profileValues(db, keys),
    owners,
    expiresAt
  })
  return (await validateWorkIntegrationSettingsApproval(db, value)) ? value : null
}

export async function validateWorkIntegrationSettingsApproval(
  db: Pick<Client, "execute">,
  approval: WorkIntegrationSettingsApproval
): Promise<boolean> {
  const proof = approvals.get(approval)
  if (!proof || proof.expiresAt <= Date.now() || !principalProof(proof.principal)?.administrator)
    return false
  if ((await readWorkDestinations(db))?.revision !== proof.revision) return false
  const values = await profileValues(db, proof.keys)
  for (const key of proof.keys) if (values.get(key) !== proof.values.get(key)) return false
  for (const scope of proof.owners)
    if (!(await validateBoardScope(scope, db, { resource: "board", action: "manage" })).ok)
      return false
  return proof.expiresAt > Date.now() && Boolean(principalProof(proof.principal)?.administrator)
}

/** Journal the profile and all affected receiver identities in the same actual writer. */
export async function saveWorkIntegrationSettings(
  db: Client,
  principal: VerifiedPrincipal,
  entries: readonly { key: string; value: string }[],
  approval?: WorkIntegrationSettingsApproval
): Promise<boolean> {
  const admitted =
    approval ??
    (await prepareWorkIntegrationSettings(
      db,
      principal,
      entries.map((entry) => entry.key)
    ))
  if (!admitted) return false
  const proof = approvals.get(admitted)
  if (
    !proof ||
    proof.principal !== principal ||
    JSON.stringify([...entries.map((entry) => entry.key)].sort()) !== JSON.stringify(proof.keys)
  )
    return false
  const result = await changeBoardGrants(db, principal, async (tx) => {
    if (!(await validateWorkIntegrationSettingsApproval(tx, admitted))) return { unchanged: false }
    const current = await readWorkDestinations(tx)
    if (!current) return { unchanged: false }
    const changed = entries.filter(
      (entry) => !sameWorkIntegrationSetting(proof.values.get(entry.key), entry.value)
    )
    if (!changed.length) return { unchanged: true }
    const removed = new Set<string>()
    const replacements: WorkBinding[] = []
    const predecessors = new Map<string, string>()
    const bindings = current.bindings.map((binding) => {
      if (
        binding.retired ||
        !changed.some((entry) => profileAffects(binding.integration, entry.key))
      )
        return binding
      if (
        changed.some(
          (entry) => endpointKeys.has(entry.key) && profileAffects(binding.integration, entry.key)
        )
      ) {
        removed.add(binding.id)
        const replacement = { ...binding, id: randomUUID(), generation: 1 }
        replacements.push(replacement)
        predecessors.set(replacement.id, binding.id)
        return {
          ...binding,
          enabled: false,
          retired: true as const,
          generation: binding.generation + 1
        }
      }
      return { ...binding, generation: binding.generation + 1 }
    })
    const next = parseWorkDestinations({
      ...current,
      revision: randomUUID(),
      bindings: [...bindings, ...replacements]
    })
    if (!next) return { unchanged: false }
    for (const binding of replacements) {
      const {
        rows: [grant]
      } = await tx.execute({
        sql: "SELECT authority_limits,deny_completion,deny_deletion FROM board_access_grants WHERE principal_type='service' AND principal_id=? AND board_id=?",
        args: [predecessors.get(binding.id)!, binding.destination.boardId]
      })
      // A profile edit never broadens its owner's previously approved service ceiling.
      if (binding.enabled && grant)
        await tx.execute({
          sql: "INSERT INTO board_access_grants(board_id,principal_type,principal_id,role,authority_limits,deny_completion,deny_deletion) VALUES(?,'service',?,'service',?,?,?)",
          args: [
            binding.destination.boardId,
            binding.id,
            grant.authority_limits ?? null,
            grant.deny_completion ?? 0,
            grant.deny_deletion ?? 0
          ]
        })
    }
    for (const id of removed)
      await tx.execute({
        sql: "DELETE FROM board_access_grants WHERE principal_type='service' AND principal_id=?",
        args: [id]
      })
    for (const entry of entries)
      await tx.execute({
        sql: "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        args: [entry.key, entry.value, Date.now()]
      })
    await tx.execute({
      sql: "UPDATE settings SET value=?,updated_at=? WHERE key='work-destinations'",
      args: [JSON.stringify(next), Date.now()]
    })
    if (!principalProof(principal) || proof.expiresAt <= Date.now())
      throw new Error("Integration profile approval expired")
    for (const scope of proof.owners)
      if (!(await validateBoardScope(scope, tx, { resource: "board", action: "manage" })).ok)
        throw new Error("Integration profile approval changed")
    return { next: true }
  })
  return (result.status === "committed" || result.status === "unchanged") && result.result
}

const purposes: Record<string, readonly string[]> = {
  calendar_reminder: ["calendar.reminder"],
  todo: ["todo.sync"],
  calendar: ["calendar.sync"],
  caldav: ["calendar.sync"],
  grocy: ["grocy.sync"],
  webhook: ["webhook.delivery"],
  ha_events: ["webhook.delivery"],
  notification: ["notify.delivery"],
  notification_action: ["notify.task.complete"],
  builtin: ["builtin.overdue.observe", "builtin.reminders.observe", "builtin.inactivity.defer"],
  routine: ["builtin.routine.generate"],
  recurrence: ["builtin.recurrence.generate"]
}

/** Owner-reviewed receiver configuration. Authority metadata is never accepted by generic settings. */
export async function saveWorkBinding(
  db: Client,
  principal: VerifiedPrincipal,
  expectedRevision: string,
  input: WorkBinding
): Promise<{ ok: true; binding: WorkBinding } | { ok: false }> {
  if (
    !principalProof(principal) ||
    (input.integration !== "builtin" && !principalProof(principal)?.administrator) ||
    !purposes[input.integration]?.includes(input.purpose) ||
    input.retired ||
    (input.integration === "notification_action" &&
      (!/^notify\.mobile_app_[a-z0-9_]+$/.test(input.sourceId) ||
        !input.recipientUserIds?.length ||
        input.allowedOperations.length !== 2 ||
        !["read", "complete"].every((action) =>
          input.allowedOperations.some(
            (operation) => operation.resource === "task" && operation.action === action
          )
        ))) ||
    input.allowedOperations.some(
      (operation) =>
        operation.resource !== "task" ||
        !(
          input.purpose === "webhook.delivery" ||
          input.purpose === "notify.delivery" ||
          input.purpose === "calendar.reminder"
            ? ["read"]
            : input.integration === "notification_action"
              ? ["read", "complete"]
              : input.integration === "builtin"
                ? ["read", "edit"]
                : input.integration === "routine" || input.integration === "recurrence"
                  ? ["read", "create"]
                  : ["read", "create", "edit", "complete", "reopen", "delete"]
        ).includes(operation.action)
    )
  )
    return { ok: false }
  if (
    input.enabled &&
    (!input.allowedOperations.some(
      (operation) => operation.resource === "task" && operation.action === "read"
    ) ||
      (input.integration === "builtin" &&
        !input.allowedOperations.some(
          (operation) => operation.resource === "task" && operation.action === "edit"
        )))
  )
    return { ok: false }
  const builtinSource = {
    "builtin.overdue.observe": "overdue",
    "builtin.reminders.observe": "reminders",
    "builtin.inactivity.defer": "inactivity"
  }[input.purpose as "builtin.overdue.observe"]
  if (
    input.integration === "builtin" &&
    input.sourceId !== `builtin:${builtinSource}:${input.destination.boardId}`
  )
    return { ok: false }
  const configuration = await readWorkDestinations(db)
  if (!configuration || configuration.revision !== expectedRevision) return { ok: false }
  const previous = configuration.bindings.find((binding) => binding.id === input.id)
  if (previous?.retired) return { ok: false }
  const identity = (value: WorkBinding) =>
    JSON.stringify([
      value.integration,
      value.sourceId,
      value.purpose,
      value.destination.boardId,
      value.destination.areaId ?? null,
      value.destination.projectId ?? null
    ])
  const replaced = Boolean(previous && identity(previous) !== identity(input))
  const binding = {
    ...input,
    id: previous && !replaced ? previous.id : randomUUID(),
    generation: previous && !replaced ? previous.generation + 1 : 1
  }
  const candidate = parseWorkDestinations({
    ...configuration,
    revision: randomUUID(),
    bindings: [
      ...configuration.bindings.filter((item) => item.id !== previous?.id),
      ...(replaced && previous
        ? [{ ...previous, enabled: false, retired: true, generation: previous.generation + 1 }]
        : []),
      binding
    ]
  })
  if (!candidate) return { ok: false }
  const owners: BoardScope[] = []
  for (const boardId of new Set(
    [previous?.destination.boardId, binding.destination.boardId].filter((id): id is string =>
      Boolean(id)
    )
  )) {
    const scope = await new BoardAccessService(db).resolve(principal, boardId, {
      resource: "board",
      action: "manage"
    })
    if (!scope.ok) return { ok: false }
    owners.push(scope.scope)
  }
  const result = await changeBoardGrants(db, principal, async (tx) => {
    if ((await readWorkDestinations(tx))?.revision !== expectedRevision) return { unchanged: false }
    for (const scope of owners)
      if (!(await validateBoardScope(scope, tx, { resource: "board", action: "manage" })).ok)
        return { unchanged: false }
    const owner = owners.find((scope) => scope.boardId === binding.destination.boardId)!
    let areaId = binding.destination.areaId
    if (binding.destination.projectId) {
      const {
        rows: [project]
      } = await tx.execute(sql`SELECT project.area_id FROM projects AS project WHERE
        project.id=${binding.destination.projectId} AND ${ownedPlanning(owner, "project")} AND project.retired_at IS NULL`)
      if (!project || (areaId && project.area_id !== areaId)) return { unchanged: false }
      if (typeof project.area_id === "string") areaId = project.area_id
    }
    if (areaId) {
      const { rows } =
        await tx.execute(sql`SELECT area.id FROM areas AS area WHERE area.id=${areaId}
        AND ${ownedPlanning(owner, "area")} AND area.retired_at IS NULL`)
      if (!rows.length) return { unchanged: false }
    }
    if (
      !(await validateBoardPlacement(owner, tx, {
        areaId: areaId ?? null,
        projectId: binding.destination.projectId ?? null
      }))
    )
      return { unchanged: false }
    const {
      rows: [previousGrant]
    } = previous
      ? await tx.execute({
          sql: "SELECT deny_completion,deny_deletion FROM board_access_grants WHERE principal_type='service' AND principal_id=? AND board_id=?",
          args: [previous.id, previous.destination.boardId]
        })
      : { rows: [] }
    if (previous)
      await tx.execute({
        sql: "DELETE FROM board_access_grants WHERE principal_type='service' AND principal_id=?",
        args: [previous.id]
      })
    if (binding.enabled)
      await tx.execute({
        sql: "INSERT INTO board_access_grants(board_id,principal_type,principal_id,role,authority_limits,deny_completion,deny_deletion) VALUES(?,'service',?,'service',?,?,?)",
        args: [
          binding.destination.boardId,
          binding.id,
          JSON.stringify({ purpose: binding.purpose, operations: binding.allowedOperations }),
          previousGrant?.deny_completion ?? 0,
          previousGrant?.deny_deletion ?? 0
        ]
      })
    await tx.execute({
      sql: "UPDATE settings SET value=?,updated_at=? WHERE key='work-destinations'",
      args: [JSON.stringify(candidate), Date.now()]
    })
    for (const scope of owners)
      if (!(await validateBoardScope(scope, tx, { resource: "board", action: "manage" })).ok)
        throw new Error("Integration destination approval expired")
    return { next: true }
  })
  return result.status === "committed" && result.result ? { ok: true, binding } : { ok: false }
}
