import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { startHAWebSocketFixture } from "../scripts/ha-websocket-fixture"
import { BoardAccessService, TaskRepository, IdentityRepository, readWorkDestinations, saveWorkBinding } from "../../apps/web/src/domains/tasks"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { registerVerifiedPrincipal } from "../../apps/web/src/domains/tasks/board-scope"
import { verifiedBoardRequestPrincipal } from "../../apps/web/src/lib/board-request-context"
import { resolveAgentAuth } from "../../apps/web/src/lib/agent-token-guard"
import { generateAgentToken } from "../../packages/domain-auth/src/index"
import { ensureAgentTokenSchema, createAgentToken } from "../../apps/web/src/domains/auth"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import { closeHAConnection } from "../../apps/web/src/domains/ha/ha-connection"
import { stopEntitySubscription } from "../../apps/web/src/domains/ha/ha-entities"
import { callHAService } from "../../apps/web/src/domains/ha/ha-services"
import { sendTaskNotification, notificationOperationAllowed } from "../../apps/web/src/domains/notifications/task-notifications"

for (const clear of [false, true]) test(`a pending notification loses its original assignment authority: clear=${clear}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ordinary-notify-origin-"))
  const keys = ["MEITHEAL_DB_URL", "HA_BASE_URL", "HA_TOKEN", "SUPERVISOR_TOKEN"] as const
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const token = "ordinary-notification-held-auth"
  const ha = await startHAWebSocketFixture({ holdTokens: [token] })
  const owner = () => registerVerifiedPrincipal({ kind: "ha_user", id: "parent" }, { administrator: true, expiresAt: Date.now() + 60_000 })
  try {
    delete process.env.SUPERVISOR_TOKEN
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "work.db")}`
    await ensureSchema()
    const db = getPersistenceClient(), boards = new NamedBoardRepository(db)
    const created = await boards.create(owner(), "Church")
    if (created.status !== "committed") throw new Error("Expected ordinary Board")
    const boardId = created.result.id
    const access = await boards.findAccess(owner(), boardId)
    if (!access) throw new Error("Expected manager")
    expect((await boards.updateSharing(owner(), boardId, { visibility: "shared", sharedRole: "member", sharedAdminManagement: false }, access.revision, ["parent"])).status).toBe("committed")
    const configuration = await readWorkDestinations(db)
    if (!configuration) throw new Error("Expected configuration")
    expect((await saveWorkBinding(db, owner(), configuration.revision, { id: crypto.randomUUID(), generation: 1,
      integration: "notification", sourceId: "persistent_notification", purpose: "notify.delivery", enabled: true,
      destination: { boardId }, allowedOperations: [{ resource: "task", action: "read" }] })).ok).toBe(true)
    await new IdentityRepository(db).createCustomUser("custom_notify_agent", "Notification agent", "#123456", "agent")
    const manager = await new BoardAccessService(db).resolve(owner(), boardId, { resource: "board", action: "manage" })
    if (!manager.ok) throw new Error(manager.errorCode)
    await ensureAgentTokenSchema()
    const credential = generateAgentToken()
    await createAgentToken({ id: crypto.randomUUID(), name: "Assigned notifier", tokenHash: credential.tokenHash,
      tokenPrefix: credential.tokenPrefix, scopes: ["tasks:write:assigned"], assigneeId: "custom_notify_agent" }, manager.scope)
    const freshOwner = await new BoardAccessService(db).resolve(owner(), boardId, { resource: "task", action: "create" })
    if (!freshOwner.ok) throw new Error(freshOwner.errorCode)
    const repo = new TaskRepository(db, freshOwner.scope)
    const prepared = await prepareTaskCreation(repo, { title: "Only while assigned", assigned_to: "custom_notify_agent" }, { useDefaultAssignee: false })
    if (!prepared.ok) throw new Error(prepared.error)
    const task = await repo.createWorkCommand(prepared.task)
    if (!task.ok) throw new Error(task.errorCode)
    const request = new Request("http://127.0.0.1/api/tasks", { headers: { Authorization: `Bearer ${credential.token}` } })
    const resolved = await resolveAgentAuth(request)
    if (!resolved) throw new Error("Expected actual credential")
    const principal = await verifiedBoardRequestPrincipal({ request, locals: { agentToken: resolved } as App.Locals }, true)
    if (!principal) throw new Error("Expected credential principal")
    const agent = await new BoardAccessService(db).resolve(principal, boardId, { resource: "task", action: "edit" })
    if (!agent.ok) throw new Error(agent.errorCode)
    process.env.HA_BASE_URL = ha.url
    process.env.HA_TOKEN = token
    const allowed = () => notificationOperationAllowed(agent.scope, "persistent_notification", { resource: "task", action: "edit" }, task.task.id)
    expect(await allowed()).toBe(true)
    const pending = clear ? callHAService("persistent_notification", "dismiss", { notification_id: "fixture" }, undefined, { operationAllowed: allowed })
      : sendTaskNotification({ enabled: true, disabledUsers: new Set(), channels: { sidebar: true, mobile_push: false }, mobileTargets: [] },
        { title: "Current task", message: "This must be withheld", notificationId: "fixture", ingress: null, taskId: task.task.id }, agent.scope, { resource: "task", action: "edit" })
    await expect.poll(() => ha.tokens.includes(token)).toBe(true)
    expect((await repo.updateTask(task.task.id, { assigned_to: null })).ok).toBe(true)
    expect(await allowed()).toBe(false)
    ha.release(token)
    await pending
    expect(ha.serviceCalls).toEqual([])
  } finally {
    stopEntitySubscription(); closeHAConnection(); await ha.close()
    resetPersistenceForTests()
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]
    await rm(directory, { recursive: true, force: true })
  }
})
