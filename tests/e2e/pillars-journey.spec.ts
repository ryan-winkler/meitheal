import { execFileSync, fork } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test, type APIRequestContext } from "@playwright/test"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and disposable ingress fixture")

const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
const fixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))
const admin = { cookie: "feedback-fixture=admin" }

let work: string
let child: ReturnType<typeof fork>
let request: APIRequestContext
let origin: string
let ingress: string

test.beforeAll(async ({ playwright }) => {
  work = await mkdtemp(join(tmpdir(), "meitheal-pillars-journey-"))
  const env = { PATH: process.env.PATH, NODE_ENV: "production", MEITHEAL_DB_URL: `file:${join(work, "meitheal.db")}` }
  execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: web, env })
  child = fork(fixture, { cwd: web, env, stdio: ["ignore", "ignore", "inherit", "ipc"] })
  const [info] = await Promise.race([
    once(child, "message", { signal: AbortSignal.timeout(10_000) }),
    once(child, "exit").then(([code]) => { throw new Error(`Pillar fixture exited with ${code}`) }),
  ])
  origin = `http://127.0.0.1:${info.port}`
  ingress = origin + info.configuredPath
  request = await playwright.request.newContext({ extraHTTPHeaders: admin })
})

test.afterAll(async () => {
  await request?.dispose()
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit")
    child.kill()
    await exited
  }
  if (work) await rm(work, { recursive: true, force: true })
})

async function createPillar(name: string) {
  const response = await request.post(ingress + "/api/pillars", { data: { name } })
  expect(response.status()).toBe(201)
  return (await response.json()).pillar.id as string
}

test("Principle updates and removal stay within the selected Pillar", async () => {
  const id = await createPillar("Principle owner")
  const other = await createPillar("Different owner")
  const path = (pillar: string) => ingress + `/api/pillars/${pillar}/principles`
  const created = await request.post(path(id), { data: { statement: "Keep the original boundary" } })
  expect(created.status()).toBe(201)
  const { principle } = await created.json()

  for (const action of ["update", "delete"]) {
    const foreign = await request.post(path(other), {
      data: { action, principleId: principle.id, isNonNegotiable: true },
    })
    expect(foreign.status()).toBe(404)
  }
  const read = async () => {
    const response = await request.get(path(id))
    expect(response.status()).toBe(200)
    return (await response.json()).principles
  }
  expect(await read()).toEqual([principle])

  const updated = await request.post(path(id), {
    data: { action: "update", principleId: principle.id, isNonNegotiable: true },
  })
  expect(updated.status()).toBe(200)
  expect(await read()).toMatchObject([{ id: principle.id, isNonNegotiable: true }])

  const removed = await request.post(path(id), { data: { action: "delete", principleId: principle.id } })
  expect(removed.status()).toBe(200)
  expect(await read()).toEqual([])
})
