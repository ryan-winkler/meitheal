import { createHash } from "node:crypto"
import type { Client, InStatement, Transaction } from "@libsql/client"
import {
  isVerifiedPrincipalCurrent,
  requireBoardScope,
  type BoardScope,
  type VerifiedPrincipal,
  type WorkAction,
  validateBoardFeature,
  boardOperationClient,
  BoardOperationError,
  boardPlanningOwnership,
  boardOwnerInsertExpression,
  guardWorkPersistence,
  sql,
  sourceSql,
  type SqlFragment
} from "@domains/tasks"

export type PersonalPillarScope = Readonly<{
  kind: "personal_pillars"
  principal: VerifiedPrincipal
  ownerId: string
}>
export type PillarOwnerScope = BoardScope | PersonalPillarScope
const personalScopes = new WeakSet<PersonalPillarScope>()

/** Preserve existing immutable private ownership; only current verified identities can select it. */
export function personalPillarScope(principal: VerifiedPrincipal): PersonalPillarScope {
  if (
    !isVerifiedPrincipalCurrent(principal) ||
    !["ha_user", "local_operator"].includes(principal.kind)
  )
    throw new BoardOperationError("denied")
  const scope = Object.freeze({
    kind: "personal_pillars" as const,
    principal,
    ownerId: createHash("sha256")
      .update("pillar-owner:" + principal.id)
      .digest("hex")
  })
  personalScopes.add(scope)
  return scope
}

export function isPersonalPillarScope(owner: PillarOwnerScope): owner is PersonalPillarScope {
  return personalScopes.has(owner as PersonalPillarScope)
}
export function requirePillarOwner(owner: PillarOwnerScope): void {
  if (isPersonalPillarScope(owner)) {
    if (!isVerifiedPrincipalCurrent(owner.principal)) throw new BoardOperationError("stale")
  } else requireBoardScope(owner as BoardScope)
}
export function personalPillarOwnerId(owner: PersonalPillarScope): string {
  if (!personalScopes.has(owner) || !isVerifiedPrincipalCurrent(owner.principal))
    throw new BoardOperationError("stale")
  return owner.ownerId
}
export function pillarStorageOwner(owner: PillarOwnerScope): {
  userId: string
  boardId: SqlFragment | null
} {
  requirePillarOwner(owner)
  return isPersonalPillarScope(owner)
    ? { userId: owner.ownerId, boardId: null }
    : { userId: "default", boardId: boardOwnerInsertExpression(owner) }
}
export function pillarOwnedBy(owner: PillarOwnerScope, alias = "pillars"): SqlFragment {
  requirePillarOwner(owner)
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error("Source-owned Pillar alias required")
  const table = sourceSql(alias)
  return isPersonalPillarScope(owner)
    ? sql`${table}.owner_board_id IS NULL AND ${table}.user_id = ${owner.ownerId}`
    : sql`${boardPlanningOwnership(owner, alias)} AND ${table}.user_id = ${"default"}`
}

async function personalFeature(
  owner: PersonalPillarScope,
  db: Pick<Client, "execute">,
  feature: string
): Promise<void> {
  requirePillarOwner(owner)
  const { rows } = await db.execute({
    sql: "SELECT audience,selected_users FROM organization_access_policies WHERE scope='feature' AND scope_id=? AND board_id=''",
    args: [feature]
  })
  for (const row of rows) {
    if (row.audience === "everyone") continue
    let users: unknown
    try {
      users = JSON.parse(String(row.selected_users))
    } catch {
      throw new BoardOperationError("denied")
    }
    if (
      row.audience !== "selected" ||
      owner.principal.kind !== "ha_user" ||
      !Array.isArray(users) ||
      !users.includes(owner.principal.id)
    )
      throw new BoardOperationError("denied")
  }
  if (!rows.length) {
    const {
      rows: [setting]
    } = await db.execute({
      sql: "SELECT value FROM settings WHERE key=?",
      args: [`feature_${feature}`]
    })
    if (setting?.value === "false") throw new BoardOperationError("denied")
  }
}

/** Authorization wrapper only. Ownership is explicit in every service SQL statement. */
export function pillarOperationClient(
  client: Client,
  owner: PillarOwnerScope,
  action: WorkAction,
  feature = "pillars"
): Client {
  requirePillarOwner(owner)
  if (!isPersonalPillarScope(owner) && feature === "pillars")
    return boardOperationClient(client, owner, { resource: "pillar", action })
  const db = isPersonalPillarScope(owner)
    ? guardWorkPersistence(client)
    : boardOperationClient(client, owner, { resource: "pillar", action })
  const check = async (reader: Pick<Client, "execute">) => {
    if (isPersonalPillarScope(owner)) {
      await personalFeature(owner, reader, "pillars")
      if (feature !== "pillars") await personalFeature(owner, reader, feature)
    } else if (!(await validateBoardFeature(owner, reader, feature)))
      throw new BoardOperationError("denied")
  }
  async function transaction(
    mode: "read" | "write" | "deferred" = action === "read" ? "read" : "write"
  ): Promise<Transaction> {
    if (action === "read" && mode !== "read") throw new BoardOperationError("denied")
    await check(db)
    const tx = await db.transaction(mode)
    try {
      await check(tx)
    } catch (error) {
      tx.close()
      throw error
    }
    return new Proxy(tx, {
      get(target, key) {
        if (key === "execute" || key === "batch")
          return async (...args: unknown[]) => {
            await check(tx)
            const result = await (
              Reflect.get(target, key) as (...args: unknown[]) => Promise<unknown>
            ).apply(target, args)
            await check(tx)
            if (mode === "read") await check(db)
            return result
          }
        if (key === "commit")
          return async () => {
            await check(tx)
            if (mode === "read") await check(db)
            await tx.commit()
          }
        const value = Reflect.get(target, key)
        return typeof value === "function" ? value.bind(target) : value
      }
    })
  }
  async function run(statements: InStatement[], mode?: "read" | "write" | "deferred") {
    const tx = await transaction(mode)
    try {
      const result = await tx.batch(statements)
      await tx.commit()
      await check(db)
      return result
    } finally {
      tx.close()
    }
  }
  return new Proxy(db, {
    get(target, key) {
      if (key === "transaction") return transaction
      if (key === "execute") return async (statement: InStatement) => (await run([statement]))[0]
      if (key === "batch") return run
      if (key === "executeMultiple" || key === "migrate") throw new BoardOperationError("denied")
      const value = Reflect.get(target, key)
      return typeof value === "function" ? value.bind(target) : value
    }
  })
}
