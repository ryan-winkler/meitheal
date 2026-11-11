import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test as base, type APIRequestContext, type APIResponse, type Page } from "@playwright/test"
import { taskRetryKey } from "../../apps/web/src/lib/idempotent-task-request"
import type { TaskDraftSnapshot } from "../../apps/web/src/lib/task-draft-state"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

const noStore = "private, no-store"
const namedBoard = "unavailable-board"
const taskTitle = "Retained Household task"
const draftTitle = "Retained Household draft"
const draftPath = "/api/task-drafts"
const boardDraftHeader = "X-Meitheal-Board-Id"
const snapshot = {
  version: 1, title: draftTitle, description: "", taskKind: "standard_action", status: "pending", priority: 3,
  due: "", labels: [], newLabels: [], assignedTo: "", goal: "", recurrence: "", isRoutine: false,
  checklist: { items: [], input: "" }, shopping: { items: [], input: "", quantity: "1", category: "" },
  event: { start: "", end: "", location: "", allDay: false, calendar: "" }, fields: [],
} satisfies TaskDraftSnapshot

type SendOptions = NonNullable<Parameters<APIRequestContext["fetch"]>[1]>

type BoardFixture = {
  work: string
  origin: string
  ingress: string
  request: APIRequestContext
  send: (path: string, options?: SendOptions) => Promise<APIResponse>
}

const test = base.extend<{ board: BoardFixture }>({
  board: async ({ playwright }, use) => {
    const work = await mkdtemp(join(tmpdir(), "meitheal-board-availability-"))
    const child = startCoreFixture(work)
    child.stdout?.resume()
    child.stderr?.resume()
    let request: APIRequestContext | undefined
    try {
      const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
      const origin = `https://127.0.0.1:${fixture.port}`
      const ingress = origin + fixture.configuredPath
      const api = await playwright.request.newContext({
        ignoreHTTPSErrors: true,
        extraHTTPHeaders: { cookie: "feedback-fixture=admin" },
      })
      request = api
      await use({
        work, origin, ingress, request: api,
        send: (path, options) => api.fetch(ingress + path, { maxRedirects: 0, ...options }),
      })
    } finally {
      await request?.dispose()
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
        child.kill("SIGKILL")
        await exited
      }
      await rm(work, { recursive: true, force: true })
    }
  },
})

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built App and HTTPS ingress fixture")

test("the packaged wrapper keeps selected trailing-slash and dot aliases on the guarded route", async ({ request, baseURL }) => {
  const page = await request.get("/tasks/?board=unavailable-board", { maxRedirects: 0 })
  expect(page.status()).toBe(404)
  expect(page.headers()["cache-control"]).toBe(noStore)
  expect(page.headers().location).toBeUndefined()
  const purge = await request.delete("/api/tasks/?purge=all&board_id=unavailable-board", {
    maxRedirects: 0, headers: { "sec-fetch-site": "same-origin" },
  })
  await expectUnavailable(purge, "trailing-slash scoped purge", 400)
  expect(purge.headers().location).toBeUndefined()
  const rawDot = await new Promise<{
    status: number | undefined, cache: string | undefined, location: string | undefined,
  }>((resolve, reject) => {
    const origin = new URL(baseURL!)
    const client = httpRequest({
      hostname: origin.hostname, port: origin.port, path: "/tasks/.?board=unavailable-board",
    }, response => {
      response.resume()
      resolve({ status: response.statusCode, cache: response.headers["cache-control"], location: response.headers.location })
    })
    client.on("error", reject).end()
  })
  expect(rawDot).toEqual({ status: 404, cache: noStore, location: undefined })
})

test("the keyed mutation reader refuses a stalled body with a private timeout", async () => {
  const url = new URL("http://127.0.0.1/api/tasks?purge=all")
  const init = {
    method: "DELETE",
    headers: { "content-type": "application/json", "idempotency-key": "slow-board-selector" },
    body: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("{")) },
    }),
    duplex: "half",
  }
  const request = new Request(url, init)
  try {
    const result = await taskRetryKey(request, url, "ha:fixture")
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(408)
    expect((result as Response).headers.get("cache-control")).toBe(noStore)
  } finally {
    await request.body?.cancel()
  }
})

