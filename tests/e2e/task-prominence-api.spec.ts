import { fork } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
const fixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))

test("task promotion is shared, typed, and independent of the stored manual order", async ({ request }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built App and the ingress fixture")

  const work = await mkdtemp(join(tmpdir(), "meitheal-prominence-"))
  const file = join(work, "meitheal.db")
  const db = new DatabaseSync(file)
  let child: ReturnType<typeof fork> | undefined

  try {
    child = fork(fixture, {
      cwd: web,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        SUPERVISOR_TOKEN: "prominence-fixture-only",
        HA_BASE_URL: "http://127.0.0.1:1",
        MEITHEAL_DB_URL: `file:${file}`,
        MEITHEAL_INGRESS_FIXTURE_PORT: process.env.MEITHEAL_PROMINENCE_TEST_PORT,
      },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    })
    const [info] = await Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(10_000) }),
      once(child, "exit").then(([code]) => { throw new Error(`Ingress fixture exited with ${code}`) }),
    ])
    const origin = `http://127.0.0.1:${info.port}`
    const ingress = origin + info.configuredPath
    const session = (role: string) => ({
      cookie: `feedback-fixture=${role}`, origin, "sec-fetch-site": "same-origin",
    })
    const member = session("member")
    const admin = session("admin")
    const create = async (title: string) => {
      const result = await request.post(ingress + "/api/tasks", {
        headers: member, data: { title, priority: 4, is_favorite: true },
      })
      expect(result.status()).toBe(201)
      return String((await result.json()).id)
    }
    const first = await create("First regular card")
    const second = await create("Second card")
    const third = await create("Third card")
    const taskPath = `/api/tasks/${second}`
    const reorderPath = ingress + "/api/tasks/reorder"
    const positions = () => db.prepare("SELECT id, kanban_position FROM tasks ORDER BY kanban_position").all()
    const patch = (is_promoted: unknown) =>
      request.patch(ingress + taskPath, { headers: member, data: { is_promoted } })
    const read = () => request.get(ingress + taskPath, { headers: admin })
    const order = await request.post(reorderPath, { headers: member, data: { ordered_ids: [first, second, third] } })
    expect(order.status()).toBe(200)
    const underlying = positions()

    const initial = await read()
    expect(initial.status()).toBe(200)
    expect(await initial.json()).toMatchObject({ is_promoted: false, is_favorite: 1, priority: 4 })
    for (const invalid of [0, 1, "true", null, []]) {
      const rejected = await patch(invalid)
      expect(rejected.status()).toBe(400)
      expect(await rejected.text()).toContain("is_promoted must be a boolean")
    }
    expect(await (await read()).json()).toMatchObject({ is_promoted: false })

    const issued = await request.post(ingress + "/api/agent-tokens", {
      headers: admin, data: { name: "Read-only fixture", scopes: ["tasks:read"] },
    })
    expect(issued.status()).toBe(201)
    const reader = { authorization: `Bearer ${(await issued.json()).token}` }
    const forbidden = await request.patch(origin + taskPath, { headers: reader, data: { is_promoted: true } })
    expect(forbidden.status()).toBe(403)
    const unauthenticated = await request.patch(origin + taskPath, {
      headers: { "x-remote-user-id": "fixture-admin", "x-remote-user-groups": "system-admin" },
      data: { is_promoted: true },
    })
    expect(unauthenticated.status()).toBe(401)

    const promoted = await patch(true)
    expect(promoted.status()).toBe(200)
    expect(await promoted.json()).toMatchObject({ is_promoted: true, is_favorite: 1, priority: 4 })
    expect(await (await read()).json()).toMatchObject({ is_promoted: true })
    expect(await (await request.get(origin + taskPath, { headers: reader })).json()).toMatchObject({ is_promoted: true })
    expect(positions()).toEqual(underlying)

    const moveBefore = (task_id: string, anchor_id: string) => request.post(reorderPath, {
      headers: member, data: { task_id, anchor_id, lane: "pending", before: true },
    })
    expect((await moveBefore(second, first)).status()).toBe(409)
    expect(positions()).toEqual(underlying)
    expect((await moveBefore(third, first)).status()).toBe(200)
    expect(positions().map(row => row.id)).toEqual([third, first, second])

    const demoted = await patch(false)
    expect(demoted.status()).toBe(200)
    expect(await demoted.json()).toMatchObject({ is_promoted: false, is_favorite: 1, priority: 4 })
    expect(positions().map(row => row.id)).toEqual([third, first, second])
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit")
      child.kill("SIGTERM")
      await exited
    }
    db.close()
    await rm(work, { recursive: true, force: true })
  }
})
