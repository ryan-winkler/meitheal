import type { ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import type { TaskDraftSnapshot } from "../../apps/web/src/lib/task-draft-state"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

const noStore = "private, no-store"
const secret = "Unpublished draft sentinel"
const snapshot = {
  version: 1, title: secret, description: "", taskKind: "standard_action", status: "pending", priority: 3,
  due: "", labels: [], newLabels: [], assignedTo: "", goal: "", recurrence: "", isRoutine: false,
  checklist: { items: [], input: "" }, shopping: { items: [], input: "", quantity: "1", category: "" },
  event: { start: "", end: "", location: "", allDay: false, calendar: "" }, fields: [],
} satisfies TaskDraftSnapshot

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built App and the HTTPS ingress fixture")

test("packaged draft path rejects aliases and direct writes without ingress", async ({ request }) => {
  const path = "/api/task-drafts"
  expect((await request.get(path)).status()).toBe(405)
  for (const alias of ["/api//task-drafts", "/api/%2574ask-drafts/", "/api/task-drafts/", "/%2561pi%252ftask-drafts"]) {
    const result = await request.post(alias, { maxRedirects: 0, data: { action: "read" } })
    expect(result.status(), alias).toBe(404)
    expect(result.headers()["cache-control"], alias).toBe(noStore)
    expect(result.headers()["location"], alias).toBeUndefined()
  }
  expect((await request.get(path + "?unexpected=1")).status()).toBe(400)
  const direct = await request.post(path, { data: { action: "read" } })
  expect(direct.status()).toBe(403)
  expect(direct.headers()["cache-control"]).toBe(noStore)
})

async function draftRequest(page: Page, path: string, method: "POST" | "PUT" | "HEAD", data?: object, context?: string) {
  return page.evaluate(async ({ path, method, data, context }) => {
    const response = await fetch(path, {
      method, mode: "same-origin", referrerPolicy: "same-origin", cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(5_000),
      headers: {
        ...(data ? { "Content-Type": "application/json" } : {}),
        ...(context ? { "X-Meitheal-Draft-Context": context } : {}),
        "Idempotency-Key": "external-replay-header-fixture",
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    })
    return {
      status: response.status, cache: response.headers.get("cache-control"),
      cached: response.headers.get("idempotency-key-status"), body: method === "HEAD" ? null : await response.json(),
    }
  }, { path, method, data, context })
}

test("draft authorization and exact receipt through browser HTTPS ingress", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-draft-ingress-"))
  let child: ChildProcess | undefined
  let browser
  let log = ""
  try {
    child = startCoreFixture(work)
    child.stdout?.on("data", chunk => { log += chunk })
    child.stderr?.on("data", chunk => { log += chunk })
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${info.port}`
    const prefix: string = info.configuredPath
    const path = prefix + "/api/task-drafts"
    browser = await launchPinBrowser(work)
    async function open(user: string) {
      const context = await browser!.newContext({ extraHTTPHeaders: {} })
      await context.addCookies([{ name: "feedback-fixture", value: user, url: origin }])
      const page = await context.newPage()
      expect((await page.goto(origin + prefix + "/fixture"))?.ok()).toBe(true)
      expect(await page.evaluate(() => isSecureContext)).toBe(true)
      return page
    }
    const [a, b] = await Promise.all([open("member"), open("member-two")])
    const read = { action: "read" }
    const initial = await draftRequest(a, path, "POST", read)
    expect(initial).toMatchObject({ status: 200, cache: noStore, body: { draft: null, latestReceipt: null } })
    const aContext = initial.body.context
    expect(await draftRequest(a, path, "HEAD", undefined, aContext)).toMatchObject({ status: 204, body: null })
    const bContext = (await draftRequest(b, path, "POST", read)).body.context
    expect(bContext).not.toBe(aContext)
    expect(await draftRequest(b, path, "HEAD", undefined, aContext)).toMatchObject({ status: 409, body: null })

    const save = { action: "save", expected: null, attemptId: crypto.randomUUID(), snapshot }
    expect(await draftRequest(a, path, "PUT", { ...save, snapshot: { ...snapshot, file: "local.txt" } }, aContext))
      .toMatchObject({ status: 400 })
    const saved = await draftRequest(a, path, "PUT", save, aContext)
    expect(saved).toMatchObject({ status: 200, cache: noStore, cached: null, body: { draft: { snapshot: { title: secret } } } })
    expect(await draftRequest(b, path, "PUT", save, aContext)).toMatchObject({ status: 409, body: { errorCode: "ACCOUNT_CHANGED" } })
    expect(await draftRequest(b, path, "POST", read)).toMatchObject({ body: { draft: null } })
    const shared = await b.evaluate(async tasks => {
      const response = await fetch(tasks)
      return { status: response.status, body: await response.text() }
    }, prefix + "/api/tasks")
    expect(shared.status).toBe(200)
    expect(shared.body).not.toContain(secret)
    const { draftId, revision } = saved.body.draft
    const publish = {
      action: "publish", expected: { draftId, revision }, attemptId: crypto.randomUUID(),
      task: { title: "Published task", description: "", task_kind: "standard_action", status: "pending", priority: 3,
        labels: [], catalogLabels: [], newLabels: [], due_date: null, assigned_to: null, goal_id: null },
    }
    const published = await draftRequest(a, path, "PUT", publish, aContext)
    expect(published).toMatchObject({ status: 201, body: { receipt: { draftId, revision, ticketKey: "MTH-1" } } })
    expect(await draftRequest(a, path, "PUT", publish, aContext)).toMatchObject({ status: 200, cached: null, body: published.body })
    expect(await draftRequest(a, path, "PUT", { ...publish, attemptId: crypto.randomUUID() }, aContext))
      .toMatchObject({ status: 409, body: { errorCode: "REVISION_CONFLICT" } })

    const changed = once(child, "message", { signal: AbortSignal.timeout(3_000) })
    child.send({ type: "fixture-core", user: "member", active: false })
    await changed
    expect(await draftRequest(a, path, "PUT", { ...save, attemptId: crypto.randomUUID() }, aContext)).toMatchObject({ status: 403 })
    expect(await draftRequest(a, path, "POST", read)).toMatchObject({ status: 403 })
    const privateLines = log.split("\n").filter(line => line.includes("/api/task-drafts"))
    expect(privateLines.length).toBeGreaterThan(0)
    for (const line of privateLines) {
      expect(line).not.toContain(secret)
      expect(line).not.toContain(aContext)
      expect(line).not.toContain("fixture-member")
    }
  } finally {
    await browser?.close()
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
      child.kill("SIGKILL")
      await closed
    }
    await rm(work, { recursive: true, force: true })
  }
})
