import type { Client } from "@libsql/client"
import { requireBoardScope, type BoardScope } from "../board-scope"
import { boardOperationClient } from "./board-operation-client"
import { IdentityRepository } from "./identity-repository"
export { customUserKind, type CustomUserKind } from "./identity-repository"

/** Board work preferences share the global identity catalogue but never a global work destination. */
export class UserRepository extends IdentityRepository {
  constructor(
    client: Client,
    private readonly scope: BoardScope
  ) {
    super(client)
    requireBoardScope(scope)
  }
  private get key() {
    return `default_assignee:${this.scope.boardId}`
  }
  async getDefaultAssigneeSetting(): Promise<string | null> {
    const {
      rows: [row]
    } = await boardOperationClient(this.client, this.scope, {
      resource: "task",
      action: "read"
    }).execute({ sql: "SELECT value FROM app_settings WHERE key=?", args: [this.key] })
    return typeof row?.value === "string" ? row.value : null
  }
  async setDefaultAssignee(userId: string): Promise<void> {
    await boardOperationClient(this.client, this.scope, {
      resource: "board",
      action: "manage"
    }).execute({
      sql: `INSERT INTO app_settings(key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
      args: [this.key, userId, Date.now()]
    })
  }
  async clearDefaultAssignee(): Promise<void> {
    await boardOperationClient(this.client, this.scope, {
      resource: "board",
      action: "manage"
    }).execute({ sql: "DELETE FROM app_settings WHERE key=?", args: [this.key] })
  }
}
