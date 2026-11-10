import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { getExpiredLockClause, HANDOFF_CLAIM_TTL_MS } from "../../packages/domain-tasks/src/index"
import { TaskHandoff } from "../../apps/web/src/domains/tasks/persistence/task-handoff"
import { readHandoffRequest } from "../../apps/web/src/lib/handoff-request"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"

let directory: string
let previous: string | undefined
const agent = { id: "token-one", name: "Fixture agent" }
const id = "handoff-fixture"
const service = () => new TaskHandoff(getPersistenceClient())

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-handoff-"))
  previous = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "test.db")}`
  resetPersistenceForTests()
  await ensureSchema()
  await getPersistenceClient().execute({
    sql: "INSERT INTO tasks (id, title, description, status, idempotency_key, request_id, created_at, updated_at) VALUES (?, 'Original', 'Description', 'pending', ?, ?, ?, ?)",
    args: [id, id, id, Date.now(), Date.now()],
  })
})
test.afterEach(async () => {
  resetPersistenceForTests()
  if (previous === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previous
  await rm(directory, { recursive: true, force: true })
})
async function propose() {
  const claim = await service().agentAction(id, agent, { action: "claim" })
  if (!claim.ok) throw new Error(claim.error)
  return service().agentAction(id, agent, { action: "propose", lease: claim.lease!, summary: "Clearer title", updates: { title: "New title" } })
}

test("expired claims cannot propose and a new claim replaces their nonce", async () => {
  const before = Date.now()
  const claim = await service().agentAction(id, agent, { action: "claim" })
  if (!claim.ok) throw new Error(claim.error)
  expect(claim.expiresAt! - before).toBeGreaterThanOrEqual(HANDOFF_CLAIM_TTL_MS)
  await getPersistenceClient().execute("UPDATE tasks SET lock_expires_at = 1")
  expect(await service().agentAction(id, agent, { action: "propose", lease: claim.lease!, summary: "Expired", updates: { title: "Must not apply" } })).toMatchObject({ ok: false, status: 409 })
  const renewed = await service().agentAction(id, agent, { action: "claim" })
  expect(renewed.ok).toBe(true)
  if (renewed.ok) expect(renewed.lease).not.toBe(claim.lease)
})

test("expired proposals cannot be accepted and cleanup clears their stored payload", async () => {
  const proposal = await propose()
  if (!proposal.ok) throw new Error(proposal.error)
  await getPersistenceClient().execute("UPDATE tasks SET lock_expires_at = 1")
  expect(await service().queue(0, 25)).toEqual([])
  expect(await service().decide(id, proposal.hash!, "accept")).toMatchObject({ ok: false, status: 409 })
  await getPersistenceClient().execute(getExpiredLockClause())
  expect((await getPersistenceClient().execute("SELECT title, handoff_state, proposal_json, proposal_hash FROM tasks")).rows[0]).toMatchObject({ title: "Original", handoff_state: "idle", proposal_json: null, proposal_hash: null })
})

test("content hash rejects tampering and concurrent decisions apply once", async () => {
  const proposal = await propose()
  if (!proposal.ok) throw new Error(proposal.error)
  const stored = String((await getPersistenceClient().execute("SELECT proposal_json FROM tasks")).rows[0]!.proposal_json)
  await getPersistenceClient().execute({ sql: "UPDATE tasks SET proposal_json = ?", args: [stored.replace('New title', 'Tampered')] })
  expect(await service().decide(id, proposal.hash!, "accept")).toMatchObject({ ok: false, status: 409 })
  await getPersistenceClient().execute({ sql: "UPDATE tasks SET proposal_json = ?", args: [stored] })
  const decisions = await Promise.all([service().decide(id, proposal.hash!, "accept"), service().decide(id, proposal.hash!, "accept")])
  expect(decisions.filter(result => result.ok)).toHaveLength(1)
  expect((await getPersistenceClient().execute("SELECT title FROM tasks")).rows[0]!.title).toBe("New title")
  expect((await getPersistenceClient().execute("SELECT feed_action FROM task_activity_log WHERE feed_action = 'edited'")).rows).toHaveLength(1)
})

test("request parser rejects oversized, malformed and non-JSON input", async () => {
  const request = (body: string, contentType = "application/json") => new Request("http://local.invalid", { method: "POST", headers: { "content-type": contentType }, body })
  expect(await readHandoffRequest(request('{"action":"claim"}'))).toEqual({ action: "claim" })
  expect(await readHandoffRequest(request("x".repeat(49 * 1024)))).toBeNull()
  expect(await readHandoffRequest(request("{"))).toBeNull()
  expect(await readHandoffRequest(request('{}', 'text/plain'))).toBeNull()
})
