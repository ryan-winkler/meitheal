import type { ChildProcess } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, expect, test, type Browser, type Page } from "@playwright/test"
import type { TaskDraftSnapshot } from "../../apps/web/src/lib/task-draft-state"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built App and the HTTPS ingress fixture")

async function withBrowser(
  run: (browser: Browser, origin: string, prefix: string, child: ChildProcess, restart: () => Promise<void>) => Promise<void>,
  backForwardCache = false,
) {
  const work = await mkdtemp(join(tmpdir(), "meitheal-draft-browser-"))
  let child: ChildProcess | undefined
  let browser: Browser | undefined
  try {
    child = startCoreFixture(work)
    child.stdout?.resume()
    child.stderr?.resume()
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    browser = await launchPinBrowser(work, backForwardCache)
    async function restart() {
      const exited = once(child!, "exit", { signal: AbortSignal.timeout(3_000) })
      child!.kill("SIGKILL")
      await exited
      child = startCoreFixture(work, false, info.port)
      child.stdout?.resume()
      child.stderr?.resume()
      const [ready] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
      expect(ready).toEqual(info)
    }
    await run(browser, `https://127.0.0.1:${info.port}`, info.configuredPath, child, restart)
  } finally {
    await browser?.close()
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
      child.kill("SIGKILL")
      await closed
    }
    await rm(work, { recursive: true, force: true })
  }
}

async function ownerPage(browser: Browser, origin: string, owner: string, timezoneId?: string) {
  const context = await browser.newContext({
    extraHTTPHeaders: {}, reducedMotion: "reduce", serviceWorkers: "block",
    viewport: { width: 320, height: 700 }, hasTouch: true, isMobile: true,
    ...(timezoneId ? { timezoneId } : {}),
  })
  await context.addCookies([{ name: "feedback-fixture", value: owner, url: origin }])
  const page = await context.newPage()
  page.setDefaultTimeout(5_000)
  return page
}

async function openCapture(page: Page) {
  await page.bringToFront()
  await expect(page.locator("#new-task-overlay")).toHaveAttribute("data-new-task-controller", "ready")
  await page.evaluate(() => window.openNewTaskModal?.())
  await expect(page.locator("#new-task-title-input")).toBeFocused()
}

function draftAction(page: Page, name: string) {
  return page.locator("#new-task-overlay").getByRole("button", { name, exact: true })
}

