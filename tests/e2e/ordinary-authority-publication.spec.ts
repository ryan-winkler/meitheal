import fs, { mkdtemp, readdir, rm } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { expect, test } from "@playwright/test"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests
} from "../helpers/persistence-fixture"
import { fixturePrincipal } from "../helpers/current-board-scope"
import { startCoreRosterFixture } from "../helpers/core-roster-fixture"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { BoardIntakeRepository } from "../../apps/web/src/domains/tasks/persistence/board-intake-repository"
import {
  currentBoardGrantRevision,
  getBoardGrantPath
} from "../../apps/web/scripts/board-grant-journal.mjs"
import { GET as boardDirectory } from "../../apps/web/src/pages/api/boards/index"
import { PATCH as patchBoard } from "../../apps/web/src/pages/api/boards/[id]/index"
import { boardSessionProof } from "../../apps/web/src/lib/named-board-request"
import { admitBoardDirectoryResponse, readBoardDirectory } from "../../apps/web/src/lib/board-view"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { GET as listTasks, POST as createTask } from "../../apps/web/src/pages/api/tasks/index"
import { boardScopeResponse, resolveBoardPageScope } from "../../apps/web/src/lib/board-http"

const barrier = () => {
  let release!: () => void
  const promise = new Promise<void>((r) => {
    release = r
  })
  return { promise, release }
}
let directory: string, stopCore: () => Promise<void>, boardId: string
const previous = process.env.MEITHEAL_DB_URL
const transport = {
  peer: "172.30.32.2",
  fromSupervisor: true,
  identityHeadersSafe: true,
  configuredPath: "/api/hassio_ingress/test"
}
function context(user: string, method = "GET", body?: unknown) {
  const url = new URL("http://localhost/api/boards" + (method === "PATCH" ? "/" + boardId : ""))
  return {
    url,
    params: method === "PATCH" ? { id: boardId } : {},
    locals: { behindIngress: true, hassUserId: user, hassIsAdmin: user === "owner" },
    request: new Request(url, {
      method,
      ...(body
        ? {
            headers: {
              "content-type": "application/json",
              "x-meitheal-board-session": boardSessionProof(user)
            },
            body: JSON.stringify(body)
          }
        : {})
    })
  } as Parameters<typeof boardDirectory>[0]
}
const ingress = <T>(work: () => T) => runWithIngressTransport(transport, work)
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ordinary-publication-"))
  process.env.MEITHEAL_DB_URL = "file:" + join(directory, "test.db")
  await ensureSchema()
  stopCore = await startCoreRosterFixture(["owner", "member", "other"])
  const repo = new NamedBoardRepository(getPersistenceClient()),
    created = await repo.create(fixturePrincipal("owner"), "PRIVATE-PUBLICATION-SENTINEL")
  if (created.status !== "committed") throw new Error("Board fixture")
  boardId = created.result.id
  expect(
    await repo.updateMember(
      fixturePrincipal("owner"),
      boardId,
      "member",
      { role: "member", denyCompletion: false, denyDeletion: false },
      ["owner", "member", "other"]
    )
  ).toMatchObject({ status: "committed" })
})
test.afterEach(async () => {
  await stopCore()
  resetPersistenceForTests()
  if (previous === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previous
  await rm(directory, { recursive: true, force: true })
})

test("legacy Board query aliases select the same Board and conflicts disclose no default work", async () => {
  function selected(path: string, headers: Record<string, string> = {}, body?: object) {
    const url = new URL(path, "http://localhost")
    return {
      ...context("owner"),
      url,
      request: new Request(url, {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          "x-meitheal-board-session": boardSessionProof("owner"),
          ...headers
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      })
    }
  }
  const title = "ALIAS-PRIVATE-TASK-SENTINEL"
  const created = await ingress(() =>
    createTask(selected(`/api/tasks?board=${boardId}`, {}, { title }))
  )
  expect(created.status, await created.clone().text()).toBe(201)
  for (const query of [
    `board=${boardId}`,
    `board_id=${boardId}`,
    `board=${boardId}&board_id=${boardId}`
  ]) {
    const api = await ingress(() => listTasks(selected(`/api/tasks?${query}`)))
    expect(api.status).toBe(200)
    expect(await api.text()).toContain(title)
    const page = await ingress(() => resolveBoardPageScope(selected(`/tasks/?${query}`)))
    expect(page.ok && page.scope.boardId).toBe(boardId)
  }
  const invalid = [
    { query: "board=unavailable" },
    { query: "board=" },
    { query: `board=${boardId}&board=${boardId}` },
    { query: `board=${boardId}&board_id=unavailable` },
    { query: "board=unavailable", headers: { "x-meitheal-board-id": boardId } }
  ]
  for (const { query, headers } of invalid) {
    const api = await ingress(() => listTasks(selected(`/api/tasks?${query}`, headers)))
    expect(api.status, query).toBe(404)
    expect(await api.text()).not.toContain(title)
    for (const path of ["/tasks/", `/boards/${boardId}`]) {
      const page = await ingress(() => resolveBoardPageScope(selected(`${path}?${query}`, headers)))
      expect(page).toEqual({ ok: false, errorCode: "unavailable" })
      if (!page.ok) {
        const response = boardScopeResponse(page.errorCode)
        expect(response.status).toBe(404)
        expect(await response.text()).not.toContain(title)
      }
    }
  }
})

for (const mode of ["revoke", "expire"] as const)
  test(`actual GET directory withholds completed private component while sibling ${mode} barrier is held`, async () => {
    const originalDirectory = NamedBoardRepository.prototype.findDirectory,
      originalDestinations = BoardIntakeRepository.prototype.findDestinations
    const finished = barrier(),
      held = barrier(),
      resume = barrier(),
      realNow = Date.now
    let request: Promise<Response> | undefined
    NamedBoardRepository.prototype.findDirectory = async function (actor) {
      const result = await originalDirectory.call(this, actor)
      expect(result.some((b) => b.id === boardId)).toBe(true)
      finished.release()
      return result
    }
    BoardIntakeRepository.prototype.findDestinations = async function (actor) {
      const result = await originalDestinations.call(this, actor)
      await finished.promise
      held.release()
      await resume.promise
      return result
    }
    try {
      const before = await currentBoardGrantRevision(getPersistenceClient())
      request = ingress(() => boardDirectory(context("member"))) as Promise<Response>
      await held.promise
      if (mode === "revoke")
        expect(
          await new NamedBoardRepository(getPersistenceClient()).updateMember(
            fixturePrincipal("owner"),
            boardId,
            "member",
            null,
            ["owner", "member", "other"]
          )
        ).toMatchObject({ status: "committed" })
      else {
        const time = realNow() + 6000
        Date.now = () => time
      }
      resume.release()
      const response = await request
      expect(response.status).toBe(409)
      expect(response.headers.get("x-meitheal-board-session")).toBeNull()
      const body = await response.text()
      expect(body).not.toContain(boardId)
      expect(body).not.toContain("PRIVATE-PUBLICATION-SENTINEL")
      if (mode === "revoke")
        expect(await currentBoardGrantRevision(getPersistenceClient())).not.toBe(before)
    } finally {
      resume.release()
      Date.now = realNow
      await request?.catch(() => {})
      NamedBoardRepository.prototype.findDirectory = originalDirectory
      BoardIntakeRepository.prototype.findDestinations = originalDestinations
    }
  })

for (const mode of ["revoke", "expire"] as const)
  test(`late asynchronous SSR directory body is withheld after ${mode} before final publication`, async () => {
    const request = new Request("http://localhost/boards"),
      actor = fixturePrincipal("member", false),
      model = await readBoardDirectory(actor, request)
    const held = barrier(),
      resume = barrier(),
      realNow = Date.now
    const response = new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          held.release()
          await resume.promise
          controller.enqueue(new TextEncoder().encode(JSON.stringify(model)))
          controller.close()
        }
      }),
      {
        headers: {
          "content-type": "text/html",
          "x-meitheal-board-session": boardSessionProof("member")
        }
      }
    )
    const pending = admitBoardDirectoryResponse(request, response, true)
    await held.promise
    try {
      if (mode === "revoke")
        await new NamedBoardRepository(getPersistenceClient()).updateMember(
          fixturePrincipal("owner"),
          boardId,
          "member",
          null,
          ["owner", "member", "other"]
        )
      else {
        const time = realNow() + 61000
        Date.now = () => time
      }
      resume.release()
      const result = await pending
      expect(result.status).toBe(409)
      expect(result.headers.get("x-meitheal-board-session")).toBeNull()
      expect(await result.text()).not.toContain("PRIVATE-PUBLICATION-SENTINEL")
    } finally {
      resume.release()
      Date.now = realNow
      await pending.catch(() => {})
    }
  })

