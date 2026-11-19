import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test"
import { commentPersonKey } from "../../apps/web/src/lib/comment-mention-request"
import { commentMentionToken } from "../../apps/web/src/lib/comment-mentions"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"

test("only new verified human comments advance a spike across both comment writers", async ({ playwright }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built app and HTTPS ingress fixture")
  const work = await mkdtemp(join(tmpdir(), "meitheal-stall-comments-"))
  const child = startCoreFixture(work)
  child.stdout?.resume()
  child.stderr?.resume()
  let native!: APIRequestContext
  let browser: Browser | undefined
  let db: DatabaseSync | undefined
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${info.port}`
    const prefix: string = info.configuredPath
    browser = await launchPinBrowser(work)
    const pages = await Promise.all(["admin", "member"].map(async user => {
      const context = await browser!.newContext({ extraHTTPHeaders: {}, ignoreHTTPSErrors: true, serviceWorkers: "block" })
      await context.addCookies([{ name: "feedback-fixture", value: user, url: origin }])
      const page = await context.newPage()
      await page.goto(origin + prefix + "/fixture")
      return page
    }))
    const [admin, member] = pages as [Page, Page]
    const adminProof = await currentBoardWriteHeaders(admin.request, "household", { origin }, origin + prefix)
    const memberProof = await currentBoardWriteHeaders(member.request, "household", { origin }, origin + prefix)
    native = await playwright.request.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
    const created = await admin.request.post(origin + prefix + "/api/tasks", { headers: adminProof, data: { title: "Stall comment provenance" } })
    expect(created.status()).toBe(201)
    const taskId = (await created.json()).id as string
    const path = prefix + "/api/tasks/" + taskId + "/comments"
    db = new DatabaseSync(join(work, "pins.db"))
    db.exec("PRAGMA busy_timeout = 3000")
    db.exec("INSERT INTO task_inactivity_policy (board_id, scope, area_id, days, revision) VALUES ('household', 'default', NULL, 30, lower(hex(randomblob(16))))")
    const readSpike = () => db!.prepare("SELECT last_activity_spike_at AS spike FROM tasks WHERE id = ?").get(taskId)?.spike
    const readComments = () => db!.prepare("SELECT id, inactivity_spike_human AS human FROM comments WHERE task_id = ? ORDER BY id").all(taskId)
    const headers = { ...adminProof, origin, "sec-fetch-site": "same-origin", "sec-fetch-mode": "same-origin" }
    const cachedKey = randomUUID()
    const plain = () => admin.request.post(origin + path, {
      headers: { ...headers, "idempotency-key": cachedKey }, data: { content: "First ordinary comment" },
    })
    const first = await plain()
    expect(first.status()).toBe(201)
    const firstBody = await first.json()
    expect((await (await plain()).json()).id).toBe(firstBody.id)
    expect(readComments()).toEqual([{ id: firstBody.id, human: 1 }])
    expect(readSpike()).toBeNull()

    const contexts: string[] = []
    for (const page of pages) {
      await page.goto(origin + prefix + "/tickets/" + taskId)
      await expect(page.locator("#td-loaded-content")).toBeVisible()
      const picker = page.locator("#td-task-reference-picker")
      await expect(picker).toHaveAttribute("data-person-context", /^[A-Za-z0-9_-]{43}$/)
      contexts.push((await picker.getAttribute("data-person-context"))!)
    }
    const second = await admin.request.post(origin + path, {
      headers,
      data: { content: "Second ordinary comment through the plain writer" },
    })
    expect(second.status(), await second.text()).toBe(201)
    expect(readComments().map(row => row.human)).toEqual([1, 1])
    expect(readSpike()).toBeNull()

    const thirdAttempt = `${Date.now()}.${randomUUID()}`
    const content = "A mentioned reply " + commentMentionToken(commentPersonKey("fixture-admin"), "Admin")
    const mentionHeaders = { ...headers, ...memberProof, referer: member.url(), "x-meitheal-mention-context": contexts[1]!, "x-meitheal-comment-attempt": thirdAttempt }
    const third = await member.request.post(origin + path, { headers: mentionHeaders, data: { content } })
    expect(third.status(), await third.text()).toBe(201)
    const thirdBody = await third.json()
    expect(thirdBody).not.toHaveProperty("inactivity_spike_human")
    expect(thirdBody).not.toHaveProperty("owner_key")
    expect(readComments().map(row => row.human)).toEqual([1, 1, 1])
    expect(readSpike()).toEqual(expect.any(Number))

    const preservedSpike = Date.now() - 20 * 86_400_000
    db.prepare("UPDATE tasks SET last_activity_spike_at = ? WHERE id = ?").run(preservedSpike, taskId)
    expect((await (await plain()).json()).id).toBe(firstBody.id)
    const replay = () => member.request.post(origin + path, { headers: mentionHeaders, data: { content } })
    expect((await (await replay()).json()).id).toBe(thirdBody.id)
    expect(readComments()).toHaveLength(3)
    expect(readSpike()).toBe(preservedSpike)

    const tokenResponse = await admin.request.post(origin + prefix + "/api/agent-tokens", {
      headers, data: { name: "Stall automation fixture", scopes: ["tasks:write"] },
    })
    expect(tokenResponse.status()).toBe(201)
    const { token } = await tokenResponse.json()
    const automated = await native.post(origin + "/api/tasks/" + taskId + "/comments", {
      headers: { authorization: `Bearer ${token}`, "x-meitheal-board-id": "household" }, data: { content: "An automated comment" },
    })
    expect(automated.status()).toBe(201)
    expect(readComments().map(row => row.human)).toEqual([1, 1, 1, 0])
    expect(readSpike()).toBe(preservedSpike)

    const edited = await admin.request.patch(origin + path + "/" + firstBody.id, {
      headers, data: { content: "Edited ordinary comment" },
    })
    expect(edited.status()).toBe(200)
    expect(readSpike()).toBe(preservedSpike)
    expect((await admin.request.delete(origin + path + "/" + firstBody.id, { headers })).status()).toBe(204)
    expect(readComments()).toHaveLength(3)
    expect(readSpike()).toBe(preservedSpike)

    const changed = once(child, "message", { signal: AbortSignal.timeout(3_000) })
    child.send({ type: "fixture-core", user: "member", active: false })
    await changed
    expect((await replay()).status()).toBe(403)
    expect((await member.request.post(origin + path, { headers, data: { content: "A revoked comment" } })).status()).toBe(403)
    expect(readComments()).toHaveLength(3)
    expect(readSpike()).toBe(preservedSpike)
  } finally {
    await native?.dispose()
    db?.close()
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) })
      child.kill("SIGTERM")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
