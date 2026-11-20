import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { currentBoardScope, fixturePrincipal } from "../helpers/current-board-scope"
import { taskActionHints } from "../../apps/web/src/domains/tasks/task-action-hints"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { IdentityRepository } from "../../apps/web/src/domains/tasks/persistence/identity-repository"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { verifiedBoardRequestPrincipal } from "../../apps/web/src/lib/board-request-context"
import { generateAgentToken, type AgentScope } from "../../packages/domain-auth/src/index"
import { ensureAgentTokenSchema, createAgentToken } from "../../apps/web/src/domains/auth/agent-token-store"
import { resolveAgentAuth } from "../../apps/web/src/lib/agent-token-guard"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import type { WorkAction } from "../../apps/web/src/domains/tasks/board-scope"

let directory: string, previousUrl: string | undefined
const transport = { peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-r52-hints-")); previousUrl = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "work.db")}`; await ensureSchema()
})
test.afterEach(async () => {
  resetPersistenceForTests()
  if (previousUrl === undefined) delete process.env.MEITHEAL_DB_URL; else process.env.MEITHEAL_DB_URL = previousUrl
  await rm(directory, { recursive: true, force: true })
})
for (const encoding of ["legacy", "scoped"] as const) {
  test(`action hints use minted child/viewer capabilities, independent deletion and no database work: ${encoding}`, async () => {
    const db = getPersistenceClient(), owner = fixturePrincipal(), boards = new NamedBoardRepository(db), created = await boards.create(owner, "Hints")
    if (created.status !== "committed") throw new Error("Board required")
    const board = encoding === "legacy" ? "household" : created.result.id
    for (const [id, role, denyCompletion, denyDeletion] of [["child", "member", true, true], ["viewer", "viewer", false, false], ["member", "member", false, false]] as const) {
      expect(await boards.updateMember(owner, board, id, { role, denyCompletion, denyDeletion }, [id])).toMatchObject({ result: "saved" })
    }
    const scopes = await Promise.all([owner, fixturePrincipal("child", false), fixturePrincipal("viewer", false), fixturePrincipal("member", false)].map(actor => currentBoardScope(db, board, actor)))
    const expected = [["edit", "complete", "delete"], ["edit"], [], ["edit", "complete", "delete"]]
    // Once minted, hints are a pure calculation: closing the DB is not a grant
    // refresh and cannot turn this metadata into a command's current authority.
    resetPersistenceForTests()
    for (const [index, scope] of scopes.entries()) {
      expect(taskActionHints(scope)).toEqual(expected[index])
      expect(taskActionHints(scope, { assigned_to: null })).toEqual(expected[index])
    }
  })
  test(`agent hints respect assigned-only rows and independent scope ceilings: ${encoding}`, async () => {
    await runWithIngressTransport(transport, async () => {
      const db = getPersistenceClient(), owner = fixturePrincipal(), created = await new NamedBoardRepository(db).create(owner, "Agent hints")
      if (created.status !== "committed") throw new Error("Board required")
      const board = encoding === "legacy" ? "household" : created.result.id
      await new IdentityRepository(db).createCustomUser("custom_hint_agent", "Agent", "#146C4E", "agent")
      await ensureAgentTokenSchema()
      const mint = async (scopes: AgentScope[], action: WorkAction, assigned = false, completeOnly = false) => {
        const credential = generateAgentToken(), id = crypto.randomUUID()
        await createAgentToken({ id, name: "Hint actor", tokenHash: credential.tokenHash, tokenPrefix: credential.tokenPrefix, scopes, ...(assigned ? { assigneeId: "custom_hint_agent" } : {}) }, await currentBoardScope(db, board, owner))
        if (completeOnly) await changeBoardGrants(db, owner, async tx => {
          await tx.execute({ sql: "UPDATE board_access_grants SET authority_limits=json_set(authority_limits,'$.operations',json(?)) WHERE board_id=? AND principal_type='agent' AND principal_id=?", args: [JSON.stringify([{ resource: "task", action: "complete" }]), board, id] })
          return { next: true }
        })
        const request = new Request("http://localhost/api/tasks", { headers: { Authorization: `Bearer ${credential.token}` } })
        const agentToken = await resolveAgentAuth(request)
        if (!agentToken) throw new Error("Credential required")
        const principal = await verifiedBoardRequestPrincipal({ request, locals: { agentToken } as App.Locals })
        if (!principal) throw new Error("Verified principal required")
        const result = await new BoardAccessService(db).resolve(principal, board, { resource: "task", action })
        if (!result.ok) throw new Error(result.errorCode)
        return result.scope
      }
      expect(taskActionHints(await mint(["tasks:read"], "read"))).toEqual([])
      expect(taskActionHints(await mint(["tasks:write"], "edit"))).toEqual(["edit", "complete"])
      expect(taskActionHints(await mint(["tasks:delete"], "delete"))).toEqual(["delete"])
      expect(taskActionHints(await mint(["tasks:write"], "complete", false, true))).toEqual([])
      const assigned = await mint(["tasks:write:assigned", "tasks:delete"], "edit", true)
      expect(taskActionHints(assigned)).toEqual([])
      expect(taskActionHints(assigned, { assigned_to: null })).toEqual([])
      expect(taskActionHints(assigned, { assigned_to: "custom_someone_else" })).toEqual([])
      expect(taskActionHints(assigned, { assigned_to: "custom_hint_agent" })).toEqual(["edit", "complete", "delete"])
    })
  })
}
