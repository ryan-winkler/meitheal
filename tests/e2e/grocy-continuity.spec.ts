import { integrationFixture } from "../helpers/ordinary-integration-fixture"
import { createGrocyClient } from "../../apps/web/src/lib/grocy-client"
import { validateIntegrationScope } from "../../apps/web/src/domains/tasks/board-automation"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { GrocyAdapter } from "../../packages/integration-core/src/grocy-adapter"
import {
  getGrocySyncStatus,
  pushCompletionToGrocy,
  pushNewTaskToGrocy,
  startGrocySync,
  stopGrocySync,
  syncFromGrocy
} from "../../apps/web/src/domains/grocy/grocy-bridge"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests
} from "../helpers/persistence-fixture"

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let fixture: Awaited<ReturnType<typeof integrationFixture>>
let originalFetch: typeof fetch
let work: string
let marker: string
let previousDb: string | undefined

test.beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "grocy-continuity-"))
  marker = join(work, "grants.json")
  previousDb = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = "file:" + join(work, "tasks.db")
  resetPersistenceForTests()
  await ensureSchema({ markerPath: marker })
  fixture = await integrationFixture({
    integration: "grocy",
    sourceId: "configured-grocy",
    purpose: "grocy.sync"
  })
  originalFetch = globalThis.fetch
})
test.afterEach(async () => {
  stopGrocySync()
  globalThis.fetch = originalFetch
  resetPersistenceForTests()
  if (previousDb === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previousDb
  await rm(work, { recursive: true, force: true })
})

async function localProvider() {
  const calls: string[] = []
  const posted = deferred()
  const releasePost = deferred()
  let holdPost = false
  let failChores = false
  const server = createServer(async (req, res) => {
    req.resume()
    calls.push(`${req.method} ${req.url}`)
    if (failChores && req.url === "/api/chores") {
      res.writeHead(503, { "content-type": "application/json" }).end("{}")
    } else if (req.method === "POST" && req.url === "/api/objects/tasks") {
      posted.resolve()
      if (holdPost) await releasePost.promise
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ created_object_id: 44 }))
    } else res.writeHead(200, { "content-type": "application/json" }).end("[]")
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing provider address")
  const origin = "http://grocy-continuity.example"
  globalThis.fetch = ((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== origin) throw new Error("Unexpected fixture provider")
    url.hostname = "127.0.0.1"
    url.port = String(address.port)
    return originalFetch(url, init)
  }) as typeof fetch
  await getPersistenceClient().execute({
    sql: "INSERT INTO settings(key,value) VALUES('grocy_url',?),('grocy_api_key',?)",
    args: [JSON.stringify(origin), JSON.stringify("synthetic-grocy-key")]
  })
  const adapter = await createGrocyClient()
  if (!adapter) throw new Error("Actual configured Grocy factory unavailable")
  return {
    calls,
    adapter,
    posted,
    releasePost,
    failChores() {
      failChores = true
    },
    hold() {
      holdPost = true
    },
    async close() {
      releasePost.resolve()
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    }
  }
}

async function start(provider: Awaited<ReturnType<typeof localProvider>>) {
  const prior = (await getGrocySyncStatus()).lastSyncAt
  await startGrocySync(
    {
      bindingId: fixture.binding.id,
      generation: fixture.binding.generation,
      syncEnabled: true,
      syncMode: "bidirectional",
      intervalMs: 0
    },
    provider.adapter
  )
  await expect.poll(async () => (await getGrocySyncStatus()).lastSyncAt).not.toBe(prior)
  expect((await getGrocySyncStatus()).lastSyncError).toBeNull()
  expect(provider.calls).toHaveLength(5)
}
async function makeUnavailable(kind: "missing" | "retired") {
  if (kind === "missing") await rm(marker)
  else
    expect(
      await new NamedBoardRepository(getPersistenceClient()).changeLifecycle(
        fixture.scope.principal,
        "household",
        "retired",
        1,
        true
      )
    ).toMatchObject({ status: "committed", result: "saved" })
}

