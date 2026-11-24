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
  type BoardScope,
  type VerifiedPrincipal
} from "../../apps/web/src/domains/tasks/board-scope"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { TemplateRepository } from "../../apps/web/src/domains/tasks/persistence/template-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import {
  changeGoalShare,
  listSharedGoals
} from "../../apps/web/src/domains/tasks/persistence/shared-goal-repository"
import {
  createPillar,
  getPillars,
  getPillarById
} from "../../apps/web/src/domains/pillars/pillar-service"
import {
  createPrinciple,
  getAllPrinciples
} from "../../apps/web/src/domains/pillars/principle-service"
import { personalPillarScope } from "../../apps/web/src/domains/pillars/pillar-owner"
import {
  linkEntity,
  getPillarsForEntity,
  setEntityPillar
} from "../../apps/web/src/domains/pillars/pillar-association-service"
import {
  scopeCommentOwnerKey,
  scopeServiceDestination,
  validateBoardScope,
  scopeMentionRecipientKey
} from "../../apps/web/src/domains/tasks/board-scope"
import { CommentMentionRepository } from "../../apps/web/src/domains/tasks/persistence/comment-mention-repository"
import { TaskReactionRepository } from "../../apps/web/src/domains/tasks/persistence/task-reaction-repository"
import { TaskPinRepository } from "../../apps/web/src/domains/tasks/persistence/task-pin-repository"
import { UserRepository } from "../../apps/web/src/domains/tasks/persistence/user-repository"
import { TaskInactivityRepository } from "../../apps/web/src/domains/tasks/persistence/task-inactivity-repository"
import { TaskHandoff } from "../../apps/web/src/domains/tasks/persistence/task-handoff"
import {
  ensureAgentTokenSchema,
  createAgentToken,
  updateAgentToken
} from "../../apps/web/src/domains/auth/agent-token-store"
import { IdentityRepository } from "../../apps/web/src/domains/tasks/persistence/identity-repository"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
let directory: string
const previous = process.env.MEITHEAL_DB_URL
const parent = () =>
  registerVerifiedPrincipal(
    { kind: "ha_user", id: "parent" },
    { expiresAt: Date.now() + 60000, administrator: true }
  )
const child = () =>
  registerVerifiedPrincipal(
    { kind: "ha_user", id: "child" },
    { expiresAt: Date.now() + 60000, administrator: false }
  )