test("actual Board PATCH expires during durable journal preparation and rolls back authority and epoch", async () => {
  const db = getPersistenceClient(),
    before = await db.execute({
      sql: "SELECT name,revision FROM task_boards WHERE id=?",
      args: [boardId]
    }),
    epoch = await currentBoardGrantRevision(db),
    marker = await fs.readFile(getBoardGrantPath(db))
  const held = barrier(),
    resume = barrier(),
    original = fs.open,
    realNow = Date.now
  let paused = false,
    attempt: Promise<Response> | undefined
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (!paused && String(args[0]).includes("meitheal-board-grants-pending/") && args[1] === "wx") {
      paused = true
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        held.release()
        await resume.promise
        await sync()
      }
    }
    return handle
  }) as typeof fs.open
  syncBuiltinESMExports()
  try {
    attempt = ingress(() =>
      patchBoard(
        context("owner", "PATCH", {
          action: "rename",
          name: "MUST-ROLLBACK",
          revision: Number(before.rows[0]!.revision)
        })
      )
    ) as Promise<Response>
    await held.promise
    const time = realNow() + 6000
    Date.now = () => time
    resume.release()
    expect((await attempt).status).toBe(409)
    Date.now = realNow
    expect(
      (
        await db.execute({
          sql: "SELECT name,revision FROM task_boards WHERE id=?",
          args: [boardId]
        })
      ).rows
    ).toEqual(before.rows)
    expect(await currentBoardGrantRevision(db)).toBe(epoch)
    expect(await fs.readFile(getBoardGrantPath(db))).toEqual(marker)
    expect(await readdir(join(directory, "meitheal-board-grants-pending"))).toEqual([])
  } finally {
    resume.release()
    Date.now = realNow
    await attempt?.catch(() => {})
    fs.open = original
    syncBuiltinESMExports()
  }
})

