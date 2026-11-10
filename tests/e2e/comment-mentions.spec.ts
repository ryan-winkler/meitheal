import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChildProcess } from "node:child_process"
import { expect, test, type Browser, type Page } from "@playwright/test"
import { commentMentionToken, commentMentions } from "../../apps/web/src/lib/comment-mentions"
import { launchPinBrowser, pinRequest, startCoreFixture } from "../scripts/task-pins-fixture"

test("only canonical markers outside escaped text, code and links are comment mentions", () => {
  const key = "a".repeat(32)
  const marker = commentMentionToken(key, "Bríd · household")
  const text = [marker, "\\" + marker, "` " + marker + " `", "[ " + marker + " ](https://example.invalid)",
    "@ordinary", "@{person:" + key + "|%ff}", marker].join(" ")
  expect(commentMentions(text).map(({ key, label }) => ({ key, label }))).toEqual([
    { key, label: "Bríd · household" }, { key, label: "Bríd · household" },
  ])
})

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) })
  child.kill("SIGTERM")
  await exited
}

async function coreChange(child: ChildProcess, user: string, fields: { name?: string, active?: boolean, unavailable?: boolean }) {
  const changed = once(child, "message", { signal: AbortSignal.timeout(5_000) })
  child.send({ type: "fixture-core", user, ...fields })
  expect((await changed)[0]).toEqual({ coreChanged: true })
}

