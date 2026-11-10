import { fork } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test, type APIResponse } from "@playwright/test"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable built App")

async function expectPrivateNotFound(response: APIResponse, alias: string) {
  expect(response.status(), alias).toBe(404)
  expect(response.headers()["cache-control"], alias).toBe("private, no-store")
  expect(response.headers()["location"], alias).toBeUndefined()
  expect(response.headers()["content-disposition"], alias).toBeUndefined()
}

test("the packaged server rejects alternate export paths without redirecting", async ({ request }) => {
  for (const alias of [
    "/api//export/database.sqlite",
    "/api/export/database.sqlite/",
    "/%61pi/export/database.sqlite",
    "/api/%2565xport/database.sqlite/",
    "/api%2Fexport/database.sqlite",
  ]) {
    const get = await request.get(alias, { maxRedirects: 0 })
    const post = await request.post(alias, { data: {}, maxRedirects: 0 })
    for (const response of [get, post]) {
      await expectPrivateNotFound(response, alias)
      expect(await response.body(), alias).toHaveLength(0)
    }
  }
  expect((await request.get("/api//health", { maxRedirects: 0 })).status()).toBe(200)
})

test("the Astro ingress handler denies decoded aliases for verified administrators", async ({ request }) => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-export-alias-"))
  const child = fork(fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url)), {
    cwd: fileURLToPath(new URL("../../apps/web", import.meta.url)),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      SUPERVISOR_TOKEN: "export-alias-fixture-only",
      HA_BASE_URL: "http://127.0.0.1:1",
      MEITHEAL_DB_URL: `file:${join(work, "meitheal.db")}`,
      MEITHEAL_INGRESS_FIXTURE_PORT: process.env.MEITHEAL_EXPORT_ALIAS_TEST_PORT,
    },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  })
  try {
    const [info] = await Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(10_000) }),
      once(child, "exit").then(([code]) => { throw new Error(`Ingress fixture exited with ${code}`) }),
    ])
    const origin = `http://127.0.0.1:${info.port}`
    const ingress = origin + info.configuredPath
    const headers = { cookie: "feedback-fixture=admin", origin, "sec-fetch-site": "same-origin" }
    for (const alias of ["/%61pi/export/database.sqlite", "/api/%65xport/database.sqlite"]) {
      const options = { headers, maxRedirects: 0 }
      const get = await request.get(ingress + alias, options)
      const post = await request.post(ingress + alias, { ...options, data: {} })
      for (const response of [get, post]) {
        await expectPrivateNotFound(response, alias)
        expect(await response.json(), alias).toMatchObject({ status: 404, detail: "Database download not found." })
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit")
      child.kill("SIGTERM")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