test("current identity can intentionally remove its old Board ownership and still commit the minimal acknowledgement", async () => {
  const repo = new NamedBoardRepository(getPersistenceClient())
  expect(
    await repo.updateMember(
      fixturePrincipal("owner"),
      boardId,
      "other",
      { role: "owner", denyCompletion: false, denyDeletion: false },
      ["owner", "member", "other"]
    )
  ).toMatchObject({ status: "committed" })
  const before = await currentBoardGrantRevision(getPersistenceClient()),
    response = (await ingress(() =>
      patchBoard(context("owner", "PATCH", { action: "member", memberId: "owner", role: null }))
    )) as Response
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true })
  expect(await repo.findAccess(fixturePrincipal("owner"), boardId)).toBeNull()
  expect(await repo.findAccess(fixturePrincipal("other", false), boardId)).toMatchObject({
    role: "owner"
  })
  expect(await currentBoardGrantRevision(getPersistenceClient())).not.toBe(before)
})

test("actual API directory response cannot cross the final middleware admission after revocation", async () => {
  const ctx = context("member"),
    response = (await ingress(() => boardDirectory(ctx))) as Response
  expect(response.status).toBe(200)
  await new NamedBoardRepository(getPersistenceClient()).updateMember(
    fixturePrincipal("owner"),
    boardId,
    "member",
    null,
    ["owner", "member", "other"]
  )
  const final = await admitBoardDirectoryResponse(ctx.request, response)
  expect(final.status).toBe(409)
  expect(final.headers.get("x-meitheal-board-session")).toBeNull()
  expect(await final.text()).not.toContain("PRIVATE-PUBLICATION-SENTINEL")
})

test("aborted directory SSR admission stops without awaiting a suspended renderer", async () => {
  const cancel = new AbortController(),
    request = new Request("http://localhost/boards", { signal: cancel.signal })
  const model = await readBoardDirectory(fixturePrincipal("member", false), request),
    resume = barrier()
  const response = new Response(
    new ReadableStream({
      async start(controller) {
        await resume.promise
        controller.close()
      }
    }),
    { headers: { "content-type": "text/html" } }
  )
  const pending = admitBoardDirectoryResponse(request, response, true)
  try {
    cancel.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  } finally {
    resume.release()
    await pending.catch(() => {})
    expect(model.boards.some((x) => x.id === boardId)).toBe(true)
  }
})
