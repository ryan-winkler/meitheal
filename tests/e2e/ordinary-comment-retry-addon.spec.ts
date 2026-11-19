import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests
} from "../helpers/persistence-fixture"
import { currentBoardScope, fixturePrincipal } from "../helpers/current-board-scope"
import { startCoreRosterFixture } from "../helpers/core-roster-fixture"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import { POST as postComment } from "../../apps/web/src/pages/api/tasks/[id]/comments"
import { boardSessionProof } from "../../apps/web/src/lib/named-board-request"
import { commentAttemptHorizonMs } from "../../apps/web/src/lib/comment-mentions"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"

let work: string,
  board: string,
  otherBoard: string,
  task: string,
  otherTask: string,
  stop: () => Promise<void>
let roster: string[]
const previous = process.env.MEITHEAL_DB_URL
const transport = {
  peer: "172.30.32.2",
  fromSupervisor: true,
  identityHeadersSafe: true,
  configuredPath: "/api/hassio_ingress/test"
}
async function call(
  content = "Retain one original comment",
  key = "plain-retry",
  user = "owner",
  selectedBoard = board,
  selectedTask = task
) {
  const request = new Request(`http://localhost/api/tasks/${selectedTask}/comments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      "x-meitheal-board-id": selectedBoard,
      "x-meitheal-board-session": boardSessionProof(user)
    },
    body: JSON.stringify({ content, author: "Cannot forge owner" })
  })
  return runWithIngressTransport(transport, () =>
    postComment({
      request,
      url: new URL(request.url),
      params: { id: selectedTask },
      locals: { behindIngress: true, hassUserId: user, hassIsAdmin: user === "owner" }
    } as unknown as Parameters<typeof postComment>[0])
  ) as Promise<Response>
}
async function create(boardId: string) {
  const repo = new TaskRepository(
    getPersistenceClient(),
    await currentBoardScope(getPersistenceClient(), boardId, fixturePrincipal("owner"))
  )
  const prepared = await prepareTaskCreation(
    repo,
    { title: "PRIVATE-TASK-SENTINEL" },
    { useDefaultAssignee: false }
  )
  if (!prepared.ok) throw new Error(prepared.error)
  const task = await repo.createWorkCommand(prepared.task)
  if (!task.ok) throw new Error(task.errorCode)
  return task.task.id
}
test.beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "ordinary-comment-retry-"))
  process.env.MEITHEAL_DB_URL = "file:" + join(work, "tasks.db")
  await ensureSchema()
  const repository = new NamedBoardRepository(getPersistenceClient())
  const first = await repository.create(fixturePrincipal("owner"), "House"),
    second = await repository.create(fixturePrincipal("owner"), "Work")
  if (first.status !== "committed" || second.status !== "committed")
    throw new Error("Board fixtures")
  board = first.result.id
  otherBoard = second.result.id
  expect(
    await repository.updateMember(
      fixturePrincipal("owner"),
      board,
      "member",
      { role: "member", denyCompletion: false, denyDeletion: false },
      ["owner", "member"]
    )
  ).toMatchObject({ status: "committed" })
  task = await create(board)
  otherTask = await create(otherBoard)
  roster = ["owner", "member"]
  stop = await startCoreRosterFixture(roster)
})
test.afterEach(async () => {
  await stop()
  resetPersistenceForTests()
  if (previous === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previous
  await rm(work, { recursive: true, force: true })
})

test("two simultaneous plain retries use one durable comment and the same bounded receipt", async () => {
  const responses = await Promise.all([call(), call()])
  expect(responses.map((response) => response.status)).toEqual([201, 201])
  const [one, two] = await Promise.all(responses.map((response) => response.json()))
  expect(two).toEqual(one)
  expect(Object.keys(one).sort()).toEqual(["author", "content", "created_at", "id", "task_id"])
  expect(JSON.stringify(one)).not.toMatch(/PRIVATE-TASK|owner_key|body_digest|attempt_key/)
  expect(
    (await getPersistenceClient().execute("SELECT id FROM comments WHERE task_id=?", [task])).rows
  ).toHaveLength(1)
  expect(
    (
      await getPersistenceClient().execute(
        "SELECT comment_id FROM comment_mention_attempts WHERE task_id=?",
        [task]
      )
    ).rows
  ).toEqual([{ comment_id: one.id }])
  expect(await (await call()).json()).toEqual(one)
})

test("changed content conflicts without a second row or replacing the original", async () => {
  const first = await (await call()).json()
  const changed = await call("Do not overwrite this with a retry")
  expect(changed.status).toBe(409)
  expect(
    (
      await getPersistenceClient().execute("SELECT id,content FROM comments WHERE task_id=?", [
        task
      ])
    ).rows
  ).toEqual([{ id: first.id, content: first.content }])
})

test("the same legacy key is independent across actual actors, Boards, tasks and installation namespaces", async () => {
  const one = await (await call()).json(),
    otherActor = await (await call(undefined, undefined, "member")).json()
  const otherDestination = await (
    await call(undefined, undefined, "owner", otherBoard, otherTask)
  ).json()
  const secondTask = await create(board),
    sameBoard = await (await call(undefined, undefined, "owner", board, secondTask)).json()
  expect(new Set([one.id, otherActor.id, otherDestination.id, sameBoard.id]).size).toBe(4)
  const db = getPersistenceClient(),
    before = (await db.execute("SELECT value FROM app_settings WHERE key='work_installation_id'"))
      .rows[0]!.value
  // Synthetic namespace control: a different persisted installation must not seize the old receipt.
  await db.execute("UPDATE app_settings SET value=? WHERE key='work_installation_id'", [
    crypto.randomUUID()
  ])
  const differentInstallation = await (await call()).json()
  expect(differentInstallation.id).not.toBe(one.id)
  await db.execute("UPDATE app_settings SET value=? WHERE key='work_installation_id'", [before!])
  expect(await (await call()).json()).toEqual(one)
})

test("removed current Board access cannot publish the accepted private receipt", async () => {
  const first = await (await call(undefined, undefined, "member")).json()
  expect(first.content).toBe("Retain one original comment")
  expect(
    await new NamedBoardRepository(getPersistenceClient()).updateMember(
      fixturePrincipal("owner"),
      board,
      "member",
      null,
      ["owner", "member"]
    )
  ).toMatchObject({ status: "committed" })
  const denied = await call(undefined, undefined, "member")
  expect(denied.status).toBe(404)
  expect(await denied.text()).not.toContain(first.content)
  expect(
    (await getPersistenceClient().execute("SELECT id FROM comments WHERE task_id=?", [task])).rows
  ).toHaveLength(1)
})

test("a current Core account removal denies replay even while its stored Board grant remains", async () => {
  const prior = await (await call(undefined, undefined, "member")).json()
  roster.splice(roster.indexOf("member"), 1)
  const denied = await call(undefined, undefined, "member")
  expect(denied.status).toBe(403)
  expect(await denied.text()).not.toContain(prior.content)
  expect(
    (await getPersistenceClient().execute("SELECT id FROM comments WHERE task_id=?", [task])).rows
  ).toHaveLength(1)
})

test("expired retry retires only its exact authorized receipt and keeps original comments and other actors' receipts", async () => {
  const own = await (await call()).json(),
    other = await (await call(undefined, undefined, "member")).json()
  const db = getPersistenceClient(),
    old = Date.now() - commentAttemptHorizonMs - 100
  await db.execute("UPDATE comment_mention_attempts SET issued_at=? WHERE comment_id IN (?,?)", [
    old,
    own.id,
    other.id
  ])
  const retried = await call()
  expect(retried.status).toBe(201)
  const fresh = await retried.json()
  expect(fresh.id).not.toBe(own.id)
  expect(
    (await db.execute("SELECT id FROM comments WHERE task_id=? ORDER BY id", [task])).rows.map(
      (row) => row.id
    )
  ).toEqual([own.id, other.id, fresh.id])
  expect(
    (
      await db.execute("SELECT issued_at FROM comment_mention_attempts WHERE comment_id=?", [
        other.id
      ])
    ).rows
  ).toEqual([{ issued_at: old }])
  expect(
    (
      await db.execute("SELECT comment_id FROM comment_mention_attempts WHERE comment_id=?", [
        own.id
      ])
    ).rows
  ).toEqual([])
})

test("invalid keys and missing persisted installation identity never create or fall back to another receipt", async () => {
  expect((await call(undefined, "")).status).toBe(400)
  expect((await call(undefined, "x".repeat(256))).status).toBe(400)
  await getPersistenceClient().execute("DELETE FROM app_settings WHERE key='work_installation_id'")
  const missing = await call()
  expect(missing.status).toBe(503)
  expect(
    (await getPersistenceClient().execute("SELECT id FROM comments WHERE task_id=?", [task])).rows
  ).toEqual([])
})