test("save, resume, edit and publish a private capture with keyboard and a narrow viewport", async () => {
  await withBrowser(async (browser, origin, prefix) => {
    const page = await ownerPage(browser, origin, "member")
    const requests: string[] = []
    let editorAssets = 0
    page.on("request", request => {
      const pathname = new URL(request.url()).pathname
      if (pathname === prefix + "/api/task-drafts") requests.push(request.method())
      if (/task-draft-controller[.-]/.test(pathname)) editorAssets++
    })
    await page.goto(origin + prefix + "/today")
    expect(editorAssets).toBe(0)
    await openCapture(page)
    expect(requests).toEqual([])
    await expect.poll(() => editorAssets).toBe(1)
    const title = page.locator("#new-task-title-input")
    const sentinel = "Private capture " + "界".repeat(120)
    const label = "unpublished-draft-label"
    await page.locator('[data-kind="checklist"]').click()
    await title.fill(sentinel)
    await page.locator("#new-task-desc-input").fill("<b>Supplies</b> and a long note")
    await page.locator("#nt-checklist-builder-input").fill("Pack raincoat\nFill flask")
    await page.locator("#nt-options > summary").click()
    await page.locator("#new-task-label-picker-input").fill(label)
    await page.locator("#new-task-label-picker-input").press("Enter")
    await expect(page.locator("#new-task-label-picker-selected")).toContainText(label)
    await draftAction(page, "Draft").click()
    await draftAction(page, "Save draft").click()
    await expect(page.locator("#nt-draft-status")).toHaveText("Draft saved.")
    await expect(draftAction(page, "Publish draft")).toBeEnabled()

    const other = await ownerPage(browser, origin, "member-two")
    await other.goto(origin + prefix + "/fixture")
    const shared = await other.evaluate(async prefix => {
      const [tasks, labels] = await Promise.all([fetch(prefix + "/api/tasks"), fetch(prefix + "/api/labels")])
      return { tasks: await tasks.text(), labels: await labels.text(), statuses: [tasks.status, labels.status] }
    }, prefix)
    expect(shared.statuses).toEqual([200, 200])
    expect(shared.tasks).not.toContain("Private capture")
    expect(shared.labels).not.toContain(label)
    await other.close()

    await page.bringToFront()
    await page.reload()
    await openCapture(page)
    await expect(title).toHaveValue("")
    await draftAction(page, "Draft").click()
    await expect(draftAction(page, "Resume draft")).toBeVisible()
    await title.fill("Unsaved replacement")
    await draftAction(page, "Resume draft").click()
    await expect(draftAction(page, "Keep editing")).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(draftAction(page, "Resume draft")).toBeFocused()
    await expect(title).toHaveValue("Unsaved replacement")
    await draftAction(page, "Resume draft").click()
    await draftAction(page, "Confirm").click()
    await expect(title).toHaveValue(sentinel)
    await expect(title).toBeFocused()
    await expect(page.locator("#new-task-desc-input")).toHaveValue("<b>Supplies</b> and a long note")
    await expect(page.locator("#nt-checklist-builder-input")).toHaveValue("Pack raincoat\nFill flask")
    await expect(page.locator("#new-task-label-picker-selected")).toContainText(label)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

    await title.fill("Published edited capture")
    await page.locator("#nt-checklist-builder-input").press("Control+Enter")
    await expect(page.locator("#nt-draft-status")).toContainText("MTH-1 was published.")
    await expect(draftAction(page, "Open task")).toBeFocused()
    await draftAction(page, "Open task").press("Enter")
    await expect(page.locator("#task-detail-overlay")).toHaveClass(/active/)
    const final = await page.evaluate(async prefix => {
      const result = await fetch(prefix + "/api/tasks/MTH-1")
      return result.json()
    }, prefix)
    expect(final).toMatchObject({ title: "Published edited capture", task_kind: "checklist" })
    expect(JSON.parse(final.checklists)).toMatchObject([{ text: "Pack raincoat" }, { text: "Fill flask" }])
    expect(JSON.parse(final.labels)).toContain(label)
  })
})

test("a lost publication acknowledgement resolves once after app restart and reload", async () => {
  await withBrowser(async (browser, origin, prefix, child, restart) => {
    const page = await ownerPage(browser, origin, "member")
    await page.goto(origin + prefix + "/today")
    await openCapture(page)
    const title = page.locator("#new-task-title-input")
    await title.fill("Lost acknowledgement synthetic capture")
    await draftAction(page, "Draft").click()
    await draftAction(page, "Save draft").click()
    await expect(page.locator("#nt-draft-status")).toHaveText("Draft saved.")

    const armed = once(child, "message", { signal: AbortSignal.timeout(3_000) })
    child.send({ type: "drop-draft-receipt" })
    expect((await armed)[0]).toEqual({ droppingDraftReceipt: true })
    const outcome = once(child, "message", { signal: AbortSignal.timeout(5_000) })
    await draftAction(page, "Publish draft").click()
    expect((await outcome)[0]).toEqual({ draftReceiptStatus: 201 })
    await expect(page.locator("#nt-draft-status")).toContainText("could not confirm")
    const marker = await page.evaluate(() => sessionStorage.getItem("meitheal-draft-operation"))
    expect(marker).toContain("attemptId")
    expect(marker).not.toContain("Lost acknowledgement")
    expect(marker).not.toContain("context")

    await restart()
    await page.reload()
    await openCapture(page)
    await expect(page.locator("#nt-draft-status")).toContainText("MTH-1 was published.")
    await expect(draftAction(page, "Open task")).toBeFocused()
    expect(await page.evaluate(() => sessionStorage.getItem("meitheal-draft-operation"))).toBeNull()
    const listed = await page.evaluate(async prefix => await (await fetch(prefix + "/api/tasks")).json(), prefix)
    expect(listed.total).toBe(1)
    expect(listed.tasks[0].title).toBe("Lost acknowledgement synthetic capture")
  })
})