test("comment picker and inbox stay private through edits, removal, restart and revocation", async ({ request }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built app and HTTPS ingress fixture")
  test.slow()
  for (const path of ["/api/%63omment-people", "/api/mention-inbox/", "/%6dention-inbox"]) {
    const denied = await request.get(path, { maxRedirects: 0 })
    expect(denied.status()).toBe(404)
    expect(denied.headers()["cache-control"]).toBe("private, no-store")
  }
  const work = await mkdtemp(join(tmpdir(), "mention-"))
  let child = startCoreFixture(work)
  let browser: Browser | undefined
  function fixture() {
    child.stdout?.resume()
    child.stderr?.resume()
    return once(child, "message", { signal: AbortSignal.timeout(10_000) })
  }
  try {
    const [info] = await fixture()
    const origin = `https://127.0.0.1:${info.port}`
    const prefix: string = info.configuredPath
    const root = origin + prefix
    await coreChange(child, "member", { name: "Bríd Byrne" })
    await coreChange(child, "member-two", { name: "Cian Carr" })
    await coreChange(child, "admin", { name: "Aideen Admin" })
    browser = await launchPinBrowser(work)
    const sessions = await Promise.all(["admin", "member", "member-two"].map(async user => {
      const context = await browser!.newContext({ extraHTTPHeaders: {}, ignoreHTTPSErrors: true, viewport: { width: 320, height: 720 }, hasTouch: true, reducedMotion: "reduce" })
      await context.addCookies([{ name: "feedback-fixture", value: user, url: origin }])
      return context.newPage()
    }))
    const [sender, recipient, other] = sessions as [Page, Page, Page]
    expect((await sender.goto(root + "/fixture"))?.status()).toBe(200)
    const created = await pinRequest(sender, prefix + "/api/tasks", "POST", { title: "Private mention journey" })
    expect(created.status).toBe(201)
    const taskId = created.body.id as string
    const commentUrl = root + `/api/tasks/${taskId}/comments`
    const apiHeaders = { origin, "sec-fetch-site": "same-origin" }
    await sender.goto(root + "/today?open=" + taskId)
    await sender.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated")
    await expect(sender.locator("#td-title")).toHaveValue("Private mention journey")
    const input = sender.locator("#td-comment-input")
    await input.fill("Please check @Br")
    const list = sender.getByRole("listbox", { name: "People to mention" })
    await expect(list.getByRole("option", { name: "Bríd Byrne" })).toBeVisible()
    await expect(list.getByRole("option")).toHaveCount(1)
    await input.press("ArrowDown")
    await input.press("Enter")
    await expect(input).toHaveValue(/Please check @\{person:/)
    const sent = input.inputValue()
    const [receipt] = await Promise.all([
      sender.waitForResponse(response => response.url() === commentUrl && response.request().method() === "POST"),
      sender.locator("#td-comment-submit").click(),
    ])
    expect(receipt.status()).toBe(201)
    const id = (await receipt.json()).id as number
    const attempt = (await receipt.request().allHeaders())["x-meitheal-comment-attempt"]!
    const text = await sent
    const marker = text.slice("Please check ".length)
    await expect(sender.locator("#td-comment-" + id)).toContainText("@Bríd Byrne")
    const replay = () => sender.request.post(commentUrl, { headers: { ...apiHeaders, "x-meitheal-comment-attempt": attempt }, data: { content: text } })
    expect((await (await replay()).json()).id).toBe(id)
    expect((await sender.request.post(commentUrl, {
      headers: { ...apiHeaders, "x-meitheal-comment-attempt": attempt }, data: { content: "Changed " + marker },
    })).status()).toBe(409)

    const inbox = root + "/mention-inbox"
    const recipientLink = recipient.getByRole("link", { name: "Private mention journey" })
    await recipient.goto(inbox)
    await expect(recipientLink).toHaveAttribute("href", `${prefix}/tasks?open=${taskId}&comment=${id}`)
    await expect(recipient.getByRole("status").filter({ hasText: "Unread: 1" })).toBeVisible()
    await other.goto(inbox)
    await expect(other.getByText("You have no mentions.")).toBeVisible()
    await expect(other.getByRole("link", { name: "Private mention journey" })).toHaveCount(0)
    await recipient.getByRole("button", { name: "Mark as read: Private mention journey" }).click()
    await expect(recipient.getByRole("button", { name: "Mark as unread: Private mention journey" })).toBeFocused()
    await recipient.reload()
    await expect(recipient.getByRole("button", { name: "Mark as unread: Private mention journey" })).toBeVisible()

    const editor = sender.locator("#td-comment-" + id)
    await editor.getByRole("button", { name: "Edit comment" }).click()
    const edit = editor.getByRole("textbox", { name: "Edit comment" })
    await edit.fill("Changed without mention")
    await editor.getByRole("button", { name: "Save comment" }).click()
    await expect(editor).toContainText("Changed without mention")
    await recipient.getByRole("button", { name: "Refresh inbox" }).click()
    await expect(recipient.getByText("You have no mentions.")).toBeVisible()
    await editor.getByRole("button", { name: "Edit comment" }).click()
    await edit.fill("Mention again @Br")
    await expect(list.getByRole("option", { name: "Bríd Byrne" })).toBeVisible()
    await list.getByRole("option", { name: "Bríd Byrne" }).tap()
    await expect(edit).toHaveValue(/Mention again @\{person:/)
    await editor.getByRole("button", { name: "Save comment" }).click()
    await expect(editor).toContainText("@Bríd Byrne")
    await recipient.getByRole("button", { name: "Refresh inbox" }).click()
    await expect(recipient.getByRole("button", { name: "Mark as unread: Private mention journey" })).toBeVisible()
    const cachedPaths = await recipient.evaluate(async () => {
      const keys = await caches.keys()
      const entries = await Promise.all(keys.map(async key => (await caches.open(key)).keys()))
      return entries.flat().filter(entry => /\/(?:comment-people|mention-inbox)(?:\?|$)/.test(entry.url)).map(entry => entry.url)
    })
    expect(cachedPaths).toEqual([])

    await recipient.getByRole("button", { name: "Mark as unread: Private mention journey" }).click()
    await expect(recipient.getByRole("status").filter({ hasText: "Unread: 1" })).toBeVisible()
    await recipient.getByRole("button", { name: "Mark all as read" }).click()
    await expect(recipient.getByRole("status").filter({ hasText: "Unread: 0" })).toBeVisible()

    // Changing the HA session under a loaded page must not expose a new account.
    const contextKey = await recipient.locator("[data-mention-inbox]").getAttribute("data-context")
    const contextStatus = () => recipient.evaluate(async ({ path, contextKey }) => {
      const response = await fetch(path, {
        method: "POST", mode: "same-origin", referrerPolicy: "same-origin", headers: {
          "Content-Type": "application/json", "X-Meitheal-Mention-Context": contextKey!,
        }, body: JSON.stringify({ action: "list", before: null }),
      })
      return [response.status, response.headers.get("cache-control")]
    }, { path: prefix + "/api/mention-inbox", contextKey })
    await recipient.context().addCookies([{ name: "feedback-fixture", value: "member-two", url: origin }])
    expect(await contextStatus()).toEqual([409, "private, no-store"])
    await recipient.context().addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    await coreChange(child, "member", { active: false })
    expect(await contextStatus()).toEqual([403, "private, no-store"])
    await recipient.getByRole("button", { name: "Refresh inbox" }).click()
    await expect(recipientLink).toHaveCount(0)
    await expect(recipient.getByText("Open the inbox again through Home Assistant with your active account.")).toBeVisible()

    const priorWhileRecipientRevoked = await replay()
    expect(priorWhileRecipientRevoked.status()).toBe(201)
    expect((await priorWhileRecipientRevoked.json()).id).toBe(id)
    await coreChange(child, "member", { unavailable: true })
    expect((await replay()).status()).toBe(403)
    const attemptWhileUnavailable = await sender.request.post(commentUrl, {
      headers: { ...apiHeaders, "x-meitheal-comment-attempt": `${Date.now()}.${crypto.randomUUID()}` },
      data: { content: text },
    })
    expect(attemptWhileUnavailable.status()).toBe(403)
    await coreChange(child, "member", { unavailable: false })
    expect((await (await sender.request.get(commentUrl)).json()).comments).toHaveLength(1)
    const deletion = await sender.request.delete(commentUrl + "/" + id, { headers: apiHeaders })
    expect(deletion.status(), await deletion.text()).toBe(204)
    await stop(child)
    child = startCoreFixture(work, false, info.port)
    await fixture()
    await coreChange(child, "member", { name: "Bríd Byrne" })
    expect((await replay()).status()).toBe(410)
    const after = await sender.request.get(commentUrl)
    expect((await after.json()).comments).toEqual([])
    await recipient.goto(inbox)
    await expect(recipient.getByText("You have no mentions.")).toBeVisible()
    await recipient.context().setOffline(true)
    await recipient.getByRole("button", { name: "Refresh inbox" }).click()
    await expect(recipient.getByText("Could not load mentions. Refresh and try again.")).toBeVisible()
  } finally {
    await browser?.close()
    await stop(child)
    await rm(work, { recursive: true, force: true })
  }
})
