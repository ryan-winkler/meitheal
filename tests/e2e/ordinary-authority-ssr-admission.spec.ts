import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
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
import { resolveBoardPageScope } from "../../apps/web/src/lib/board-http"
import { admitBoardResponse, retainBoardResponseScope } from "../../apps/web/src/lib/board-view"
import { getTasksForView } from "../../apps/web/src/lib/task-queries"
import { rewriteIngressHtml } from "../../apps/web/src/lib/rewrite-ingress-html"
import { TASK_REFRESH_FRAGMENT_HEADER } from "../../apps/web/src/lib/task-view-route"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"

const barrier = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const transport = {
  peer: "172.30.32.2",
  fromSupervisor: true,
  identityHeadersSafe: true,
  configuredPath: "/api/hassio_ingress/test"
}
const ingress = <T>(work: () => T) => runWithIngressTransport(transport, work)
const sentinel = "PRIVATE-SSR-TASK-SENTINEL"
const name = "PRIVATE-SSR-BOARD-SENTINEL"
let directory: string, boardId: string, stopCore: () => Promise<void>
const previous = process.env.MEITHEAL_DB_URL
function pageContext(path: string, signal?: AbortSignal, compact = false) {
  const url = new URL(path, "http://localhost")
  return {
    url,
    params: {},
    locals: {
      behindIngress: true,
      hassUserId: "member",
      hassIsAdmin: false,
      ingressPath: "/api/hassio_ingress/test",
      requestId: "ssr-admission-fixture",
      timezone: "Europe/Dublin",
      weekStart: "monday",
      dateFormat: "relative" as const,
      automationSource: "browser",
      agentId: "",
      traceId: "",
      spanId: "",
      traceFlags: ""
    },
    request: new Request(url, {
      ...(signal ? { signal } : {}),
      ...(compact ? { headers: { [TASK_REFRESH_FRAGMENT_HEADER]: "1" } } : {})
    })
  }
}
async function removeMember() {
  expect(
    await new NamedBoardRepository(getPersistenceClient()).updateMember(
      fixturePrincipal("owner"),
      boardId,
      "member",
      null,
      ["owner", "member"]
    )
  ).toMatchObject({ status: "committed" })
}
async function projection(context: ReturnType<typeof pageContext>) {
  const resolved = await ingress(() => resolveBoardPageScope(context))
  if (!resolved.ok) throw new Error(resolved.errorCode)
  const model = await getTasksForView({ requireAvailable: true, slim: true }, resolved.scope)
  expect(model.tasks.map((task) => task.title)).toContain(sentinel)
  return { resolved, model }
}
const responseWith = (text: string, resume: Promise<void>) =>
  new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        await resume
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      }
    }),
    { headers: { "content-type": "text/html", "x-meitheal-board-session": "private-proof" } }
  )