test("shopping, custom fields and files respect the saved snapshot boundary", async () => {
  await withBrowser(async (browser, origin, prefix) => {
    const page = await ownerPage(browser, origin, "member")
    await page.goto(origin + prefix + "/today")
    await openCapture(page)
    await page.locator('[data-kind="shopping_item"]').click()
    const title = page.locator("#new-task-title-input")
    await title.fill("Shopping draft")
    const queued = page.locator("#nt-shopping-item-input")
    const category = page.locator("#nt-shopping-category")
    await category.selectOption("produce")
    await queued.fill("Apple")
    await queued.press("Enter")
    await category.selectOption("pantry")
    await queued.fill("Apple")
    await queued.press("Enter")
    await page.getByRole("button", { name: /Remove Apple.*Pantry/ }).click()
    await category.selectOption("dairy")
    await queued.fill("Milk")

    async function addField(type: string) {
      await page.locator("#nt-add-custom-field-btn").click()
      await page.locator(`[data-field-type="${type}"].nt-add-field-type`).click()
    }
    await page.locator("#nt-options > summary").click()
    await addField("url")
    await page.locator('.nt-custom-field-entry[data-field-type="url"] input').fill("https://example.test/supplies")
    await addField("checkbox")
    const checkbox = page.locator('.nt-custom-field-entry[data-field-type="checkbox"]')
    await checkbox.locator('[type="text"]').fill("Bring bags")
    await checkbox.locator('[type="checkbox"]').check()
    await expect(page.locator('.nt-add-field-type[data-field-type="attachment"]')).toHaveCount(0)
    // Keep the defensive file boundary covered even though creation no longer offers an unsupported attachment action.
    await page.evaluate(() => {
      const file = document.createElement("input")
      file.id = "draft-file-boundary-probe"
      file.type = "file"
      file.className = "sr-only"
      document.getElementById("new-task-form")!.append(file)
    })
    await page.locator("#draft-file-boundary-probe").setInputFiles({
      name: "draft-file-must-not-persist.txt", mimeType: "text/plain", buffer: Buffer.from("fixture only"),
    })
    await draftAction(page, "Draft").click()
    await draftAction(page, "Save draft").click()
    await expect(page.locator("#nt-draft-status")).toContainText("Remove the selected file")
    await page.locator("#draft-file-boundary-probe").evaluate(element => element.remove())
    await draftAction(page, "Save draft").click()
    await expect(page.locator("#nt-draft-status")).toHaveText("Draft saved.")

    await page.reload()
    await openCapture(page)
    await draftAction(page, "Draft").click()
    await draftAction(page, "Resume draft").click()
    await expect(title).toHaveValue("Shopping draft")
    await expect(page.getByRole("button", { name: /Remove Apple.*Produce/ })).toBeVisible()
    await expect(page.getByRole("button", { name: /Remove Apple.*Pantry/ })).toHaveCount(0)
    await expect(queued).toHaveValue("Milk")
    await expect(checkbox.locator('[type="checkbox"]')).toBeChecked()
    await expect(checkbox.locator('[type="text"]')).toHaveValue("Bring bags")
    await expect(page.locator('.nt-custom-field-entry[data-field-type="url"] input')).toHaveValue("https://example.test/supplies")
    const quantity = page.locator("#nt-shopping-qty")
    await quantity.fill("1000")
    await queued.press("Control+Enter")
    await expect(page.locator("#nt-capture-validation")).toHaveText("Enter a quantity from 1 to 999.")
    await quantity.fill("2")
    await queued.press("Control+Enter")
    await expect(page.locator("#nt-draft-status")).toContainText("MTH-1 was published.")
    const task = await page.evaluate(async prefix => await (await fetch(prefix + "/api/tasks/MTH-1")).json(), prefix)
    expect(JSON.parse(task.custom_fields)).toMatchObject({
      items: [{ name: "Apple", category: "produce", qty: 1 }, { name: "Milk", category: "dairy", qty: 2 }],
      fields: [{ type: "url", value: "https://example.test/supplies" }, { type: "checkbox", label: "Bring bags", checked: true }],
    })
  })
})

