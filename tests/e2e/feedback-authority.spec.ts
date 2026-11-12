import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "@playwright/test"
import { startCoreFixture } from "../scripts/task-pins-fixture"
import { deferred } from "./_helpers"

const payload = () => ({ submissionId: randomUUID(), category: "problem", message: "Synthetic current-access report", appVersion: "d73084837f30" })

test("Feedback rechecks Core roles after body parsing for every operation", async ({ request }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires built ingress/Core fixture")
  test.setTimeout(45_000)
  const work = await mkdtemp(join(tmpdir(), "meitheal-feedback-authority-"))
  const child = startCoreFixture(work, true)
  child.stdout?.resume()
  child.stderr?.resume()
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `http://127.0.0.1:${info.port}`
    const url = origin + info.configuredPath + "/api/feedback"
    const member = { origin, "content-type": "application/json", cookie: "feedback-fixture=member", "x-meitheal-feedback": "1" }
    const admin = { ...member, cookie: "feedback-fixture=admin" }
    async function core(change: Record<string, unknown>) {
      const ack = once(child, "message", { signal: AbortSignal.timeout(4_000) })
      child.send({ type: "fixture-core", ...change })
      expect((await ack)[0]).toEqual({ coreChanged: true })
    }
    const database = new DatabaseSync(join(work, "pins.db"), { readOnly: true })
    const rows = () => database.prepare("SELECT * FROM feedback_reports ORDER BY id").all()
    try {
      const created = await request.post(url, { headers: member, data: payload() })
      expect(created.status()).toBe(201)
      const id = (await created.json()).id
      expect((await request.get(url, { headers: admin })).status()).toBe(200)
      expect((await request.patch(url + "/" + id, { headers: admin, data: { state: "in_progress" } })).status()).toBe(200)
      expect((await request.post(url + "/" + id + "/export", { headers: admin, data: { reviewedMessage: "Safe reproduction" } })).status()).toBe(200)
      expect((await request.patch(url + "/" + id, { headers: admin, data: { state: "resolved", disposition: "Reproduced" } })).status()).toBe(200)
      const saved = rows()
      const operations = () => [
        request.get(url, { headers: admin }),
        request.patch(url + "/" + id, { headers: admin, data: { state: "declined", disposition: "No" } }),
        request.post(url + "/" + id + "/export", { headers: admin, data: { reviewedMessage: "Safe" } }),
        request.delete(url + "/" + id, { headers: admin }),
      ]
      await core({ user: "admin", isOwner: false, groupIds: ["system-users"] })
      for (const response of await Promise.all(operations())) {
        expect(response.status()).toBe(403)
        expect(response.headers()["cache-control"], JSON.stringify({ url: response.url(), body: await response.text() })).toBe("no-store")
      }
      expect(rows()).toEqual(saved)
      await core({ user: "admin", active: false })
      expect((await request.post(url, { headers: admin, data: payload() })).status()).toBe(403)
      await core({ user: "admin", active: true, isOwner: true, groupIds: ["system-admin"] })
      for (const [result, expected] of [[[], 403], [null, 503], [[{ id: "fixture-admin" }], 503], [[{ id: "fixture-admin" }, { id: "fixture-admin" }], 503]] as const) {
        await core({ result })
        for (const response of await Promise.all(operations())) expect(response.status()).toBe(expected)
        expect(rows()).toEqual(saved)
      }
      await core({ unavailable: true })
      expect((await request.get(url, { headers: admin })).status()).toBe(503)
      await core({ user: "member", systemGenerated: true })
      expect((await request.post(url, { headers: member, data: payload() })).status()).toBe(403)
      await core({ user: "member", systemGenerated: false, active: true })

      for (const [method, target, data, role] of [
        ["POST", url, payload(), "member"],
        ["PATCH", url + "/" + id, { state: "declined", disposition: "Denied delayed change" }, "admin"],
        ["POST", url + "/" + id + "/export", { reviewedMessage: "Denied delayed export" }, "admin"],
      ] as const) {
        const started = once(child, "message", { signal: AbortSignal.timeout(4_000) })
        const pending = deferred<number>()
        const body = JSON.stringify(data)
        const held = httpRequest(target, {
          method, headers: { ...(role === "member" ? member : admin), "content-type": "application/json", "x-meitheal-fixture-held-body": "1" },
        }, response => { response.resume(); response.once("end", () => pending.resolve(response.statusCode ?? 0)) })
        held.once("error", () => pending.resolve(0))
        held.setTimeout(8_000, () => held.destroy())
        held.write(body.slice(0, 12))
        expect((await started)[0]).toEqual({ participantBodyStarted: true })
        await core({ user: role, active: false })
        held.end(body.slice(12))
        expect(await pending.promise).toBe(403)
        expect(rows()).toEqual(saved)
        await core({ user: role, active: true })
      }
      for (const cookie of ["old", "missing"]) {
        const forged = { ...admin, cookie: `feedback-fixture=${cookie}`, "x-remote-user-id": "fixture-admin", "x-remote-user-groups": "system-admin" }
        expect((await request.post(url, { headers: forged, data: payload() })).status()).toBe(403)
      }
      expect(rows()).toEqual(saved)
      expect((await request.delete(url + "/" + id, { headers: admin })).status()).toBe(204)
      expect(rows()).toHaveLength(0)
    } finally { database.close() }
  } finally {
    const stopped = once(child, "exit")
    child.kill()
    await stopped
    await rm(work, { recursive: true, force: true })
  }
})
