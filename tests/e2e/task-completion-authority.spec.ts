import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "@playwright/test"
import { startCoreFixture } from "../scripts/task-pins-fixture"

test("canonical transitions award once across concurrent and repeated writes and preserve successful writes when statistics fail", async ({ playwright }) => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-completion-api-"))
  const child = startCoreFixture(work, true)
  child.stdout?.resume()
  child.stderr?.resume()
  let api
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10000) })
    const origin = `http://127.0.0.1:${info.port}`
    api = await playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: { cookie: "feedback-fixture=admin", origin } })
    const path = (value: string) => info.configuredPath + value
    const create = async (title: string) => {
      const response = await api!.post(path("/api/tasks"), { data: { title, priority: 1 } })
      expect(response.status()).toBe(201)
      return response.json()
    }
    const initial = (await (await api.get(path("/api/gamification"))).json()).stats
    const task = await create("Concurrent completion")
    const target = path(`/api/tasks/${task.id}`)
    const completed = await Promise.all([api.put(target, { data: { status: "complete" } }), api.put(target, { data: { status: "done" } })])
    expect(completed.map(response => response.status())).toEqual([200, 200])
    const results = await Promise.all(completed.map(response => response.json()))
    expect(results.filter(result => result.gamification?.xp === 50)).toHaveLength(1)
    const again = await api.put(target, { data: { status: "complete" } })
    expect((await again.json()).gamification).toBeUndefined()
    expect((await api.post(path("/api/gamification"), { data: { priority: 1 } })).status()).toBe(410)
    const recorded = (await (await api.get(path("/api/gamification"))).json()).stats
    expect(recorded.totalCompleted).toBe(initial.totalCompleted + 1)
    expect(recorded.totalPoints).toBe(initial.totalPoints + 50)
    const another = await create("Optional stats failure")
    const db = new DatabaseSync(join(work, "pins.db"))
    try {
      db.exec("CREATE TRIGGER reject_completion_stats BEFORE INSERT ON gamification_stats BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
      const saved = await api.put(path(`/api/tasks/${another.id}`), { data: { status: "complete" } })
      expect(saved.status()).toBe(200)
      expect(await saved.json()).toMatchObject({ status: "complete", gamification: { error: "Task saved; completion statistics unavailable" } })
      expect((await (await api.get(path(`/api/tasks/${another.id}`))).json()).status).toBe("complete")
    } finally { db.close() }
  } finally {
    await api?.dispose()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit")
      child.kill()
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
