import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { currentBoardScope } from "../helpers/current-board-scope"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"

let directory: string, previousUrl: string | undefined
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-read-admission-"))
  previousUrl = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "work.db")}`
  await ensureSchema()
})
test.afterEach(async () => {
  resetPersistenceForTests()
  if (previousUrl === undefined) delete process.env.MEITHEAL_DB_URL; else process.env.MEITHEAL_DB_URL = previousUrl
  await rm(directory, { recursive: true, force: true })
})
test("a finite concurrent planning read burst drains without exceeding the SQLite connection cap", async () => {
  const db = getPersistenceClient(), scope = await currentBoardScope(db), hierarchy = new HierarchyRepository(db, scope)
  const id = crypto.randomUUID()
  await hierarchy.createArea({ id, name: "Concurrent current Area" })
  const outcomes = await Promise.allSettled(Array.from({ length: 60 }, () => hierarchy.findAreaById(id)))
  expect(outcomes.filter(outcome => outcome.status === "rejected")).toEqual([])
  for (const outcome of outcomes) if (outcome.status === "fulfilled") expect(outcome.value?.id).toBe(id)
  // The burst leaves no held lease: another full read wave is independently safe.
  const later = await Promise.allSettled(Array.from({ length: 60 }, () => hierarchy.findAreaById(id)))
  expect(later.filter(outcome => outcome.status === "rejected")).toEqual([])
})

test("nineteen held readers queue in FIFO order and reserve only released slots", async () => {
  const db = getPersistenceClient(), held = await Promise.all(Array.from({ length: 19 }, () => db.transaction("read")))
  const order: number[] = []
  const pending = [0, 1, 2].map(index => db.transaction("read").then(tx => { order.push(index); return tx }))
  try {
    await Promise.resolve()
    expect(order).toEqual([])
    held[0]!.close()
    const first = await pending[0]!
    expect(order).toEqual([0])
    expect((await first.execute("SELECT 1 AS current")).rows[0]?.current).toBe(1)
    first.close()
    const second = await pending[1]!
    expect(order).toEqual([0, 1])
    second.close()
    const third = await pending[2]!
    expect(order).toEqual([0, 1, 2])
    third.close()
  } finally { for (const tx of held) tx.close() }
})

test("the 64-reader pending bound rejects overload and close rejects every remaining waiter", async () => {
  const db = getPersistenceClient(), held = await Promise.all(Array.from({ length: 19 }, () => db.transaction("read")))
  const outcomes = Array.from({ length: 65 }, () => db.transaction("read").then(tx => ({ tx, error: null }), error => ({ tx: null, error })))
  expect((await outcomes[64]!)?.error).toMatchObject({ code: "TRANSACTION_ACTIVE" })
  db.close()
  const settled = await Promise.all(outcomes)
  expect(settled.slice(0, 64).every(outcome => outcome.tx === null && outcome.error?.code === "CLIENT_CLOSED")).toBe(true)
  expect(held.every(tx => tx.closed)).toBe(true)
})

test("read admission has a five-second deadline and the client remains usable after holders release", async () => {
  const db = getPersistenceClient(), held = await Promise.all(Array.from({ length: 19 }, () => db.transaction("read")))
  const started = Date.now()
  try {
    await expect(db.transaction("read")).rejects.toMatchObject({ code: "TRANSACTION_ACTIVE", message: expect.stringContaining("deadline") })
    expect(Date.now() - started).toBeGreaterThanOrEqual(4500)
  } finally { for (const tx of held) tx.close() }
  const resumed = await db.transaction("read")
  expect((await resumed.execute("SELECT 1 AS recovered")).rows[0]?.recovered).toBe(1)
  resumed.close()
})

test("a queued planning read revalidates authority after admission and cannot publish the old snapshot", async () => {
  const { openDatabaseForStartup } = await import("../../apps/web/scripts/database-client.mjs")
  const { NamedBoardRepository } = await import("../../apps/web/src/domains/tasks/persistence/named-board-repository")
  const { fixturePrincipal } = await import("../helpers/current-board-scope")
  const db = getPersistenceClient(), scope = await currentBoardScope(db), hierarchy = new HierarchyRepository(db, scope)
  const id = crypto.randomUUID()
  await hierarchy.createArea({ id, name: "Withhold after current authority changes" })
  const held = await Promise.all(Array.from({ length: 19 }, () => db.transaction("read")))
  const pending = hierarchy.findAreaById(id).then(value => ({ value, error: null }), error => ({ value: null, error }))
  const { getBoardGrantPath } = await import("../../apps/web/scripts/board-grant-context.mjs")
  const external = await openDatabaseForStartup(process.env.MEITHEAL_DB_URL!, { markerPath: getBoardGrantPath(db) })
  try {
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((await new NamedBoardRepository(external).create(fixturePrincipal(), "New current authority")).status).toBe("committed")
    held[0]!.close()
    const outcome = await pending
    expect(outcome.value).toBeNull()
    expect(outcome.error).toMatchObject({ status: 409, errorCode: "stale", message: "Current permissions changed. Retry the operation with current authority." })
  } finally { for (const tx of held) tx.close(); external.close() }
})

test("an actual queued Area HTTP read returns no-store409 after a committed epoch change", async () => {
  const { runWithIngressTransport } = await import("../../apps/web/scripts/ingress-transport.mjs")
  const { verifiedBoardRequestPrincipal } = await import("../../apps/web/src/lib/board-request-context")
  const { boardSessionProof } = await import("../../apps/web/src/lib/named-board-request")
  const { GET } = await import("../../apps/web/src/pages/api/areas/[id]")
  const { NamedBoardRepository } = await import("../../apps/web/src/domains/tasks/persistence/named-board-repository")
  const { openDatabaseForStartup } = await import("../../apps/web/scripts/database-client.mjs")
  const { getBoardGrantPath } = await import("../../apps/web/scripts/board-grant-context.mjs")
  await runWithIngressTransport({ peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }, async () => {
    const principal = await verifiedBoardRequestPrincipal({ request: new Request("http://localhost/boards"), locals: {} as App.Locals })
    if (!principal) throw new Error("Actual operator required")
    const db = getPersistenceClient(), scope = await currentBoardScope(db, "household", principal)
    const id = crypto.randomUUID()
    await new HierarchyRepository(db, scope).createArea({ id, name: "TOP SECRET QUEUED AREA" })
    const held = await Promise.all(Array.from({ length: 19 }, () => db.transaction("read")))
    const original = db.transaction.bind(db)
    let entered!: () => void
    const queued = new Promise<void>(resolve => { entered = resolve })
    db.transaction = async (mode?: "read" | "write" | "deferred") => { if (mode === "read") entered(); return original(mode) }
    const external = await openDatabaseForStartup(process.env.MEITHEAL_DB_URL!, { markerPath: getBoardGrantPath(db) })
    try {
      const url = new URL(`http://localhost/api/areas/${id}`)
      const pending = GET({ url, params: { id }, locals: {}, request: new Request(url, { headers: { "X-Meitheal-Board-Id": "household", "X-Meitheal-Board-Session": boardSessionProof(principal.id) } }) } as unknown as Parameters<typeof GET>[0])
      await queued
      expect((await new NamedBoardRepository(external).create(principal, "New current epoch")).status).toBe("committed")
      held[0]!.close()
      const response = await pending
      expect(response.status).toBe(409)
      expect(response.headers.get("cache-control")).toContain("no-store")
      expect(await response.text()).not.toContain("TOP SECRET")
    } finally { db.transaction = original; for (const tx of held) tx.close(); external.close() }
  })
})