async function expectUnavailable(response: APIResponse, path: string, status = 404) {
  const payload = await response.text()
  expect(response.status(), `${path} returned ${payload}`).toBe(status)
  expect(response.headers()["cache-control"], path).toBe(noStore)
  expect(response.headers()["idempotency-key-status"], path).toBeUndefined()
  expect(JSON.parse(payload), path).toMatchObject({
    status,
    detail: status === 400 ? "Named Boards cannot be purged here." : "Board not found.",
  })
}

async function createTask(board: BoardFixture, title: string, status = "pending") {
  const response = await board.send("/api/tasks", { method: "POST", data: { title, status } })
  expect(response.status()).toBe(201)
  return (await response.json()).id as string
}

test("named Board selectors refuse Household data at API and page entry points", async ({ board }) => {
  const id = await createTask(board, taskTitle)
  const list = await board.send("/api/tasks")
  expect(list.status()).toBe(200)
  expect(await list.json()).toMatchObject({ tasks: [expect.objectContaining({ id, title: taskTitle })] })
  expect(await (await board.send(`/api/tasks/${id}`)).json()).toMatchObject({ id, title: taskTitle })
  const lanes = await board.send("/api/lanes")
  expect(lanes.status()).toBe(200)
  expect((await lanes.json()).lanes.length).toBeGreaterThan(0)
  const search = await board.send(`/api/search?scope=tasks&q=${encodeURIComponent(taskTitle)}`)
  expect(search.status()).toBe(200)
  expect(await search.text()).toContain(taskTitle)

  const selectedReads = [
    `/api/tasks?board_id=${namedBoard}`,
    "/api/tasks?%62oard_id=&board_id=household",
    `/api/tasks?board_name=${namedBoard}`,
    `/api/%74asks?board_id=${namedBoard}`,
    `/api/tasks/${id}?board_id=${namedBoard}`,
    `/api/tasks/${id}/comments?board_id=${namedBoard}`,
    `/api/lanes?board_id=${namedBoard}`,
    `/api/search?scope=tasks&q=${encodeURIComponent(taskTitle)}&board_id=${namedBoard}`,
  ]
  for (const path of selectedReads) {
    const response = await board.send(path)
    await expectUnavailable(response, path)
    expect(await response.text(), path).not.toContain(taskTitle)
  }

  for (const path of ["/tasks", `/tickets/${id}`]) {
    expect((await board.send(path)).status(), path).toBe(200)
    const scoped = await board.send(`${path}?board=&board=${namedBoard}`)
    expect(scoped.status(), path).toBe(404)
    expect(scoped.headers()["cache-control"], path).toBe(noStore)
    expect(await scoped.text(), path).toBe("Board not found.")
    expect((await board.send(`${path}?board_id=${namedBoard}`)).status(), path).toBe(404)
  }

  const direct = await board.request.get(`${board.origin}/api/tasks?board_id=${namedBoard}`)
  expect(direct.status()).toBe(401)
  const badToken = await board.send(`/api/tasks?board_id=${namedBoard}`, {
    headers: { authorization: "Bearer mth_fixture-invalid" },
  })
  expect(badToken.status()).toBe(401)
})