test("a bound draft is withdrawn during real history restoration until the account is verified", async () => {
  test.skip(!existsSync(process.env.MEITHEAL_BFCACHE_CHROMIUM ?? chromium.executablePath()), "Requires full Chromium with history cache support")
  await withBrowser(async (browser, origin, prefix) => {
    const page = await ownerPage(browser, origin, "member")
    const draftPath = origin + prefix + "/api/task-drafts"
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Page.enable")
    let historyDiagnostic: unknown
    cdp.on("Page.backForwardCacheNotUsed", event => { historyDiagnostic = event.notRestoredExplanationsTree })
    await page.route(/\/api\/sse(?:[/?]|$)/, route => route.fulfill({ status: 204 }))
    await page.addInitScript(() => {
      window.addEventListener("pageshow", event => {
        if (event.persisted) document.documentElement.dataset.draftHistoryRestored = "true"
      })
    })
    await page.goto(origin + prefix + "/today")
    await openCapture(page)
    const title = page.locator("#new-task-title-input")
    await title.fill("History private sentinel")
    await draftAction(page, "Draft").click()
    await draftAction(page, "Save draft").click()
    await expect(page.locator("#nt-draft-status")).toHaveText("Draft saved.")
    await title.fill("Unsaved private edit")
    await page.goto(origin + prefix + "/fixture")

    let releaseHead = () => {}
    const headHeld = new Promise<void>(resolve => { releaseHead = resolve })
    let headStarted = false
    await page.route(draftPath, async route => {
      if (route.request().method() === "HEAD") {
        headStarted = true
        await headHeld
      }
      await route.continue().catch(() => {})
    })
    try {
      await page.goBack({ waitUntil: "commit" })
      try {
        await expect(page.locator("html")).toHaveAttribute("data-draft-history-restored", "true")
      } catch (error) {
        console.error(JSON.stringify({ historyDiagnostic, navigation: await page.evaluate(() =>
          performance.getEntriesByType("navigation").map(entry => entry.toJSON())) }))
        throw error
      }
      await expect.poll(() => headStarted).toBe(true)
      await expect(title).toHaveValue("")
      await expect(draftAction(page, "Publish draft")).toBeDisabled()
    } finally {
      releaseHead()
    }
    await expect(draftAction(page, "Reload saved draft")).toBeVisible()
    await draftAction(page, "Reload saved draft").click()
    await draftAction(page, "Confirm").click()
    await expect(title).toHaveValue("History private sentinel")
    await expect(draftAction(page, "Publish draft")).toBeEnabled()
  }, true)
})

