import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"

// These routed module origins use the browser Origin, not the unrelated App-server fixture Origin.
test.use({ extraHTTPHeaders: {} })

const require = createRequire(import.meta.url)
const ts = require("../../apps/web/node_modules/typescript/lib/typescript.js")
const sourceRoot = resolve(import.meta.dirname, "../../apps/web/src")
const modules = new Set(["/domains/offline/offline-store", "/domains/offline/sync-engine", "/lib/task-api", "/lib/client-logger", "/lib/companion-detect"])

// Execute the production modules with native browser IndexedDB, without an app build or server.
test.beforeEach(async ({ page }) => {
  await page.route("http://127.0.0.1:8914/**", async route => {
    const path = new URL(route.request().url()).pathname
    if (path === "/") return route.fulfill({ contentType: "text/html", body: '<meta name="meitheal-work-board" content="home"><meta name="meitheal-work-session" content="session-a"><meta name="meitheal-work-actor" content="' + "a".repeat(64) + '">' })
    if (!modules.has(path)) return route.fulfill({ status: 404 })
    const source = await readFile(resolve(sourceRoot, path.slice(1) + ".ts"), "utf8")
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
      .replaceAll('"@lib/', '"/lib/').replaceAll('"./offline-store"', '"/domains/offline/offline-store"')
    return route.fulfill({ contentType: "text/javascript", body: compiled })
  })
  await page.goto("http://127.0.0.1:8914/")
  await page.evaluate(async () => {
    const storeUrl = "/domains/offline/offline-store"
    const store = await import(storeUrl)
    const syncUrl = "/domains/offline/sync-engine"
    const sync = await import(syncUrl)
    Object.assign(window, { ordinaryOffline: { ...store, ...sync } })
  })
})

test("native offline data and pending edits stay with their original Board and actor", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = (window as any).ordinaryOffline
    const board = document.querySelector<HTMLMetaElement>('[name="meitheal-work-board"]')!
    const actor = document.querySelector<HTMLMetaElement>('[name="meitheal-work-actor"]')!
    await api.putTask({ id: "home-task", title: "Private Home", status: "pending" })
    await api.enqueueSyncOp({ operation: "update", table: "tasks", entityId: "home-task", payload: JSON.stringify({ title: "Unconfirmed Home" }) })
    board.content = "work"
    const workBefore = await api.getAllTasks()
    await api.putTask({ id: "work-task", title: "Private Work", status: "pending" })
    await api.enqueueSyncOp({ operation: "update", table: "tasks", entityId: "work-task", payload: JSON.stringify({ title: "Unconfirmed Work" }) })
    board.content = "home"
    const own = { tasks: await api.getAllTasks(), queue: await api.getSyncQueue() }
    actor.content = "b".repeat(64)
    return { workBefore, own, otherTasks: await api.getAllTasks(), otherQueue: await api.getSyncQueue() }
  })
  expect(result.workBefore).toEqual([])
  expect(result.own.tasks.map((task: any) => task.title)).toEqual(["Private Home"])
  expect(result.own.queue).toHaveLength(1)
  expect(result.own.queue[0].partition).toEqual({ actorKey: "a".repeat(64), boardId: "home" })
  expect(result.otherTasks).toEqual([])
  expect(result.otherQueue).toEqual([])
})

test("an account or Board switch withholds an in-flight offline read", async ({ page }) => {
  const message = await page.evaluate(async () => {
    const api = (window as any).ordinaryOffline
    await api.putTask({ id: "private", title: "Do not publish after switch", status: "pending" })
    const pending = api.getAllTasks()
    document.querySelector<HTMLMetaElement>('[name="meitheal-work-board"]')!.content = "work"
    return pending.then(() => "published", (error: Error) => error.message)
  })
  expect(message).toContain("another Board or account")
})

test("cache clearing preserves pending inputs and quarantined legacy data", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = (window as any).ordinaryOffline
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("meitheal-offline", 1)
      request.onupgradeneeded = () => request.result.createObjectStore("pending", { keyPath: "id" })
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>(resolve => { const tx = legacy.transaction("pending", "readwrite"); tx.objectStore("pending").put({ id: "unknown", title: "Retain for recovery" }); tx.oncomplete = () => resolve() })
    await api.putTask({ id: "owned", title: "Current cache", status: "pending" })
    await api.enqueueSyncOp({ operation: "update", table: "tasks", entityId: "owned", payload: '{"title":"Keep input"}' })
    const refusal = await api.clearCurrentOfflineCache().then(() => "cleared", (error: Error) => error.message)
    const unknown = await new Promise(resolve => { const request = legacy.transaction("pending").objectStore("pending").get("unknown"); request.onsuccess = () => resolve(request.result) })
    legacy.close()
    return { refusal, unknown, legacyFound: await api.hasUnattributedOfflineData(), queue: await api.getSyncQueue(), tasks: await api.getAllTasks() }
  })
  expect(result.refusal).toContain("Unconfirmed offline edits are kept")
  expect(result.unknown).toEqual({ id: "unknown", title: "Retain for recovery" })
  expect(result.legacyFound).toBe(true)
  expect(result.queue).toHaveLength(1)
  expect(result.tasks).toHaveLength(1)
})

for (const status of [403, 409]) {
  test(`sync retains an original scoped edit after HTTP ${status}`, async ({ page }) => {
    let sentHeaders: Record<string, string> = {}
    await page.route("http://127.0.0.1:8914/api/tasks/owned", async route => {
      sentHeaders = route.request().headers()
      return route.fulfill({ status, contentType: "application/json", body: '{"error":"Unavailable"}' })
    })
    const result = await page.evaluate(async () => {
      const api = (window as any).ordinaryOffline
      await api.enqueueSyncOp({ operation: "update", table: "tasks", entityId: "owned", payload: '{"title":"Keep input","updated_at":1}' })
      const result = await api.processSyncQueue()
      return { result, queue: await api.getSyncQueue() }
    })
    expect(sentHeaders["x-meitheal-board-id"]).toBe("home")
    expect(sentHeaders["x-meitheal-board-session"]).toBe("session-a")
    expect(result.result.succeeded).toBe(0)
    expect(result.result.failed).toBe(1)
    expect(result.queue).toHaveLength(1)
    expect(result.queue[0].payload).toContain("Keep input")
  })
}
