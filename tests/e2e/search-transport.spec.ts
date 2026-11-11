import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { startCoreFixture } from "../scripts/task-pins-fixture"

const searchPath = "/api/search"
const noStore = "private, no-store"
const encodedAliases = ["/%61pi/search", "/%2561pi/search", "/api/%73earch", "/api/%2573earch"]

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Run with MEITHEAL_TEST_BROWSER=1 and a built web app")

test("the packaged Search route accepts its canonical path and rejects aliases without redirecting", async ({ request }) => {
  const canonical = await request.get(searchPath + "?scope=tasks")
  expect(canonical.status()).toBe(200)
  expect(canonical.headers()["cache-control"]).toBe(noStore)
  expect(await canonical.json()).toHaveProperty("sections")
  const invalid = await request.get(searchPath + "?limit=1.5")
  expect(invalid.status()).toBe(400)
  expect(invalid.headers()["cache-control"]).toBe(noStore)

  const authorization = "Bearer mth_fixture-invalid"
  const denied = await request.get(searchPath, { headers: { authorization } })
  expect(denied.status()).toBe(401)
  expect(denied.headers()["cache-control"]).toBe(noStore)

  for (const alias of [...encodedAliases, "/api//search", "/api/search/"]) {
    const result = await request.get(alias + "?scope=tasks", { headers: { authorization }, maxRedirects: 0 })
    expect(result.status(), alias).toBe(404)
    expect(result.headers()["cache-control"], alias).toBe(noStore)
    expect(result.headers()["location"], alias).toBeUndefined()
  }
  let limited
  for (let attempt = 0; attempt < 301; attempt++) {
    limited = await request.get(searchPath + "?scope=actions")
    if (limited.status() === 429) break
  }
  expect(limited?.status()).toBe(429)
  expect(limited?.headers()["cache-control"]).toBe(noStore)
})

test("trusted ingress still enforces a presented agent token on Search", async ({ request }) => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-search-transport-"))
  const child = startCoreFixture(work, true)
  try {
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `http://127.0.0.1:${fixture.port}`
    const ingress = origin + fixture.configuredPath
    const admin = { cookie: "feedback-fixture=admin", origin }
    const member = { cookie: "feedback-fixture=member", origin }
    const noIngress = await request.get(origin + searchPath)
    expect(noIngress.status()).toBe(401)
    expect(noIngress.headers()["cache-control"]).toBe(noStore)
    expect((await request.get(ingress + searchPath, { headers: member })).status()).toBe(200)

    for (const [scope, status] of [["tasks:read", 403], ["search:read", 200]] as const) {
      const issued = await request.post(ingress + "/api/agent-tokens", {
        headers: admin,
        data: { name: "Disposable Search scope fixture", scopes: [scope] },
      })
      expect(issued.status()).toBe(201)
      const { token } = await issued.json()
      const headers = { ...member, authorization: "Bearer " + token }
      const canonical = await request.get(ingress + searchPath, { headers })
      expect(canonical.status()).toBe(status)
      expect(canonical.headers()["cache-control"]).toBe(noStore)

      for (const alias of encodedAliases) {
        const result = await request.get(ingress + alias, { headers, maxRedirects: 0 })
        expect(result.status(), alias).toBe(404)
        expect(result.headers()["cache-control"], alias).toBe(noStore)
        expect(result.headers()["location"], alias).toBeUndefined()
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit")
      child.kill("SIGKILL")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