async function finalResponse(context: ReturnType<typeof pageContext>, response: Response) {
  const rewritten = await rewriteIngressHtml(response, "/api/hassio_ingress/test", {
    signal: context.request.signal
  })
  return admitBoardResponse(context.request, rewritten, true)
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ordinary-ssr-admission-"))
  process.env.MEITHEAL_DB_URL = "file:" + join(directory, "test.db")
  await ensureSchema()
  stopCore = await startCoreRosterFixture(["owner", "member"])
  const db = getPersistenceClient(),
    repo = new NamedBoardRepository(db)
  const created = await repo.create(fixturePrincipal("owner"), name)
  if (created.status !== "committed") throw new Error("Board fixture")
  boardId = created.result.id
  expect(
    await repo.updateMember(
      fixturePrincipal("owner"),
      boardId,
      "member",
      { role: "member", denyCompletion: false, denyDeletion: false },
      ["owner", "member"]
    )
  ).toMatchObject({ status: "committed" })
  const taskRepo = new TaskRepository(
    db,
    await currentBoardScope(db, boardId, fixturePrincipal("owner"), {
      resource: "task",
      action: "create"
    })
  )
  const prepared = await prepareTaskCreation(
    taskRepo,
    { title: sentinel },
    { useDefaultAssignee: false }
  )
  if (!prepared.ok) throw new Error(prepared.error)
  expect((await taskRepo.createWorkCommand(prepared.task)).ok).toBe(true)
})
test.afterEach(async () => {
  await stopCore()
  resetPersistenceForTests()
  if (previous === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previous
  await rm(directory, { recursive: true, force: true })
})

for (const compact of [false, true])
  for (const view of ["table", "kanban"])
    for (const failure of ["revoke", "expire"] as const) {
      test(`${compact ? "compact fragment" : "full Board page"} ${view} withholds completed task projection after ${failure}`, async () => {
        const context = pageContext(
          `/boards/${boardId}?view=${view}${compact ? `&${view === "table" ? "tableRefresh" : "boardRefresh"}=1` : ""}`,
          undefined,
          compact
        )
        const { model } = await projection(context)
        const resume = barrier(),
          realNow = Date.now
        const content = `<main data-board="${boardId}"><a href="/tasks">${name}</a><span>${model.counts.total}</span>${model.tasks.map((task) => task.title).join("")}</main>`
        const pending = finalResponse(
          context,
          responseWith(
            compact ? content : `<html><head></head><body>${content}</body></html>`,
            resume.promise
          )
        )
        try {
          if (failure === "revoke") await removeMember()
          else {
            const expired = realNow() + 6000
            Date.now = () => expired
          }
          resume.release()
          const response = await pending
          expect(response.status).toBe(409)
          expect(response.headers.get("x-meitheal-board-session")).toBeNull()
          expect(response.headers.get("cache-control")).toBe("private, no-store")
          const body = await response.text()
          for (const privateValue of [sentinel, name, boardId])
            expect(body).not.toContain(privateValue)
        } finally {
          resume.release()
          Date.now = realNow
          await pending.catch(() => {})
        }
      })
    }

for (const compact of [false, true])
  test(`current ${compact ? "compact" : "full"} projection preserves rewritten content and headers`, async () => {
    const context = pageContext(
      `/tasks?board=${boardId}&view=table${compact ? "&tableRefresh=1" : ""}`,
      undefined,
      compact
    )
    await projection(context)
    const response = await finalResponse(
      context,
      responseWith(
        compact
          ? `<a href="/tasks">${sentinel}</a>`
          : `<html><head></head><body><a href="/tasks">${sentinel}</a></body></html>`,
        Promise.resolve()
      )
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("x-meitheal-board-session")).toBe("private-proof")
    expect(await response.text()).toContain(`/api/hassio_ingress/test/tasks`)
  })

test("a scope registered by lazy rendering is retained before publication", async () => {
  const context = pageContext(`/boards/${boardId}?view=table`),
    resume = barrier(),
    read = barrier()
  const body = new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const { model } = await projection(context)
        read.release()
        await resume.promise
        controller.enqueue(new TextEncoder().encode(model.tasks[0]!.title))
        controller.close()
      }
    }),
    { headers: { "content-type": "text/html" } }
  )
  const pending = admitBoardResponse(context.request, body, true)
  await read.promise
  try {
    await removeMember()
    resume.release()
    const result = await pending
    expect(result.status).toBe(409)
    expect(await result.text()).not.toContain(sentinel)
  } finally {
    resume.release()
    await pending.catch(() => {})
  }
})

test("a newer still-authorized Layout scope cannot replace the projection's original epoch", async () => {
  const context = pageContext(`/boards/${boardId}?view=table`)
  await projection(context)
  // Same member still allowed, but the intentionally changed Board epoch is different.
  expect(
    await new NamedBoardRepository(getPersistenceClient()).updateMember(
      fixturePrincipal("owner"),
      boardId,
      "member",
      { role: "viewer", denyCompletion: true, denyDeletion: true },
      ["owner", "member"]
    )
  ).toMatchObject({ status: "committed" })
  const refreshed = await ingress(() => resolveBoardPageScope(context))
  expect(refreshed.ok).toBe(true)
  const response = await finalResponse(context, responseWith(sentinel, Promise.resolve()))
  expect(response.status).toBe(409)
  expect(await response.text()).not.toContain(sentinel)
})

test("retained operations are revalidated instead of treating every scope as generic task read", async () => {
  const context = pageContext(`/boards/${boardId}`)
  const { resolved } = await projection(context)
  retainBoardResponseScope(context.request, resolved.scope, { resource: "board", action: "manage" })
  const response = await finalResponse(context, responseWith(sentinel, Promise.resolve()))
  expect(response.status).toBe(403)
  expect(await response.text()).not.toContain(sentinel)
})

test("a governed lazy body can abort before registering or publishing private content", async () => {
  const abort = new AbortController(),
    context = pageContext(`/tasks?board=${boardId}`, abort.signal),
    resume = barrier()
  const pending = admitBoardResponse(context.request, responseWith(sentinel, resume.promise), true)
  abort.abort(new DOMException("Cancelled", "AbortError"))
  try {
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  } finally {
    resume.release()
  }
})