test("an older controlling worker withholds draft requests until explicit update", async () => {
  await withBrowser(async (browser, origin, prefix, child) => {
    const context = await browser.newContext({ extraHTTPHeaders: {}, reducedMotion: "reduce" })
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const page = await context.newPage()
    const old = once(child, "message", { signal: AbortSignal.timeout(3_000) })
    child.send({ type: "fixture-worker", old: true })
    await old
    await page.goto(origin + prefix + "/fixture")
    await page.evaluate(async prefix => {
      await navigator.serviceWorker.register(prefix + "/sw.js", { scope: prefix + "/" })
    }, prefix)
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated")
    const encodedDraft = origin + prefix + "/api/%2574ask-drafts/"
    await page.evaluate(async url => {
      const cache = await caches.open("meitheal-api-v0.0.1")
      await cache.put(url, new Response("stale private fixture"))
    }, encodedDraft)
    const requests: string[] = []
    page.on("request", request => {
      if (new URL(request.url()).pathname === prefix + "/api/task-drafts") requests.push(request.method())
    })
    await page.goto(origin + prefix + "/today")
    await openCapture(page)
    await draftAction(page, "Draft").click()
    await expect(draftAction(page, "Activate app update")).toBeVisible()
    expect(requests).toEqual([])
    const current = once(child, "message", { signal: AbortSignal.timeout(3_000) })
    child.send({ type: "fixture-worker", old: false })
    await current
    await draftAction(page, "Activate app update").click()
    await expect(page.locator("#nt-draft-status")).toContainText(/Activating|activated/)
    await expect.poll(async () => await page.evaluate(async url => Boolean(await caches.match(url)), encodedDraft)).toBe(false)
    await draftAction(page, "Check for saved draft").click()
    await expect(draftAction(page, "Save draft")).toBeVisible()
    expect(requests).toEqual(["POST", "HEAD"])
  })
})

test("account switch during a simulated focus change clears the old draft before a clean capture", async () => {
  await withBrowser(async (browser, origin, prefix) => {
    const page = await ownerPage(browser, origin, "member")
    await page.goto(origin + prefix + "/today")
    await openCapture(page)
    const title = page.locator("#new-task-title-input")
    await title.fill("Other owner saved private draft")
    await draftAction(page, "Draft").click()
    await draftAction(page, "Save draft").click()
    await expect(page.locator("#nt-draft-status")).toHaveText("Draft saved.")
    await title.fill("Other owner unsaved private edit")

    await page.evaluate(() => window.dispatchEvent(new Event("blur")))
    await expect(title).toHaveValue("")
    await expect(draftAction(page, "Publish draft")).toBeDisabled()
    await page.context().addCookies([{ name: "feedback-fixture", value: "member-two", url: origin }])
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect(page.locator("#nt-draft-status")).toContainText("session changed")
    await expect(title).toHaveValue("")
    await expect(draftAction(page, "Publish draft")).toBeDisabled()
    await draftAction(page, "Start new task").click()
    await expect(title).toBeFocused()
    await expect(draftAction(page, "Create Task")).toBeEnabled()
    await title.fill("Independent ordinary capture")
    await draftAction(page, "Create Task").click()
    await expect(page.locator("#new-task-overlay")).not.toHaveClass(/active/)
    const detail = page.getByRole("dialog", { name: "Task detail: Independent ordinary capture" })
    await expect(detail).toBeVisible()
    const shared = await page.evaluate(async prefix => await (await fetch(prefix + "/api/tasks")).json(), prefix)
    expect(shared.total).toBe(1)
    expect(shared.tasks[0].title).toBe("Independent ordinary capture")
    expect(new URL(page.url()).pathname).toBe(prefix + "/tickets/" + encodeURIComponent(shared.tasks[0].id))
    await detail.getByRole("button", { name: "Close detail" }).click()
    await expect(detail).toBeHidden()

    await page.context().addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    await page.reload()
    await openCapture(page)
    await draftAction(page, "Draft").click()
    await draftAction(page, "Resume draft").click()
    await expect(title).toHaveValue("Other owner saved private draft")
    await draftAction(page, "Discard draft").click()
    await draftAction(page, "Confirm").click()
    await expect(page.locator("#nt-draft-status")).toHaveText("Draft discarded.")
    await expect(title).toBeFocused()
  })
})


