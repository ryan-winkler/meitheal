import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { startCoreFixture } from "../scripts/task-pins-fixture"

test("NFC requires task write authority and a unique assignment, then shares canonical completion and retry behavior", async ({ playwright }) => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-nfc-api-"))
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
      const response = await api!.post(path("/api/tasks"), { data: { title } })
      expect(response.status()).toBe(201)
      return response.json()
    }
    const token = async (name: string, scopes: string[]) => {
      const response = await api!.post(path("/api/agent-tokens"), { data: { name, scopes } })
      expect(response.status()).toBe(201)
      return { authorization: `Bearer ${(await response.json()).token}`, cookie: "feedback-fixture=admin" }
    }
    const readOnly = await token("Read only", ["tasks:read"])
    const writer = await token("NFC writer", ["tasks:write"])
    const complete = path("/api/nfc/complete")
    expect((await api.post(complete, { headers: readOnly, data: { tag_id: "fixture-tag" } })).status()).toBe(403)
    expect((await api.post(complete, { headers: writer, data: { tag_id: "unknown" } })).status()).toBe(404)
    expect((await api.post(complete, { headers: writer, data: { tag_id: "" } })).status()).toBe(400)
    expect((await api.post(complete, { headers: writer, data: { tag_id: "x".repeat(5000) } })).status()).toBe(413)
    const task = await create("Scan hallway task")
    const assigned = await api.put(path(`/api/tasks/${task.id}`), { headers: writer, data: { nfc_tag_id: " fixture-tag " } })
    expect(assigned.status()).toBe(200)
    expect((await assigned.json()).nfc_tag_id).toBe("fixture-tag")
    const initial = (await (await api.get(path("/api/gamification"))).json()).stats.totalCompleted
    const first = await api.post(complete, { headers: writer, data: { tag_id: "fixture-tag" } })
    expect(first.status()).toBe(200)
    expect(await first.json()).toMatchObject({ ok: true, task_id: task.id, task: { status: "complete" } })
    const repeat = await api.post(complete, { headers: writer, data: { tag_id: "fixture-tag" } })
    expect(await repeat.json()).toMatchObject({ ok: true, task_id: task.id, already_complete: true })
    expect((await (await api.get(path("/api/gamification"))).json()).stats.totalCompleted).toBe(initial + 1)
    const other = await create("Duplicate assignment")
    expect((await api.put(path(`/api/tasks/${other.id}`), { headers: writer, data: { nfc_tag_id: "fixture-tag" } })).status()).toBe(200)
    expect((await api.post(complete, { headers: writer, data: { tag_id: "fixture-tag" } })).status()).toBe(409)
    expect((await api.put(path(`/api/tasks/${other.id}`), { headers: writer, data: { nfc_tag_id: null } })).status()).toBe(200)
    expect((await api.post(complete, { headers: writer, data: { tag_id: "fixture-tag" } })).status()).toBe(200)
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