test("named Board mutations preserve existing tasks, lanes and unscoped idempotent replays", async ({ board }) => {
  const key = { "Idempotency-Key": "household-create-fixture" }
  const task = { title: taskTitle }
  const warm = { method: "POST", headers: key, data: task }
  const created = await board.send("/api/tasks", warm)
  expect(created.status()).toBe(201)
  expect(created.headers()["idempotency-key-status"]).toBe("processed")
  const id = (await created.json()).id as string
  const replay = await board.send("/api/tasks", warm)
  expect(replay.headers()["idempotency-key-status"]).toBe("cached")
  expect(await replay.json()).toMatchObject({ id })

  const second = await createTask(board, "Retained reorder anchor")
  const old = await createTask(board, "Retained old completion", "complete")
  const today = await createTask(board, "Retained recent completion", "complete")
  const lane = await board.send("/api/lanes", { method: "POST", data: { label: "Retained Household lane" } })
  expect(lane.status()).toBe(201)
  const laneId = (await lane.json()).id as string
  const database = new DatabaseSync(join(board.work, "pins.db"))
  try {
    const update = database.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
    update.run(1, old)
    update.run(new Date().toISOString(), today)
    const readStored = () => ({
      tasks: database.prepare("SELECT * FROM tasks ORDER BY id").all(),
      lanes: database.prepare("SELECT * FROM kanban_lanes ORDER BY id").all(),
      activity: database.prepare("SELECT * FROM task_activity_log ORDER BY rowid").all(),
      retention: database.prepare("SELECT * FROM audit_trail WHERE request_id = 'retention-delete' ORDER BY rowid").all(),
    })
    const before = readStored()
    const retention = "/api/tasks/delete-completed?months=3"
    const confirmed = retention + "&confirm=true"
    const preview = await board.send(retention)
    expect(preview.status()).toBe(200)
    expect(await preview.json()).toMatchObject({ count: 1 })

    const selected = { board_id: namedBoard }
    const mutations: [string, SendOptions, number?][] = [
      [`/api/tasks?board_id=${namedBoard}`, warm],
      ["/api/tasks", { ...warm, data: { ...task, board_id: null } }],
      ["/api/tasks/create", { method: "POST", data: { ...task, board_name: namedBoard } }],
      [`/api/tasks/${id}`, { method: "PUT", data: { title: "Changed title", ...selected } }],
      [`/api/tasks/${id}`, { method: "PATCH", data: { title: "Changed title", ...selected } }],
      [`/api/tasks/${id}/time`, { method: "POST", data: { action: "start", ...selected } }],
      [`/api/tasks/${id}/links`, { method: "POST", data: { target_task_id: second, link_type: "relates_to", ...selected } }],
      [`/api/tasks/${id}/duplicate`, { method: "POST", data: selected }],
      [`/api/tasks/${id}/comments`, { method: "POST", data: { content: "Unexpected comment", ...selected } }],
      [`/api/tasks/${id}/reactions`, { method: "POST", data: { content: "👍", ...selected } }],
      ["/api/tasks/reorder", { method: "POST", data: { ordered_ids: [second, id], ...selected } }],
      ["/api/lanes", { method: "POST", data: { label: "Unexpected lane", ...selected } }],
      [`/api/lanes/${laneId}`, { method: "PUT", data: { label: "Changed lane", ...selected } }],
      [`/api/lanes/${laneId}?board_id=${namedBoard}`, { method: "DELETE" }],
      [`/api/lanes/${laneId}`, { method: "DELETE", data: selected }],
      [`/api/tasks/${id}?board_id=${namedBoard}`, { method: "DELETE" }],
      [`/api/tasks/${id}`, { method: "DELETE", data: selected }],
      [`${retention}&board_id=${namedBoard}`, { method: "GET" }],
      [`${confirmed}&board_id=${namedBoard}`, { method: "DELETE" }],
      [confirmed, { method: "DELETE", data: selected }],
      [`/api/tasks/clear-completed?board_id=${namedBoard}`, { method: "POST" }],
      ["/api/tasks/clear-completed", { method: "POST", data: selected }],
      [`/api/tasks?purge=all&board_id=${namedBoard}`, { method: "DELETE" }, 400],
      ["/api/tasks?purge=all", { method: "DELETE", data: selected }, 400],
    ]
    for (const [path, options, status] of mutations) {
      const response = await board.send(path, options)
      await expectUnavailable(response, `${options.method} ${path}`, status)
      expect(await response.json(), path).not.toHaveProperty("count")
    }
    for (const [data, mediaType, status] of [
      [`board_id=${namedBoard}`, "application/x-www-form-urlencoded", 415],
      ["{}", "not-a-media-type+json", 415],
      ["{", "application/json", 400],
      [JSON.stringify(JSON.stringify(selected)), "application/json", 400],
      [JSON.stringify({ text: "x".repeat(64 * 1024) }), "application/json", 413],
    ] as const) {
      const response = await board.send("/api/tasks?purge=all", {
        method: "DELETE", data: Buffer.from(data), headers: { "content-type": mediaType },
      })
      expect(response.status(), mediaType).toBe(status)
      expect(response.headers()["cache-control"], mediaType).toBe(noStore)
      expect(await response.json(), mediaType).not.toHaveProperty("purged")
    }
    const structuredJson = await board.send("/api/tasks?purge=all", {
      method: "DELETE", data: Buffer.from(JSON.stringify(selected)),
      headers: { "content-type": "application/vnd.meitheal+json; charset=utf-8" },
    })
    await expectUnavailable(structuredJson, "structured JSON scoped purge", 400)
    const keyedOversize = await board.send("/api/tasks?purge=all", {
      method: "DELETE",
      data: { board_id: namedBoard, padding: "x".repeat(64 * 1024) },
      headers: { "idempotency-key": "keyed-oversized-board" },
    })
    expect(keyedOversize.status()).toBe(413)
    expect(keyedOversize.headers()["cache-control"]).toBe(noStore)
    expect(readStored()).toEqual(before)

    const repeated = await board.send("/api/tasks", warm)
    expect(repeated.headers()["idempotency-key-status"]).toBe("cached")
    expect(await repeated.json()).toMatchObject({ id })
    const clear = await board.send("/api/tasks/clear-completed", { method: "POST" })
    expect(clear.status()).toBe(200)
    expect(await clear.json()).toMatchObject({ cleared: 1 })
    const deletion = await board.send(confirmed, { method: "DELETE" })
    expect(deletion.status()).toBe(200)
    expect(await deletion.json()).toMatchObject({ deleted: 1 })
    expect(database.prepare("SELECT id FROM tasks WHERE id = ?").get(id)).toMatchObject({ id })
    const purge = await board.send("/api/tasks?purge=all", { method: "DELETE" })
    expect(purge.status()).toBe(200)
    expect(await purge.json()).toMatchObject({ purged: true })
    expect(database.prepare("SELECT id FROM tasks").all()).toEqual([])
  } finally {
    database.close()
  }
})

