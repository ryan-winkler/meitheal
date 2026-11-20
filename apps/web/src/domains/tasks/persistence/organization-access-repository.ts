import { principalProof, type VerifiedPrincipal } from "../board-scope"
import { BoardOperationError } from "./board-operation-client"
import { randomUUID } from "node:crypto"
import type { Client } from "@libsql/client"
import {
  boardGrantStillCurrent,
  changeBoardGrants,
  currentBoardGrantRevision
} from "./board-grant-fence"

export type OrganizationAudience =
  | { audience: "everyone" | "nobody"; users: [] }
  | { audience: "selected"; users: string[] }

export type OrganizationScope = {
  scope: "feature" | "household" | "group" | "project"
  id: string
  boardId: string
}

export interface OrganizationPolicy extends OrganizationAudienceFields {
  scope: OrganizationScope
  revision: string
}
type OrganizationAudienceFields = { audience: OrganizationAudience["audience"]; users: string[] }

type PolicyChange = "saved" | "stale"
type ReadPolicies = { status: "current"; policies: OrganizationPolicy[] } | { status: "locked" }

export function allowsOrganizationAudience(
  policy: OrganizationAudienceFields | undefined,
  activeUserId: string | null
): boolean {
  return (
    !policy ||
    policy.audience === "everyone" ||
    (policy.audience === "selected" && activeUserId !== null && policy.users.includes(activeUserId))
  )
}

export function organizationAudienceContains(
  source: readonly OrganizationAudienceFields[],
  destination: readonly OrganizationAudienceFields[]
): boolean {
  function selected(policies: readonly OrganizationAudienceFields[]): ReadonlySet<string> | null {
    let result: Set<string> | null = null
    for (const policy of policies) {
      if (policy.audience === "nobody") return new Set()
      if (policy.audience === "selected") {
        const included = new Set(policy.users)
        if (result === null) result = included
        else for (const user of result) if (!included.has(user)) result.delete(user)
      }
    }
    return result
  }
  const original = selected(source)
  if (!original) return true
  const proposed = selected(destination)
  return proposed !== null && [...proposed].every((user) => original.has(user))
}

export class OrganizationAccessRepository {
  constructor(
    private readonly db: Client,
    private readonly marker?: string
  ) {}

  async policies(scope: OrganizationScope["scope"], boardId: string): Promise<ReadPolicies> {
    const revision = await currentBoardGrantRevision(this.db, this.marker)
    if (!revision) return { status: "locked" }
    const tx = await this.db.transaction("read")
    try {
      const { rows } = await tx.execute({
        sql: `SELECT scope_id, audience, selected_users, revision FROM organization_access_policies
          WHERE scope = ? AND board_id = ? ORDER BY scope_id`,
        args: [scope, boardId]
      })
      if (!(await boardGrantStillCurrent(tx, revision, this.marker))) return { status: "locked" }
      const policies = rows.map((row) => ({
        scope: { scope, id: String(row.scope_id), boardId },
        audience: row.audience as OrganizationAudience["audience"],
        users: JSON.parse(String(row.selected_users)) as string[],
        revision: String(row.revision)
      }))
      if (!(await boardGrantStillCurrent(this.db, revision, this.marker)))
        return { status: "locked" }
      return { status: "current", policies }
    } finally {
      tx.close()
    }
  }

  async change(
    scope: OrganizationScope,
    expectedRevision: string | null,
    value: OrganizationAudience | null,
    principal: VerifiedPrincipal
  ) {
    return changeBoardGrants<PolicyChange>(
      this.db,
      principal,
      async (tx) => {
        if (!principalProof(principal)?.administrator) throw new BoardOperationError("denied")
        const args = [scope.scope, scope.id, scope.boardId]
        const {
          rows: [current]
        } = await tx.execute({
          sql: "SELECT revision FROM organization_access_policies WHERE scope = ? AND scope_id = ? AND board_id = ?",
          args
        })
        if ((current?.revision ?? null) !== expectedRevision) return { unchanged: "stale" }
        if (!value) {
          if (!current) return { unchanged: "saved" }
          await tx.execute({
            sql: "DELETE FROM organization_access_policies WHERE scope = ? AND scope_id = ? AND board_id = ?",
            args
          })
        } else {
          await tx.execute({
            sql: `INSERT INTO organization_access_policies (scope, scope_id, board_id, audience, selected_users, revision)
            VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (scope, scope_id, board_id)
            DO UPDATE SET audience = excluded.audience, selected_users = excluded.selected_users, revision = excluded.revision`,
            args: [
              ...args,
              value.audience,
              JSON.stringify([...new Set(value.users)].sort()),
              randomUUID()
            ]
          })
        }
        return { next: "saved" }
      },
      this.marker
    )
  }
}