for (const due of ["2026-12-13T15:26:32.456+05:30", "2026-12-13"]) {
  test(`legacy draft preserves ${due.includes("T") ? "timed" : "date-only"} due, priority 5 and custom recurrence through save and publication`, async () => {
    await withBrowser(async (browser, origin, prefix) => {
      const page = await ownerPage(browser, origin, "member", "America/New_York")
      await page.goto(origin + prefix + "/fixture")
      const snapshot: TaskDraftSnapshot = {
        version: 1, title: "Legacy title\nSecond line", description: "Original description", taskKind: "calendar_event",
        status: "active", priority: 5, due, labels: [], newLabels: [], assignedTo: "", goal: "",
        recurrence: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", isRoutine: false,
        checklist: { items: [], input: "" }, shopping: { items: [], input: "", quantity: "1", category: "" },
        event: { start: "2026-12-12T14:25:31.123+05:30", end: "2026-12-12T15:25:31.987+05:30", location: "", allDay: false, calendar: "" },
        fields: [],
      }
      // Seed a prior valid snapshot through the real guarded API, independently of current form choices.
      const seeded = await page.evaluate(async ({ prefix, snapshot }) => {
        const path = prefix + "/api/task-drafts"
        const read = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "read" }) })
        const state = await read.json()
        const saved = await fetch(path, {
          method: "PUT", headers: { "content-type": "application/json", "X-Meitheal-Draft-Context": state.context },
          body: JSON.stringify({ action: "save", expected: null, attemptId: crypto.randomUUID(), snapshot }),
        })
        return { status: saved.status, body: await saved.json() }
      }, { prefix, snapshot })
      expect(seeded.status).toBe(200)
      expect(seeded.body.draft.snapshot).toEqual(snapshot)
      await page.goto(origin + prefix + "/today")
      await openCapture(page)
      await draftAction(page, "Draft").click()
      await draftAction(page, "Resume draft").click()
      await expect(page.locator("#new-task-title-input")).toHaveValue(snapshot.title)
      expect(await page.locator("#new-task-title-input").evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true)
      await expect(page.locator("#new-task-priority")).toHaveValue("5")
      await expect(page.locator("#new-task-recurrence")).toHaveValue(snapshot.recurrence)
      await expect(page.locator("#nt-contextual-due")).toHaveValue(snapshot.due)
      await expect(page.locator("#nt-event-start")).toHaveValue("2026-12-12T03:55:31.123")
      await expect(page.locator("#nt-event-end")).toHaveValue("2026-12-12T04:55:31.987")
      const edited = { ...snapshot, description: "Edited unrelated description" }
      await page.locator("#new-task-desc-input").fill(edited.description)
      await draftAction(page, "Save draft").click()
      await expect(page.locator("#nt-draft-status")).toHaveText("Draft saved.")
      const persisted = await page.evaluate(async prefix => {
        const response = await fetch(prefix + "/api/task-drafts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "read" }) })
        return (await response.json()).draft.snapshot
      }, prefix)
      expect(persisted).toEqual(edited)
      await page.reload()
      await openCapture(page)
      await draftAction(page, "Draft").click()
      await draftAction(page, "Resume draft").click()
      await expect(page.locator("#new-task-title-input")).toHaveValue(snapshot.title)
      await expect(page.locator("#new-task-priority")).toHaveValue("5")
      await expect(page.locator("#new-task-recurrence")).toHaveValue(snapshot.recurrence)
      const sent = page.waitForResponse(response => response.url() === origin + prefix + "/api/task-drafts"
        && response.request().method() === "PUT" && response.request().postDataJSON()?.action === "publish")
      await draftAction(page, "Publish draft").click()
      const published = await sent
      expect(published.status()).toBe(201)
      const publication = published.request().postDataJSON().task
      const expectedDue = due.includes("T") ? due : due + "T00:00:00.000Z"
      expect(publication).toMatchObject({
        title: snapshot.title, description: edited.description, priority: 5, recurrence_rule: snapshot.recurrence,
        due_date: expectedDue, start_date: snapshot.event.start, end_date: snapshot.event.end,
      })
      const task = await page.evaluate(async prefix => await (await fetch(prefix + "/api/tasks/MTH-1")).json(), prefix)
      expect(task).toMatchObject({ title: snapshot.title, description: edited.description, priority: 5,
        recurrence_rule: snapshot.recurrence, due_date: expectedDue, start_date: snapshot.event.start, end_date: snapshot.event.end })
    })
  })
}