async function scope(principal: VerifiedPrincipal, id: string): Promise<BoardScope> {
  const result = await new BoardAccessService(getPersistenceClient()).resolve(principal, id, {
    resource: "task",
    action: "read"
  })
  if (!result.ok) throw new Error(result.errorCode)
  return result.scope
}
async function board(principal: VerifiedPrincipal, name: string) {
  const result = await new NamedBoardRepository(getPersistenceClient()).create(principal, name)
  if (result.status !== "committed") throw new Error("Board fixture failed")
  return result.result.id
}
async function task(work: BoardScope, title: string) {
  const repository = new TaskRepository(getPersistenceClient(), work)
  const parsed = await prepareTaskCreation(
    repository,
    { title, area_id: null },
    { useDefaultAssignee: false }
  )
  if (!parsed.ok) throw new Error(parsed.error)
  const result = await repository.createWorkCommand(parsed.task)
  if (!result.ok) throw new Error(result.errorCode)
  return result.task
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ordinary-planning-"))
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "test.db")}`
  await ensureSchema()
})
test.afterEach(async () => {
  resetPersistenceForTests()
  if (previous === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previous
  await rm(directory, { recursive: true, force: true })
})

for (const encoding of ["legacy", "scoped"] as const) {
  test(`${encoding}: related work is scoped and personal state keeps actor provenance`, async () => {
    const owner = parent(),
      db = getPersistenceClient(),
      id = encoding === "legacy" ? "household" : await board(owner, "Church")
    const foreignId = await board(owner, "Private Work")
    const work = await scope(owner, id),
      foreign = await scope(owner, foreignId)
    const item = await task(work, "Visible task"),
      secret = await task(foreign, "Private task")
    const ownerKey = scopeCommentOwnerKey(work)!,
      recipient = scopeMentionRecipientKey(work)!
    const comments = new CommentMentionRepository(db, work)
    const attempt = {
      key: randomUUID(),
      issuedAt: Date.now(),
      rawContent: "Hello",
      cutoff: Date.now() - 86400000
    }
    const result = await comments.create(
      item.id,
      "Hello",
      "Parent",
      ownerKey,
      [recipient],
      attempt,
      true
    )
    expect(result.state).toBe("created")
    if (result.state !== "created") throw new Error(result.state)
    const commentId = Number(result.comment.id)
    expect(await comments.replay(item.id, ownerKey, attempt.key, "Hello")).toMatchObject({
      state: "replayed"
    })
    expect(await comments.page(recipient, null)).toMatchObject({
      unread: 1,
      rows: [{ task_id: item.id, title: "Visible task" }]
    })
    expect(await new CommentMentionRepository(db, foreign).page(recipient, null)).toMatchObject({
      unread: 0,
      rows: []
    })
    expect(await comments.page("somebody-else", null)).toMatchObject({ unread: 0, rows: [] })
    expect(
      await comments.mark(
        recipient,
        Number((await comments.page(recipient, null)).rows[0]!.id),
        true
      )
    ).toBe(true)
    expect((await comments.page(recipient, null)).unread).toBe(0)
    const reactions = new TaskReactionRepository(db, work),
      target = { taskId: item.id, commentId }
    const reaction = await reactions.add(target, "👍", "Parent", ownerKey)
    expect(reaction?.can_manage).toBe(true)
    expect(await reactions.remove(target, reaction!.id, ownerKey)).toBe(true)
    expect(await reactions.countCards([secret.id])).toEqual({})
    const pins = new TaskPinRepository(db, work)
    expect(await pins.set(owner.id, item.id, true)).toMatchObject({ pinned: true })
    expect(await pins.set(owner.id, secret.id, true)).toBe(null)
    expect((await pins.list(owner.id, 1)).items.map((item) => item.id)).toEqual([item.id])
    expect((await new TaskPinRepository(db, foreign).list(owner.id, 1)).items).toEqual([])
    expect(await pins.hasAny("another-user")).toBe(false)
    const users = new UserRepository(db, work),
      otherUsers = new UserRepository(db, foreign)
    await users.setDefaultAssignee("parent")
    expect(await users.getDefaultAssigneeSetting()).toBe("parent")
    expect(await otherUsers.getDefaultAssigneeSetting()).toBe(null)
    const inactivity = new TaskInactivityRepository(db, work)
    const preview = await inactivity.preview({
      areaId: null,
      page: 1,
      filter: "all",
      now: Date.now()
    })
    expect(
      await inactivity.savePolicy({
        areaId: null,
        days: 3,
        expectedRevision: null,
        expectedDefaultRevision: null,
        areaGeneration: null,
        expectedAreaCatalogRevision: preview.areaCatalogRevision
      })
    ).toMatchObject({ status: "saved" })
    expect(await inactivity.hasEnabledPolicy()).toBe(true)
    expect(await new TaskInactivityRepository(db, foreign).hasEnabledPolicy()).toBe(false)
    expect(await inactivity.candidates(Date.now())).toEqual([])
    expect(await inactivity.boardCues([item.id, secret.id], Date.now())).toBeTruthy()
  })
}

test("credential enrollment journals its exact Board ceiling and preserves propose-only review", async () => {
  const owner = parent(),
    db = getPersistenceClient(),
    id = await board(owner, "Agent projects")
  let work = await scope(owner, id)
  await ensureAgentTokenSchema()
  const tokenId = randomUUID()
  await createAgentToken(
    {
      id: tokenId,
      name: "Proposer",
      tokenHash: randomUUID(),
      tokenPrefix: "test",
      scopes: ["tasks:propose"]
    },
    work
  )
  work = await scope(owner, id)
  const agent = registerVerifiedPrincipal(
    { kind: "agent", id: tokenId, tokenId },
    { expiresAt: Date.now() + 60000, administrator: false, tokenScopes: ["tasks:propose"] }
  )
  const resolver = new BoardAccessService(db),
    proposal = await resolver.resolve(agent, id, { resource: "task", action: "propose" })
  expect(proposal.ok).toBe(true)
  expect((await resolver.resolve(agent, id, { resource: "task", action: "edit" })).ok).toBe(false)
  expect(
    (await resolver.resolve(agent, "household", { resource: "task", action: "propose" })).ok
  ).toBe(false)
  const item = await task(work, "Needs a proposal")
  if (!proposal.ok) throw new Error(proposal.errorCode)
  const handoff = new TaskHandoff(db, proposal.scope),
    claim = await handoff.agentAction(
      item.id,
      { id: tokenId, name: "Proposer" },
      { action: "claim" }
    )
  expect(claim.ok).toBe(true)
  if (!claim.ok || !claim.lease) throw new Error("missing lease")
  const proposed = await handoff.agentAction(
    item.id,
    { id: tokenId, name: "Proposer" },
    {
      action: "propose",
      lease: claim.lease,
      summary: "Clearer title",
      updates: { title: "Proposed title" }
    }
  )
  expect(proposed.ok).toBe(true)
  if (!proposed.ok || !proposed.hash) throw new Error("missing proposal")
  expect(await new TaskHandoff(db, work).decide(item.id, proposed.hash, "accept")).toMatchObject({
    ok: true
  })
  expect((await new TaskRepository(db, work).findById(item.id))?.title).toBe("Proposed title")
  await updateAgentToken(tokenId, { scopes: ["tasks:read", "tasks:write", "tasks:propose"] })
  const expanded = registerVerifiedPrincipal(
    { kind: "agent", id: tokenId, tokenId },
    {
      expiresAt: Date.now() + 60000,
      administrator: false,
      tokenScopes: ["tasks:read", "tasks:write", "tasks:propose"]
    }
  )
  expect((await resolver.resolve(expanded, id, { resource: "task", action: "edit" })).ok).toBe(
    false
  )
})

test("deleting a registry identity preserves task provenance and closes assigned writes", async () => {
  const owner = parent(),
    db = getPersistenceClient(),
    id = await board(owner, "Agents")
  let work = await scope(owner, id)
  const identities = new IdentityRepository(db),
    assignee = randomUUID(),
    tokenId = randomUUID()
  await identities.createCustomUser(assignee, "Agent", "#ffffff", "agent")
  await ensureAgentTokenSchema()
  await createAgentToken(
    {
      id: tokenId,
      name: "Assigned",
      tokenHash: randomUUID(),
      tokenPrefix: "test",
      scopes: ["tasks:read", "tasks:write:assigned"],
      assigneeId: assignee
    },
    work
  )
  work = await scope(owner, id)
  const item = await task(work, "Recorded assignment")
  await db.execute({ sql: "UPDATE tasks SET assigned_to=? WHERE id=?", args: [assignee, item.id] })
  const agent = registerVerifiedPrincipal(
    { kind: "agent", id: tokenId, tokenId },
    {
      expiresAt: Date.now() + 60000,
      administrator: false,
      tokenScopes: ["tasks:read", "tasks:write:assigned"]
    }
  )
  const resolver = new BoardAccessService(db)
  expect((await resolver.resolve(agent, id, { resource: "task", action: "edit" })).ok).toBe(true)
  await identities.deleteCustomUser(assignee)
  expect(
    (await db.execute({ sql: "SELECT assigned_to FROM tasks WHERE id=?", args: [item.id] })).rows[0]
      ?.assigned_to
  ).toBe(assignee)
  expect((await resolver.resolve(agent, id, { resource: "task", action: "edit" })).ok).toBe(false)
  expect((await resolver.resolve(agent, id, { resource: "task", action: "read" })).ok).toBe(true)
})

test("service scopes retain exact current destination and reject binding changes before effects", async () => {
  const owner = parent(),
    db = getPersistenceClient(),
    id = await board(owner, "Provider tasks")
  const work = await scope(owner, id),
    hierarchy = new HierarchyRepository(db, work),
    areaId = randomUUID(),
    projectId = randomUUID()
  await hierarchy.createArea({ id: areaId, name: "Garden" })
  await hierarchy.createProject({ id: projectId, title: "Watering", area_id: areaId })
  const bindingId = randomUUID(),
    serviceId = `binding:${bindingId}`
  const operation = { resource: "task", action: "create" } as const
  const binding = {
    id: bindingId,
    generation: 1,
    integration: "todo",
    sourceId: "todo.garden",
    enabled: true,
    destination: { boardId: id, areaId, projectId },
    allowedOperations: [operation],
    purpose: "todo.sync"
  }
  await changeBoardGrants(db, parent(), async (tx) => {
    const {
      rows: [setting]
    } = await tx.execute("SELECT value FROM settings WHERE key='work-destinations'")
    const configuration = JSON.parse(String(setting!.value))
    configuration.bindings.push(binding)
    configuration.revision = randomUUID()
    await tx.execute({
      sql: "UPDATE settings SET value=? WHERE key='work-destinations'",
      args: [JSON.stringify(configuration)]
    })
    await tx.execute({
      sql: "INSERT INTO board_access_grants(board_id,principal_type,principal_id,role,authority_limits) VALUES (?,'service',?,'service',?)",
      args: [id, serviceId, JSON.stringify({ operations: [operation], purpose: "todo.sync" })]
    })
    return { next: true }
  })
  const service = registerVerifiedPrincipal(
    { kind: "service", id: serviceId, bindingId, bindingGeneration: 1 },
    { expiresAt: Date.now() + 60000, administrator: false }
  )
  const access = new BoardAccessService(db),
    resolved = await access.resolve(service, id, operation)
  expect(resolved.ok).toBe(true)
  if (!resolved.ok) throw new Error(resolved.errorCode)
  expect(scopeServiceDestination(resolved.scope)).toEqual({ boardId: id, areaId, projectId })
  const {
    rows: [setting]
  } = await db.execute("SELECT value FROM settings WHERE key='work-destinations'")
  const configuration = JSON.parse(String(setting!.value))
  configuration.bindings.find((item: { id: string }) => item.id === bindingId).sourceId =
    "todo.other"
  await db.execute({
    sql: "UPDATE settings SET value=? WHERE key='work-destinations'",
    args: [JSON.stringify(configuration)]
  })
  expect(await validateBoardScope(resolved.scope, db, operation)).toMatchObject({
    ok: false,
    errorCode: "stale"
  })
})