for (const kind of ["missing", "retired"] as const) {
  test(`Grocy polling and outbound work do not dispatch with ${kind} Household authority`, async () => {
    const provider = await localProvider()
    try {
      await start(provider)
      const lastSuccess = (await getGrocySyncStatus()).lastSyncAt
      await makeUnavailable(kind)
      const calls = [...provider.calls]
      await expect(syncFromGrocy(fixture.binding.id)).rejects.toThrow(
        /unavailable|locked|continuity/i
      )
      expect(provider.calls).toEqual(calls)
      if (kind === "missing")
        await expect(getGrocySyncStatus()).rejects.toThrow(/unavailable|locked|continuity/i)
      else expect((await getGrocySyncStatus()).lastSyncAt).toBe(lastSuccess)
      expect(await pushNewTaskToGrocy(fixture.context, "cached-task", "Private cached title")).toBe(
        false
      )
      expect(await pushCompletionToGrocy("cached-task", fixture.context)).toBe(false)
      expect(provider.calls).toEqual(calls)
    } finally {
      await provider.close()
    }
  })

  test(`an admitted Grocy create cannot save its confirmation after ${kind} authority`, async () => {
    const provider = await localProvider()
    try {
      await start(provider)
      const db = getPersistenceClient()
      await db.execute(
        "INSERT INTO tasks(id, title, status, idempotency_key, request_id, created_at, updated_at) VALUES ('cached-task', 'Private cached title', 'pending', 'cached-task', 'cached-task', 1, 1)"
      )
      provider.hold()
      const pending = pushNewTaskToGrocy(fixture.context, "cached-task", "Private cached title")
      await provider.posted.promise
      await makeUnavailable(kind)
      const before = (await db.execute("SELECT * FROM grocy_sync_confirmations")).rows
      provider.releasePost.resolve()
      expect(await pending).toBe(false)
      expect((await db.execute("SELECT * FROM grocy_sync_confirmations")).rows).toEqual(before)
      expect(provider.calls.filter((call) => call.startsWith("POST"))).toEqual([
        "POST /api/objects/tasks"
      ])
    } finally {
      await provider.close()
    }
  })
}

for (const kind of ["missing", "retired"] as const) {
  test(`the actual Grocy adapter checks ${kind} authority at the final fetch boundary`, async () => {
    const provider = await localProvider()
    const entered = deferred()
    const release = deferred()
    let gated = false
    const adapter = provider.adapter.withOperationAllowed(async () => {
      if (gated) {
        entered.resolve()
        await release.promise
      }
      return (
        await validateIntegrationScope(fixture.context, getPersistenceClient(), {
          resource: "task",
          action: "read"
        })
      ).ok
    })
    try {
      expect((await adapter.getProducts()).ok).toBe(true)
      const calls = [...provider.calls]
      gated = true
      const pending = adapter.createTask("Private provider-boundary title")
      await entered.promise
      await makeUnavailable(kind)
      release.resolve()
      expect(await pending).toMatchObject({
        ok: false,
        errorCode: "service_unavailable",
        retryable: false
      })
      expect(provider.calls).toEqual(calls)
    } finally {
      release.resolve()
      await provider.close()
    }
  })

  test(`a queued Grocy retry rechecks ${kind} authority instead of sending a second request`, async () => {
    const provider = await localProvider()
    provider.failChores()
    const scheduled = deferred()
    const release = deferred()
    const original = globalThis.setTimeout
    const gatedTimeout = ((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 2000) {
        scheduled.resolve()
        return original(() => {
          void release.promise.then(() => callback(...args))
        }, 0)
      }
      return original(callback, delay, ...args)
    }) as typeof setTimeout
    globalThis.setTimeout = gatedTimeout
    try {
      await startGrocySync(
        {
          bindingId: fixture.binding.id,
          generation: fixture.binding.generation,
          syncEnabled: true,
          syncMode: "bidirectional",
          intervalMs: 0
        },
        provider.adapter
      )
      const pending = syncFromGrocy(fixture.binding.id)
      await scheduled.promise
      await makeUnavailable(kind)
      release.resolve()
      const result = await pending
      expect(result.errors).toBeGreaterThan(0)
      expect(provider.calls.filter((call) => call === "GET /api/chores")).toHaveLength(1)
      expect(provider.calls).toHaveLength(3)
      if (kind === "missing")
        await expect(getGrocySyncStatus()).rejects.toThrow(/unavailable|locked|continuity/i)
      else expect((await getGrocySyncStatus()).lastSyncError).toContain("unavailable")
    } finally {
      globalThis.setTimeout = original
      release.resolve()
      await provider.close()
    }
  })

  test(`already configured polling ticks do not fetch Grocy while ${kind}`, async () => {
    const provider = await localProvider()
    try {
      const ticked = deferred()
      let ticks = 0
      const original = globalThis.setInterval
      globalThis.setInterval = ((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) => {
        return original(() => {
          callback(...args)
          if (++ticks === 3) ticked.resolve()
        }, delay)
      }) as typeof setInterval
      try {
        await startGrocySync(
          {
            bindingId: fixture.binding.id,
            generation: fixture.binding.generation,
            syncEnabled: true,
            syncMode: "bidirectional",
            intervalMs: 10
          },
          provider.adapter
        )
      } finally {
        globalThis.setInterval = original
      }
      await expect.poll(async () => (await getGrocySyncStatus()).lastSyncAt).not.toBeNull()
      await makeUnavailable(kind)
      const calls = [...provider.calls]
      await ticked.promise
      if (kind === "missing")
        await expect(getGrocySyncStatus()).rejects.toThrow(/unavailable|locked|continuity/i)
      else
        await expect
          .poll(async () => (await getGrocySyncStatus()).lastSyncError)
          .toContain("unavailable")
      stopGrocySync()
      expect(ticks).toBeGreaterThanOrEqual(3)
      expect(provider.calls).toEqual(calls)
    } finally {
      await provider.close()
    }
  })
}
