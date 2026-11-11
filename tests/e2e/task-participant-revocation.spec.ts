import { once } from "node:events"
import { request as httpRequest } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type APIResponse } from "@playwright/test"
import { startCoreFixture } from "../scripts/task-pins-fixture"
import { deferred } from "./_helpers"

const activeParticipantProblem = "https://meitheal.local/problems/active-task-participant-required"

function holdComment(url: string, headers: Record<string, string>, body: { content: string }) {
  const pending = deferred<{ status: number; cache: string | undefined; type: string | undefined; replay: string | undefined } | Error>()
  const request = httpRequest(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", "x-meitheal-fixture-held-body": "1" },
  }, response => {
    let body = ""
    response.setEncoding("utf8")
    response.on("data", chunk => { body += chunk })
    response.once("end", () => {
      const problem = JSON.parse(body || "{}")
      pending.resolve({
        status: response.statusCode ?? 0, cache: response.headers["cache-control"],
        type: problem.type, replay: response.headers["idempotency-key-status"] as string | undefined,
      })
    })
  })
  request.once("error", error => pending.resolve(error))
  request.setTimeout(8_000, () => request.destroy(new Error("Timed out waiting for a participant response")))
  const data = JSON.stringify(body)
  request.write(data.slice(0, 12))
  return { finish: () => request.end(data.slice(12)), abort: () => request.destroy(), response: pending.promise.then(result => {
    if (result instanceof Error) throw result
    return result
  }) }
}

