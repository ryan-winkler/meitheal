import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { startCoreFixture } from "../scripts/task-pins-fixture"

test("proposal credentials cannot write or approve; same-site current administrators decide once", async ({ playwright }) => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-proposal-api-"))
  const child = startCoreFixture(work, true)
  child.stdout?.resume()
  child.stderr?.resume()
  let api
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10000) })
    const origin = `http://127.0.0.1:${info.port}`
    api = await playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: { cookie: "feedback-fixture=admin", origin } })
    const path = (value: string) => info.configuredPath + value
    const created = await api.post(path("/api/tasks"), { data: { title: "Original", description: "Existing description" } })
    expect(created.status()).toBe(201)
    const task = await created.json()
    const taskPath = path(`/api/tasks/${task.id}`)
    const minted = await api.post(path("/api/agent-tokens"), { data: { name: "Proposal fixture", scopes: ["tasks:propose"] } })
    expect(minted.status()).toBe(201)
    const token = (await minted.json()).token
    const agent = { authorization: `Bearer ${token}`, cookie: "feedback-fixture=admin" }
    expect((await api.put(taskPath, { headers: agent, data: { title: "Must not apply" } })).status()).toBe(403)
    expect((await api.post(taskPath + "/handoff", { headers: { cookie: "feedback-fixture=admin" }, data: { action: "claim" } })).status()).toBe(401)
    const claimResponse = await api.post(taskPath + "/handoff", { headers: agent, data: { action: "claim" } })
    expect(claimResponse.status()).toBe(200)
    const claim = await claimResponse.json()
    expect((await api.post(taskPath + "/handoff", { headers: agent, data: { action: "propose", lease: crypto.randomUUID(), summary: "Wrong lease", updates: { title: "Wrong" } } })).status()).toBe(409)
    const proposed = await api.post(taskPath + "/handoff", { headers: agent, data: { action: "propose", lease: claim.lease, summary: "Clarify", updates: { title: "<script>bad()</script>Reviewed title" } } })
    expect(proposed.status()).toBe(200)
    const hash = (await proposed.json()).hash
    expect((await (await api.get(taskPath)).json()).title).toBe("Original")
    const decision = { action: "accept", proposal_hash: hash }
    expect((await api.post(taskPath + "/accept-proposal", { headers: agent, data: decision })).status()).toBe(403)
    expect((await api.post(taskPath + "/accept-proposal", { headers: { cookie: "feedback-fixture=member" }, data: decision })).status()).toBe(403)
    expect((await api.post(taskPath + "/accept-proposal", { headers: { origin: "https://unrelated.invalid" }, data: decision })).status()).toBe(403)
    const accepted = await api.post(taskPath + "/accept-proposal", { data: decision })
    expect(accepted.status(), await accepted.text()).toBe(200)
    expect((await (await api.get(taskPath)).json()).title).toBe("Reviewed title")
    expect((await api.post(taskPath + "/accept-proposal", { data: decision })).status()).toBe(409)
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
