import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests
} from "../helpers/persistence-fixture"
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import {
  registerVerifiedPrincipal,
  validateBoardScope
} from "../../apps/web/src/domains/tasks/board-scope"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import {
  readWorkDestinations,
  type WorkBinding
} from "../../apps/web/src/domains/tasks/integration-destinations"
import {
  resolveIntegrationScope,
  validateIntegrationScope
} from "../../apps/web/src/domains/tasks/board-automation"

let directory: string
let previousUrl: string | undefined
test.beforeEach(async () => {
  previousUrl = process.env.MEITHEAL_DB_URL
  directory = await mkdtemp(join(tmpdir(), "meitheal-ordinary-automation-"))
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "work.db")}`
  await ensureSchema()
})
test.afterEach(async () => {
  resetPersistenceForTests()
  if (previousUrl === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previousUrl
  await rm(directory, { recursive: true, force: true })
})

test("a broader automation ceiling cannot complete for a restricted child, and stale bindings cannot dispatch", async () => {
  const db = getPersistenceClient()
  const owner = registerVerifiedPrincipal(
    { kind: "ha_user", id: "parent" },
    { administrator: true, expiresAt: Date.now() + 60_000 }
  )
  const boards = new NamedBoardRepository(db)
  const created = await boards.create(owner, "Work")
  if (created.status !== "committed") throw new Error("Expected private Board creation")
  const boardId = created.result.id
  const manager = await new BoardAccessService(db).resolve(owner, boardId, {
    resource: "board",
    action: "manage"
  })
  if (!manager.ok) throw new Error("Expected current Board manager")
  const configuration = await readWorkDestinations(db)
  if (!configuration) throw new Error("Expected admitted destination conversion")
  const binding: WorkBinding = {
    id: randomUUID(),
    generation: 1,
    integration: "todo",
    sourceId: "todo.fixture",
    purpose: "todo.sync",
    enabled: true,
    destination: { boardId },
    allowedOperations: [
      { resource: "task", action: "read" },
      { resource: "task", action: "complete" }
    ]
  }
  const enrolled = await changeBoardGrants(db, owner, async (tx) => {
    if (!(await validateBoardScope(manager.scope, tx, { resource: "board", action: "manage" })).ok)
      throw new Error("Manager changed")
    await tx.execute({
      sql: "INSERT INTO board_access_grants(board_id,principal_type,principal_id,role,authority_limits) VALUES (?,'service',?,'service',?)",
      args: [
        boardId,
        binding.id,
        JSON.stringify({ operations: binding.allowedOperations, purpose: binding.purpose })
      ]
    })
    await tx.execute({
      sql: "INSERT INTO board_access_grants(board_id,principal_type,principal_id,role,deny_completion) VALUES (?,'ha_user','child','member',1)",
      args: [boardId]
    })
    await tx.execute({
      sql: "UPDATE settings SET value = ? WHERE key = 'work-destinations'",
      args: [
        JSON.stringify({
          ...configuration,
          revision: randomUUID(),
          bindings: [...configuration.bindings, binding]
        })
      ]
    })
    return { next: true }
  })
  expect(enrolled.status).toBe("committed")
  const child = registerVerifiedPrincipal(
    { kind: "ha_user", id: "child" },
    { administrator: false, expiresAt: Date.now() + 60_000 }
  )
  const childScope = await new BoardAccessService(db).resolve(child, boardId, {
    resource: "task",
    action: "edit"
  })
  if (!childScope.ok) throw new Error("Child should retain editing")
  expect(
    await resolveIntegrationScope(
      db,
      binding.id,
      1,
      { resource: "task", action: "complete" },
      childScope.scope
    )
  ).toEqual({ ok: false, errorCode: "denied" })
  const approvedExternal = await resolveIntegrationScope(db, binding.id, 1, {
    resource: "task",
    action: "complete"
  })
  if (!approvedExternal.ok) throw new Error("Expected separately approved external completion")
  expect(
    await validateIntegrationScope({ ...approvedExternal.value }, db, {
      resource: "task",
      action: "complete"
    })
  ).toEqual({ ok: false, errorCode: "denied" })
  const access = await boards.findAccess(owner, boardId)
  if (!access) throw new Error("Manager should retain Board access")
  expect(await boards.changeLifecycle(owner, boardId, "retired", access.revision)).toMatchObject({
    status: "committed"
  })
  expect(
    (
      await validateIntegrationScope(approvedExternal.value, db, {
        resource: "task",
        action: "complete"
      })
    ).ok
  ).toBe(false)
  expect(
    (await resolveIntegrationScope(db, binding.id, 1, { resource: "task", action: "complete" })).ok
  ).toBe(false)
  const current = await readWorkDestinations(db)
  const other = current?.bindings.find(
    (item) => item.purpose === "builtin.overdue.observe" && item.destination.boardId !== boardId
  )
  if (!other) throw new Error("Expected independent original Board binding")
  expect(
    (
      await resolveIntegrationScope(db, other.id, other.generation, {
        resource: "task",
        action: "read"
      })
    ).ok
  ).toBe(true)
})

test("integration profile changes require affected private Board management and revoke old dispatches", async () => {
  const { saveWorkBinding, saveWorkIntegrationSettings } = await import(
    "../../apps/web/src/domains/tasks/work-binding-manager"
  )
  const db = getPersistenceClient()
  const owner = registerVerifiedPrincipal(
    { kind: "ha_user", id: "work-owner" },
    { administrator: true, expiresAt: Date.now() + 60_000 }
  )
  const anotherAdmin = registerVerifiedPrincipal(
    { kind: "ha_user", id: "other-admin" },
    { administrator: true, expiresAt: Date.now() + 60_000 }
  )
  const created = await new NamedBoardRepository(db).create(owner, "Work")
  if (created.status !== "committed") throw new Error("Expected private Work Board")
  const configuration = await readWorkDestinations(db)
  if (!configuration) throw new Error("Expected enrolled installation")
  const result = await saveWorkBinding(db, owner, configuration.revision, {
    id: randomUUID(),
    generation: 1,
    integration: "webhook",
    sourceId: "generic-webhook",
    purpose: "webhook.delivery",
    enabled: true,
    destination: { boardId: created.result.id },
    allowedOperations: [{ resource: "task", action: "read" }]
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const approved = await resolveIntegrationScope(db, result.binding.id, result.binding.generation, {
    resource: "task",
    action: "read"
  })
  if (!approved.ok) throw new Error("Expected approved receiver")
  expect(
    await saveWorkIntegrationSettings(db, anotherAdmin, [
      { key: "webhook_endpoint", value: JSON.stringify("https://example.com/new") }
    ])
  ).toBe(false)
  expect(
    (await validateIntegrationScope(approved.value, db, { resource: "task", action: "read" })).ok
  ).toBe(true)
  expect(
    await saveWorkIntegrationSettings(db, owner, [
      { key: "webhook_endpoint", value: JSON.stringify("https://example.com/new") }
    ])
  ).toBe(true)
  expect(
    (await validateIntegrationScope(approved.value, db, { resource: "task", action: "read" })).ok
  ).toBe(false)
  const changed = (await readWorkDestinations(db))?.bindings.find(
    (binding) => binding.id === result.binding.id
  )
  expect(changed?.generation).toBe(2)
})

test("source, purpose, destination and provider endpoints retire identities without adopting old provider receipts", async () => {
  const { saveWorkBinding, saveWorkIntegrationSettings } = await import(
    "../../apps/web/src/domains/tasks/work-binding-manager"
  )
  const { TaskRepository } = await import(
    "../../apps/web/src/domains/tasks/persistence/task-repository"
  )
  const { prepareTaskCreation } = await import(
    "../../apps/web/src/domains/tasks/task-creation-service"
  )
  const db = getPersistenceClient()
  const owner = registerVerifiedPrincipal(
    { kind: "ha_user", id: "owner" },
    { administrator: true, expiresAt: Date.now() + 60_000 }
  )
  const created = await new NamedBoardRepository(db).create(owner, "Work")
  if (created.status !== "committed") throw new Error("Board fixture")
  const initial = await readWorkDestinations(db)
  const first = await saveWorkBinding(db, owner, initial!.revision, {
    id: randomUUID(),
    generation: 1,
    integration: "calendar",
    sourceId: "calendar.first",
    purpose: "calendar.sync",
    enabled: true,
    destination: { boardId: created.result.id },
    allowedOperations: [{ resource: "task", action: "read" }]
  })
  if (!first.ok) throw new Error("Binding fixture")
  const human = await new BoardAccessService(db).resolve(owner, created.result.id, {
    resource: "task",
    action: "read"
  })
  if (!human.ok) throw new Error("Owner scope")
  const repo = new TaskRepository(db, human.scope)
  const prepared = await prepareTaskCreation(
    repo,
    { title: "Existing provider task", area_id: null },
    { useDefaultAssignee: false }
  )
  if (!prepared.ok) throw new Error(prepared.error)
  const task = await repo.createWorkCommand(prepared.task)
  if (!task.ok) throw new Error(task.errorCode)
  const context = await resolveIntegrationScope(db, first.binding.id, 1, {
    resource: "task",
    action: "read"
  })
  if (!context.ok) throw new Error("Service fixture")
  const serviceRepo = new TaskRepository(db, context.value.scope)
  const version = await serviceRepo.findSyncConfirmation(task.task.id, context.value)
  if (!version) throw new Error("Task snapshot fixture")
  expect(
    await serviceRepo.saveSyncConfirmationForTask(
      task.task.id,
      {
        source: "calendar",
        entityId: "calendar.first",
        externalId: "provider-uid-123",
        payload: JSON.stringify({ entity_id: "calendar.first" })
      },
      context.value,
      version.taskVersion
    )
  ).toBe(true)
  await changeBoardGrants(db, owner, async (tx) => {
    await tx.execute({
      sql: "UPDATE board_access_grants SET deny_deletion=1 WHERE principal_type='service' AND principal_id=?",
      args: [first.binding.id]
    })
    return { next: true }
  })
  const current = await readWorkDestinations(db)
  const second = await saveWorkBinding(db, owner, current!.revision, {
    ...first.binding,
    sourceId: "calendar.second"
  })
  expect(second.ok).toBe(true)
  if (!second.ok) throw new Error("Replacement fixture")
  expect(second.binding.id).not.toBe(first.binding.id)
  expect(second.binding.generation).toBe(1)
  expect(
    (await readWorkDestinations(db))?.bindings.find((binding) => binding.id === first.binding.id)
  ).toMatchObject({ retired: true, enabled: false, sourceId: "calendar.first" })
  expect(
    (
      await db.execute({
        sql: "SELECT 1 FROM board_access_grants WHERE principal_type='service' AND principal_id=?",
        args: [first.binding.id]
      })
    ).rows
  ).toHaveLength(0)
  expect(
    (
      await db.execute({
        sql: "SELECT provider_event_id FROM calendar_confirmations WHERE task_id=? AND binding_id=?",
        args: [task.task.id, first.binding.id]
      })
    ).rows
  ).toEqual([expect.objectContaining({ provider_event_id: "provider-uid-123" })])
  const next = await resolveIntegrationScope(db, second.binding.id, 1, {
    resource: "task",
    action: "read"
  })
  if (!next.ok) throw new Error("Replacement scope")
  expect(
    (await new TaskRepository(db, next.value.scope).findSyncConfirmation(task.task.id, next.value))
      ?.confirmation
  ).toBeNull()
  expect(
    await saveWorkBinding(db, owner, (await readWorkDestinations(db))!.revision, {
      ...first.binding,
      enabled: true
    })
  ).toEqual({ ok: false })
  expect(
    await saveWorkIntegrationSettings(db, owner, [
      { key: "ha_url", value: JSON.stringify("http://new-core.example.test") }
    ])
  ).toBe(true)
  const replaced = await readWorkDestinations(db)
  expect(replaced?.bindings.find((binding) => binding.id === second.binding.id)).toMatchObject({
    retired: true,
    enabled: false
  })
  const replacement = replaced?.bindings.find(
    (binding) => !binding.retired && binding.sourceId === "calendar.second"
  )
  expect(replacement?.id).not.toBe(second.binding.id)
  expect(
    (
      await db.execute({
        sql: "SELECT deny_deletion FROM board_access_grants WHERE principal_type='service' AND principal_id=?",
        args: [replacement!.id]
      })
    ).rows[0]?.deny_deletion
  ).toBe(1)
  expect(
    (await validateIntegrationScope(next.value, db, { resource: "task", action: "read" })).ok
  ).toBe(false)
  const otherBoard = await new NamedBoardRepository(db).create(owner, "Church")
  if (otherBoard.status !== "committed" || !replacement) throw new Error("Destination fixture")
  const moved = await saveWorkBinding(db, owner, (await readWorkDestinations(db))!.revision, {
    ...replacement,
    destination: { boardId: otherBoard.result.id }
  })
  if (!moved.ok) throw new Error("Destination replacement")
  expect(moved.binding.id).not.toBe(replacement.id)
  const receiving = await resolveIntegrationScope(db, moved.binding.id, 1, {
    resource: "task",
    action: "read"
  })
  if (!receiving.ok) throw new Error("Receiving fixture")
  expect(await new TaskRepository(db, receiving.value.scope).findById(task.task.id)).toBeNull()
  const repurposed = await saveWorkBinding(db, owner, (await readWorkDestinations(db))!.revision, {
    ...moved.binding,
    integration: "calendar_reminder",
    purpose: "calendar.reminder"
  })
  if (!repurposed.ok) throw new Error("Purpose replacement")
  expect(repurposed.binding.id).not.toBe(moved.binding.id)
  expect(
    (await readWorkDestinations(db))?.bindings.find((binding) => binding.id === moved.binding.id)
  ).toMatchObject({ retired: true, enabled: false, purpose: "calendar.sync" })
})

test("Core credential profiles intersect every affected Board while credential-only rotations preserve provider identity", async () => {
  const {
    saveWorkBinding,
    saveWorkIntegrationSettings,
    prepareWorkIntegrationSettings,
    validateWorkIntegrationSettingsApproval
  } = await import("../../apps/web/src/domains/tasks/work-binding-manager")
  const db = getPersistenceClient()
  const owner = registerVerifiedPrincipal(
    { kind: "ha_user", id: "owner" },
    { administrator: true, expiresAt: Date.now() + 60_000 }
  )
  const outsider = registerVerifiedPrincipal(
    { kind: "ha_user", id: "outsider" },
    { administrator: true, expiresAt: Date.now() + 60_000 }
  )
  const created = await new NamedBoardRepository(db).create(owner, "Work")
  if (created.status !== "committed") throw new Error("Board fixture")
  const kinds = [
    ["todo", "todo.work", "todo.sync"],
    ["calendar", "calendar.work", "calendar.sync"],
    ["notification", "notify.mobile_app_owner", "notify.delivery"],
    ["ha_events", "meitheal", "webhook.delivery"],
    ["notification_action", "notify.mobile_app_owner", "notify.task.complete"]
  ] as const
  const bindings: WorkBinding[] = []
  for (const [integration, sourceId, purpose] of kinds) {
    const next = await saveWorkBinding(db, owner, (await readWorkDestinations(db))!.revision, {
      id: randomUUID(),
      generation: 1,
      integration,
      sourceId,
      purpose,
      enabled: true,
      destination: { boardId: created.result.id },
      allowedOperations: [
        { resource: "task", action: "read" },
        ...(integration === "notification_action"
          ? [{ resource: "task" as const, action: "complete" as const }]
          : [])
      ],
      ...(integration === "notification_action" ? { recipientUserIds: ["owner"] } : {})
    })
    if (!next.ok) throw new Error("Binding fixture")
    bindings.push(next.binding)
  }
  expect(await prepareWorkIntegrationSettings(db, outsider, ["ha_token"])).toBeNull()
  const approval = await prepareWorkIntegrationSettings(db, owner, ["ha_token"])
  expect(approval).not.toBeNull()
  expect(await validateWorkIntegrationSettingsApproval(db, { ...approval! })).toBe(false)
  expect(
    await saveWorkIntegrationSettings(
      db,
      owner,
      [{ key: "ha_token", value: JSON.stringify("fixture-rotated-core-token") }],
      approval!
    )
  ).toBe(true)
  const current = await readWorkDestinations(db)
  for (const binding of bindings)
    expect(current?.bindings.find((item) => item.id === binding.id)).toMatchObject({
      generation: 2,
      enabled: true
    })
  expect(await validateWorkIntegrationSettingsApproval(db, approval!)).toBe(false)
  const metadata = JSON.stringify(current)
  expect(metadata).not.toContain("fixture-rotated-core-token")
})