test("revoking a Core member fences comment replay and participant writes", async ({ request }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built App and Core ingress fixture")
  const work = await mkdtemp(join(tmpdir(), "meitheal-participant-revocation-"))
  const child = startCoreFixture(work, true)
  let logs = ""
  child.stdout?.on("data", chunk => { logs += chunk })
  child.stderr?.resume()
  try {
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `http://127.0.0.1:${fixture.port}`
    const root = origin + fixture.configuredPath
    const member = { origin, cookie: "feedback-fixture=member", "x-request-id": "fixture-forged-request",
      "x-agent-id": "fixture-forged-agent", traceparent: "00-11111111111111111111111111111111-2222222222222222-01" }
    const observer = { origin, cookie: "feedback-fixture=member-two" }
    const task = await request.post(root + "/api/tasks", { headers: member, data: { title: "Revocation fixture" } })
    expect(task.status()).toBe(201)
    const taskId = (await task.json()).id
    const comments = root + `/api/tasks/${taskId}/comments`
    const keyed = { ...member, "Idempotency-Key": "participant-comment-replay" }
    const data = { content: "Preserved comment" }
    const loggedResponses: APIResponse[] = []
    const initial = await request.post(comments, { headers: keyed, data })
    loggedResponses.push(initial)
    expect(initial.status()).toBe(201)
    const commentId = (await initial.json()).id
    const replay = await request.post(comments, { headers: keyed, data })
    loggedResponses.push(replay)
    expect(replay.headers()["idempotency-key-status"]).toBe("cached")
    expect(replay.headers()["cache-control"]).toBe("no-store")
    const parent = await request.post(comments, { headers: member, data: { content: "Separate reaction parent" } })
    expect(parent.status()).toBe(201)
    const parentId = (await parent.json()).id
    const reactions = comments + `/${parentId}/reactions`
    const firstReaction = await request.post(reactions, { headers: member, data: { content: "✓" } })
    expect(firstReaction.status()).toBe(201)
    const reactionId = (await firstReaction.json()).id
    const card = root + `/api/tasks/${taskId}/reactions`
    const cardReaction = await request.post(card, { headers: member, data: { content: "👍" } })
    expect(cardReaction.status()).toBe(201)
    const cardReactionId = (await cardReaction.json()).id

    async function setCore(change: Record<string, unknown>) {
      const changed = once(child, "message", { signal: AbortSignal.timeout(4_000) })
      child.send({ type: "fixture-core", ...change })
      expect((await changed)[0]).toEqual({ coreChanged: true })
    }
    async function coreMetrics() {
      const metrics = once(child, "message", { signal: AbortSignal.timeout(4_000) })
      child.send({ type: "fixture-core-metrics" })
      const [measurement] = await metrics
      return measurement as { membershipQueries: number; lookupStillHeld: boolean }
    }
    async function startHeld(headers: Record<string, string>, body = { content: "Delayed revoked comment" }) {
      const arrived = once(child, "message", { signal: AbortSignal.timeout(4_000) })
      const held = holdComment(comments, headers, body)
      void held.response.catch(() => {})
      expect((await arrived)[0]).toEqual({ participantBodyStarted: true })
      return held
    }
    const inFlightKey = { ...member, "Idempotency-Key": "participant-in-flight" }
    const inFlightBody = { content: "Uncommitted in-flight comment" }
    async function armLookup(ordinal: number) {
      const armAck = once(child, "message", { signal: AbortSignal.timeout(4_000) })
      child.send({ type: "fixture-core-hold", ordinal })
      expect((await armAck)[0]).toEqual({ participantLookupArmed: true })
    }
    await armLookup(2)
    const lookupHeld = once(child, "message", { signal: AbortSignal.timeout(4_000) })
    const original = request.post(comments, { headers: inFlightKey, data: inFlightBody })
    void original.catch(() => {})
    expect((await lookupHeld)[0]).toEqual({ participantLookupHeld: true })
    expect((await request.post(comments, { headers: inFlightKey, data: inFlightBody })).status()).toBe(409)
    await setCore({ user: "member", active: false })
    const revokedDuplicate = await request.post(comments, { headers: inFlightKey, data: inFlightBody })
    expect(revokedDuplicate.status()).toBe(403)
    expect(revokedDuplicate.headers()["idempotency-key-status"]).toBeUndefined()
    expect((await revokedDuplicate.json()).type).toBe(activeParticipantProblem)
    loggedResponses.push(revokedDuplicate)
    expect((await coreMetrics()).lookupStillHeld).toBe(true)
    child.send({ type: "fixture-core-release", snapshot: true })
    expect((await original).status()).toBe(403)
    await setCore({ user: "member", active: true })
    const beforeHeld = (await coreMetrics()).membershipQueries
    const held = await startHeld(member)
    const heldKeyed = await startHeld(keyed, data)
    expect((await coreMetrics()).membershipQueries).toBe(beforeHeld)
    await setCore({ user: "member", active: false })
    held.finish()
    heldKeyed.finish()
    for (const result of await Promise.all([held.response, heldKeyed.response])) {
      expect(result).toEqual({ status: 403, type: activeParticipantProblem, cache: "private, no-store", replay: undefined })
    }
    const invalidBody = { headers: { ...member, "content-type": "application/json" }, data: "{" }
    expect((await request.post(comments, invalidBody)).status()).toBe(400)
    const keyedInvalid = await request.post(comments, { ...invalidBody, headers: { ...invalidBody.headers, ...keyed } })
    expect(keyedInvalid.status()).toBe(403)
    expect((await keyedInvalid.json()).type).toBe(activeParticipantProblem)
    const denied = await Promise.all([
      request.post(comments, { headers: keyed, data }),
      request.post(comments, { headers: member, data: { content: "Revoked post" } }),
      request.patch(comments + "/" + commentId, { headers: member, data: { content: "Revoked edit" } }),
      request.delete(comments + "/" + commentId, { headers: member, data: {} }),
      request.post(reactions, { headers: member, data: { content: "Revoked" } }),
      request.delete(reactions + "/" + reactionId, { headers: member, data: {} }),
      request.post(card, { headers: member, data: { content: "Revoked" } }),
      request.delete(card + "/" + cardReactionId, { headers: member, data: {} }),
    ])
    console.log("Retained-session HTTP outcomes", denied.map(response => response.status()))
    expect(denied.map(response => response.status())).toEqual(Array(8).fill(403))
    loggedResponses.push(...denied)
    for (const response of denied) {
      expect(response.headers()["idempotency-key-status"]).toBeUndefined()
      expect(response.headers()["cache-control"]).toBe("private, no-store")
      expect((await response.json()).type).toBe(activeParticipantProblem)
    }

    const encoded = await request.post(comments.replace(/comments$/, "%63omments"), {
      headers: member, data: { content: "Encoded revoked post" },
    })
    expect(encoded.status()).toBe(403)
    expect((await encoded.json()).type).toBe(activeParticipantProblem)
    loggedResponses.push(encoded)
    const slash = await request.post(comments + "/", {
      headers: member, data, maxRedirects: 0,
    })
    expect(slash.status()).toBe(308)
    expect(slash.headers().location).toBe(`/api/tasks/${taskId}/comments`)
    const terminal = await request.post(root + slash.headers().location, { headers: member, data })
    expect(terminal.status()).toBe(403)
    expect((await terminal.json()).type).toBe(activeParticipantProblem)
    const counts = root + "/api/tasks/reaction-counts?ids=" + encodeURIComponent(taskId)
    for (const route of [reactions, card, counts]) {
      const response = await request.get(route, { headers: member })
      expect(response.status()).toBe(403)
      expect(response.headers()["cache-control"]).toBe("private, no-store")
    }
    expect((await request.head(counts, { headers: member })).status()).toBe(403)
    const readOnly = await request.get(comments, { headers: member })
    expect(readOnly.status()).toBe(200)
    expect((await readOnly.json()).comments.every((row: { can_manage: boolean }) => !row.can_manage)).toBe(true)

    const remaining = await request.get(comments, { headers: observer })
    expect((await remaining.json()).comments).toMatchObject([
      { id: commentId, content: data.content, can_manage: false },
      { id: parentId, content: "Separate reaction parent", can_manage: false },
    ])
    const retained = await request.get(reactions, { headers: observer })
    expect((await retained.json()).reactions).toMatchObject([{ id: reactionId, content: "✓" }])
    expect((await (await request.get(card, { headers: observer })).json()).reactions).toMatchObject([
      { id: cardReactionId, content: "👍" },
    ])
    expect((await (await request.get(counts, { headers: observer })).json()).counts).toEqual({ [taskId]: 1 })

    await setCore({ user: "member", active: true, systemGenerated: true })
    expect((await request.post(comments, { headers: member, data })).status()).toBe(403)
    const valid = { id: "fixture-member", is_active: true, system_generated: false }
    for (const result of [null, [valid, {}], [valid, { ...valid, is_active: false }]]) {
      await setCore({ result })
      expect((await request.post(comments, { headers: member, data })).status()).toBe(403)
    }
    await setCore({ user: "member", active: true, systemGenerated: false })
    expect((await request.post(comments, { headers: keyed, data })).headers()["idempotency-key-status"]).toBe("cached")

    const alias = comments.replace(/comments$/, "%63omments")
    const cleanup = await request.post(alias, { headers: { ...keyed, "Idempotency-Key": "alias-unused" },
      data: { content: "Temporary comment" } })
    expect(cleanup.headers()["idempotency-key-status"]).toBeUndefined()
    expect(cleanup.status()).toBe(201)
    const deleted = await request.delete(comments + "/" + (await cleanup.json()).id, { headers: member, data: {} })
    expect(deleted.status()).toBe(204)
    expect(deleted.headers()["cache-control"]).toBe("no-store")

    const stalled = await startHeld(member)
    const stalledKeyed = await startHeld(keyed, data)
    for (const result of await Promise.all([stalled.response, stalledKeyed.response])) {
      expect(result).toEqual({ status: 408, type: "https://meitheal.local/problems/request-timeout",
        cache: "private, no-store", replay: undefined })
    }
    stalled.abort()
    stalledKeyed.abort()
    const interruptedHeaders = { ...member, "Idempotency-Key": "participant-disconnected" }
    const interruptedBody = { content: "Disconnected body" }
    const disconnected = await startHeld(interruptedHeaders, interruptedBody)
    disconnected.abort()
    await expect(disconnected.response).rejects.toThrow()
    const retryOfIncomplete = await request.post(comments, { headers: interruptedHeaders, data: interruptedBody })
    expect(retryOfIncomplete.status()).toBe(201)
    expect(retryOfIncomplete.headers()["idempotency-key-status"]).toBe("processed")
    expect((await request.delete(comments + "/" + (await retryOfIncomplete.json()).id, { headers: member, data: {} })).status()).toBe(204)

    const reservedHeaders = { ...member, "Idempotency-Key": "participant-disconnected-after-reservation" }
    const reservedBody = { content: "Interrupted after reservation" }
    await armLookup(2)
    const reservedHeld = once(child, "message", { signal: AbortSignal.timeout(4_000) })
    const reservedAbort = new AbortController()
    const reservedWrite = fetch(comments, {
      method: "POST", body: JSON.stringify(reservedBody), signal: reservedAbort.signal,
      headers: { ...reservedHeaders, "content-type": "application/json", "x-meitheal-fixture-watch-disconnect": "1" },
    })
    void reservedWrite.catch(() => {})
    expect((await reservedHeld)[0]).toEqual({ participantLookupHeld: true })
    const reservedClosed = once(child, "message", { signal: AbortSignal.timeout(4_000) })
    reservedAbort.abort()
    await expect(reservedWrite).rejects.toThrow()
    expect((await reservedClosed)[0]).toEqual({ participantReaderDisconnected: true })
    await expect.poll(async () => (await coreMetrics()).lookupStillHeld).toBe(false)
    child.send({ type: "fixture-core-release" })
    const retryOfReserved = await request.post(comments, { headers: reservedHeaders, data: reservedBody })
    expect(retryOfReserved.status()).toBe(201)
    expect(retryOfReserved.headers()["idempotency-key-status"]).toBe("processed")
    expect((await request.delete(comments + "/" + (await retryOfReserved.json()).id, { headers: member, data: {} })).status()).toBe(204)

    const leased = await request.get(comments, { headers: member })
    expect((await leased.json()).comments.some((row: { can_manage: boolean }) => row.can_manage)).toBe(true)
    await setCore({ user: "member", active: false })
    await expect.poll(async () => (await request.get(counts, { headers: member })).status(), {
      timeout: 6_500, intervals: [500],
    }).toBe(403)
    expect((await (await request.get(comments, { headers: member })).json()).comments).toEqual([
      expect.objectContaining({ id: commentId, can_manage: false }),
      expect.objectContaining({ id: parentId, can_manage: false }),
    ])

    await setCore({ user: "member", active: true, result: null })
    expect((await request.post(comments, { headers: member, data })).status()).toBe(403)
    await setCore({ user: "member", active: true })
    await armLookup(1)
    const leaseHeld = once(child, "message", { signal: AbortSignal.timeout(4_000) })
    const olderRead = request.get(comments, { headers: member })
    expect((await leaseHeld)[0]).toEqual({ participantLookupHeld: true })
    await setCore({ user: "member", active: false, result: null })
    expect((await request.post(comments, { headers: member, data })).status()).toBe(403)
    expect((await coreMetrics()).lookupStillHeld).toBe(true)
    child.send({ type: "fixture-core-release", snapshot: true })
    const historical = await olderRead
    expect((await historical.json()).comments.every((row: { can_manage: boolean }) => !row.can_manage)).toBe(true)
    await setCore({ user: "member", active: false })
    expect((await request.get(counts, { headers: member })).status()).toBe(403)

    await setCore({ unavailable: true })
    const before = (await coreMetrics()).membershipQueries
    const unavailable = await Promise.all(Array.from({ length: 24 }, () =>
      request.post(comments, { headers: member, data })))
    expect(unavailable.every(response => response.status() === 403)).toBe(true)
    expect((await coreMetrics()).membershipQueries - before).toBeLessThanOrEqual(16)
    await setCore({ user: "member", active: true })
    expect((await request.post(comments, { headers: keyed, data })).status()).toBe(201)

    await setCore({ result: null })
    expect((await request.post(comments, { headers: member, data })).status()).toBe(403)
    await setCore({ user: "member", active: true })
    const beforeCoalesced = (await coreMetrics()).membershipQueries
    await armLookup(1)
    const sharedHeld = once(child, "message", { signal: AbortSignal.timeout(4_000) })
    const cancelled = new AbortController()
    const cancelledRead = fetch(comments, {
      headers: { ...member, "x-meitheal-fixture-watch-disconnect": "1" },
      signal: cancelled.signal,
    })
    void cancelledRead.catch(() => {})
    expect((await sharedHeld)[0]).toEqual({ participantLookupHeld: true })
    const survivingRead = request.get(comments, { headers: member })
    const disconnectedReader = once(child, "message", { signal: AbortSignal.timeout(4_000) })
    cancelled.abort()
    await expect(cancelledRead).rejects.toThrow()
    expect((await disconnectedReader)[0]).toEqual({ participantReaderDisconnected: true })
    expect((await coreMetrics()).lookupStillHeld).toBe(true)
    child.send({ type: "fixture-core-release" })
    expect((await (await survivingRead).json()).comments.some((row: { can_manage: boolean }) => row.can_manage)).toBe(true)
    expect((await coreMetrics()).membershipQueries - beforeCoalesced).toBe(1)

    for (const response of loggedResponses) {
      const requestId = response.headers()["x-request-id"] ?? ""
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
      await expect.poll(() => logs.split("\n").find(line => line.includes(requestId) &&
        /http\.(?:api_request|slow_request)/.test(line))).toBeDefined()
      const line = logs.split("\n").find(line => line.includes(requestId) &&
        /http\.(?:api_request|slow_request)/.test(line))!
      expect(JSON.parse(line).metadata).toMatchObject({ path: expect.stringMatching(/^\/api\/tasks\/\[id\]\//),
        status: response.status() })
      expect(line).not.toMatch(/fixture-member|fixture-forged|trace_id|span_id|ha_user_id/)
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(4_000) })
      child.kill("SIGKILL")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})

test("an open task preserves input and focus when Core revokes its member", async ({ browser }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built App and Core ingress fixture")
  const work = await mkdtemp(join(tmpdir(), "meitheal-participant-ui-"))
  const child = startCoreFixture(work, true)
  child.stdout?.resume()
  child.stderr?.resume()
  const context = await browser.newContext({ extraHTTPHeaders: {}, serviceWorkers: "block", reducedMotion: "reduce" })
  try {
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `http://127.0.0.1:${fixture.port}`
    const root = origin + fixture.configuredPath
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const headers = { origin, "sec-fetch-site": "same-origin" }
    const title = "Participant access changes"
    const task = await context.request.post(root + "/api/tasks", { headers, data: { title, status: "active" } })
    expect(task.status()).toBe(201)
    const { id } = await task.json()
    const taskApi = root + "/api/tasks/" + id
    const comment = await context.request.post(taskApi + "/comments", { headers, data: { content: "Existing shared comment" } })
    expect(comment.status()).toBe(201)
    const commentId = (await comment.json()).id
    const reaction = await context.request.post(taskApi + "/reactions", { headers, data: { content: "✓" } })
    expect(reaction.status()).toBe(201)

    const page = await context.newPage()
    await page.goto(`${root}/tasks?open=${id}`)
    const detail = page.getByRole("dialog", { name: `Task detail: ${title}` })
    await expect(detail).toBeVisible()
    await expect(page).toHaveURL(url => url.pathname === fixture.configuredPath + "/tickets/" + encodeURIComponent(id))
    const detailUrl = page.url()
    const row = detail.locator(`#td-comment-${commentId}`)
    const edit = row.getByRole("button", { name: "Edit comment" })
    await edit.press("Enter")
    const editor = row.getByRole("textbox", { name: "Edit comment" })
    await editor.fill("Keep my comment edit")
    const composer = detail.locator("#td-comment-input")
    await composer.fill("Keep my new comment")
    const panel = detail.locator('[data-reaction-panel="task"]')
    await panel.locator("summary").press("Enter")
    await expect(panel.getByRole("listitem")).toContainText("✓")
    const reactionInput = panel.getByRole("textbox", { name: "Emoji or short text" })
    await reactionInput.fill("Keep my reaction")

    const changed = once(child, "message", { signal: AbortSignal.timeout(4_000) })
    child.send({ type: "fixture-core", user: "member", active: false })
    expect((await changed)[0]).toEqual({ coreChanged: true })
    const message = /Home Assistant could not verify your active account/
    await detail.getByRole("button", { name: "Post Comment" }).press("Enter")
    await expect(detail.locator("#td-comment-error")).toHaveText(message)
    await expect(composer).toHaveValue("Keep my new comment")
    await expect(composer).toBeFocused()

    await row.getByRole("button", { name: "Save comment" }).press("Enter")
    await expect(row.getByRole("alert")).toHaveText(message)
    await expect(editor).toHaveValue("Keep my comment edit")
    await expect(editor).toBeFocused()
    await row.getByRole("button", { name: "Cancel", exact: true }).press("Enter")
    const removeComment = row.getByRole("button", { name: "Delete comment" })
    await removeComment.press("Enter")
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete comment" }).press("Enter")
    await expect(row.getByRole("alert")).toHaveText(message)
    await expect(page.getByRole("alertdialog")).toHaveCount(0)
    await expect(row.getByText("Existing shared comment")).toBeVisible()
    await expect(removeComment).toBeFocused()

    await reactionInput.focus()
    await expect(reactionInput).toBeFocused()
    await reactionInput.press("Enter")
    await expect(panel.getByRole("alert")).toHaveText(message)
    await expect(reactionInput).toHaveValue("Keep my reaction")
    await expect(reactionInput).toBeFocused()
    const removeReaction = panel.getByRole("button", { name: "Remove reaction: ✓" })
    await removeReaction.press("Enter")
    await expect(panel.getByRole("alert")).toHaveText(message)
    await expect(removeReaction).toBeFocused()
    await expect(panel.getByRole("listitem")).toContainText("✓")
    await expect(panel.getByRole("status")).toBeEmpty()
    await expect(detail).toBeVisible()
    await expect(page).toHaveURL(detailUrl)
    await page.route(taskApi + "/comments", route => route.request().method() === "POST"
      ? route.fulfill({ status: 403, contentType: "text/plain", body: "Invalid ingress session" })
      : route.continue())
    const navigations: string[] = []
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations.push(frame.url()) })
    await detail.getByRole("button", { name: "Post Comment" }).press("Enter")
    await expect(detail.locator("#td-comment-error")).toHaveText(message)
    await expect(composer).toHaveValue("Keep my new comment")
    await expect(composer).toBeFocused()
    expect(await page.evaluate(() => sessionStorage.getItem("meitheal-ingress-reload"))).toBeNull()
    expect(navigations).toEqual([])
  } finally {
    await context.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(4_000) })
      child.kill()
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