async function draftRequest(page: Page, path: string, method: "POST" | "PUT" | "HEAD",
  data?: object, headers: Record<string, string> = {}) {
  return page.evaluate(async ({ path, method, data, headers }) => {
    const response = await fetch(path, {
      method, mode: "same-origin", referrerPolicy: "same-origin", cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(5_000),
      headers: { ...(data ? { "content-type": "application/json" } : {}), ...headers },
      ...(data ? { body: JSON.stringify(data) } : {}),
    })
    return { status: response.status, cache: response.headers.get("cache-control"), text: await response.text() }
  }, { path, method, data, headers })
}

test("named draft selectors preserve the Household draft and context through HTTPS ingress", async ({ board }) => {
  const unauthorized = await board.send(draftPath, {
    method: "POST", headers: { [boardDraftHeader]: namedBoard }, data: { action: "read" },
  })
  expect(unauthorized.status()).toBe(403)
  expect(unauthorized.headers()["cache-control"]).toBe(noStore)

  const browser = await launchPinBrowser(board.work)
  try {
    const context = await browser.newContext({ serviceWorkers: "block", extraHTTPHeaders: {} })
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: board.origin }])
    const page = await context.newPage()
    expect((await page.goto(board.ingress + "/fixture"))?.ok()).toBe(true)
    const path = new URL(board.ingress).pathname + draftPath
    const read = { action: "read" }
    const initial = await draftRequest(page, path, "POST", read)
    expect(initial).toMatchObject({ status: 200, cache: noStore })
    const draftContext = JSON.parse(initial.text).context as string
    const lease = { "X-Meitheal-Draft-Context": draftContext }
    const save = { action: "save", expected: null, attemptId: crypto.randomUUID(), snapshot }
    const saved = await draftRequest(page, path, "PUT", save, lease)
    expect(saved.status).toBe(200)
    const { draftId, revision } = JSON.parse(saved.text).draft
    const discard = { action: "discard", expected: { draftId, revision } }
    expect(await draftRequest(page, path, "HEAD", undefined, lease))
      .toEqual({ status: 204, cache: noStore, text: "" })

    const selected = { ...lease, [boardDraftHeader]: namedBoard }
    const head = await draftRequest(page, path, "HEAD", undefined, selected)
    const responses = [
      head,
      await draftRequest(page, path, "POST", read, { [boardDraftHeader]: "" }),
      await draftRequest(page, path, "PUT", discard, selected),
      await draftRequest(page, path, "POST", { ...read, board_id: namedBoard }),
      await draftRequest(page, path, "PUT", { ...discard, board_id: namedBoard }, lease),
    ]
    for (const response of responses) {
      expect(response).toMatchObject({ status: 404, cache: noStore })
      expect(response.text).not.toContain(draftTitle)
      expect(response.text).not.toContain(draftContext)
      if (response.text) expect(JSON.parse(response.text)).not.toHaveProperty("draft")
    }
    expect(head.text).toBe("")
    const retained = await draftRequest(page, path, "POST", read)
    expect(retained.status).toBe(200)
    expect(JSON.parse(retained.text)).toMatchObject({
      context: draftContext, draft: { draftId, revision, snapshot: { title: draftTitle } },
    })
  } finally {
    await browser.close()
  }
})
