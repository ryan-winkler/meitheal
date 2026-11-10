import type { ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Browser, type Page } from "@playwright/test"
import { launchPinBrowser, pinRequest, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built app and HTTPS ingress fixture")

async function withIngress(run: (page: Page, root: string, prefix: string, child: ChildProcess) => Promise<void>) {
  const work = await mkdtemp(join(tmpdir(), "meitheal-task-references-"))
  const child = startCoreFixture(work)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser: Browser | undefined
  try {
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const prefix: string = fixture.configuredPath
    const root = origin + prefix
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({
      extraHTTPHeaders: {}, viewport: { width: 320, height: 700 },
      isMobile: true, hasTouch: true, reducedMotion: "reduce",
    })
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const page = await context.newPage()
    expect((await page.goto(root + "/fixture"))?.status()).toBe(200)
    await run(page, root, prefix, child)
  } finally {
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
      child.kill("SIGKILL")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
}

async function seedTask(page: Page, prefix: string, title: string, description = "") {
  const created = await pinRequest(page, prefix + "/api/tasks", "POST", { title, description })
  expect(created.status).toBe(201)
  return created.body as { id: string, ticket_key: string }
}

test("task references preserve text editing and open the saved task through HTTPS ingress", async () => {
  await withIngress(async (page, root, prefix) => {
    const untrusted = await page.evaluate(async () => {
      const response = await fetch("/api/search?scope=tasks", { cache: "no-store" })
      return [response.status, response.headers.get("cache-control")]
    })
    expect(untrusted).toEqual([401, "private, no-store"])

    const source = await seedTask(page, prefix, "Reference source", "Existing description")
    const target = await seedTask(page, prefix, "Reference target " + "界".repeat(70))
    const other = await seedTask(page, prefix, "Independent orchard fixture")
    const lookups: URL[] = []
    page.on("request", request => {
      const url = new URL(request.url())
      if (url.pathname.endsWith("/api/search")) lookups.push(url)
    })
    await page.goto(root + "/today?open=" + source.id)
    await expect(page.locator("#td-title")).toHaveValue("Reference source")
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated")
    await page.locator("#td-desc-edit-btn-hover").click()
    const description = page.getByRole("textbox", { name: "Description", exact: true })
    const list = page.getByRole("listbox", { name: "Tasks to link" })
    const option = list.getByRole("option", { name: /Reference target/ })
    expect(lookups).toEqual([])

    await description.fill("#")
    await expect(option).toBeVisible()
    expect(lookups.at(-1)?.searchParams.get("q")).toBeNull()
    await description.press("Enter")
    await expect(description).toHaveValue("#\n")
    await expect(list).toBeHidden()

    await description.fill("# Friday plan\nFollow  next.")
    await description.evaluate((element: HTMLTextAreaElement) => {
      const at = element.value.lastIndexOf(" next.")
      element.setSelectionRange(at, at)
    })
    const [search] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).searchParams.get("q") === target.ticket_key),
      description.pressSequentially("#" + target.ticket_key),
    ])
    expect(search.status()).toBe(200)
    expect(search.headers()["cache-control"]).toBe("private, no-store")
    expect(search.request().method()).toBe("GET")
    const lookup = new URL(search.url())
    expect(lookup.pathname).toBe(prefix + "/api/search")
    expect(lookup.searchParams.get("scope")).toBe("tasks")
    expect(lookup.searchParams.get("task_fields")).toBe("id,title")
    expect(lookup.searchParams.get("limit")).toBe("5")
    await expect(option).toBeVisible()
    expect(await option.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)
    expect(await list.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await description.press("ArrowDown")
    await expect(option).toHaveAttribute("aria-selected", "true")
    await expect(option).toHaveCSS("outline-width", "2px")
    await expect(description).toHaveAttribute("aria-activedescendant", (await option.getAttribute("id"))!)
    await description.press("Enter")
    const storedLink = `[${target.ticket_key}](/tickets/${target.id})`
    const editedDescription = `# Friday plan\nFollow ${storedLink} next.`
    await expect(description).toHaveValue(editedDescription)
    await expect(description).toBeFocused()
    await description.press("Control+z")
    await expect(description).toHaveValue(`# Friday plan\nFollow #${target.ticket_key} next.`)
    await description.press("Control+Shift+z")
    await expect(description).toHaveValue(editedDescription)

    const [saved] = await Promise.all([
      page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === prefix + "/api/tasks/" + source.id),
      page.locator("#td-desc-save-btn").click(),
    ])
    expect(saved.ok()).toBe(true)
    const preview = page.locator("#td-desc-preview")
    const descriptionLink = preview.getByRole("link", { name: target.ticket_key })
    await expect(preview.getByRole("heading", { name: "Friday plan" })).toBeVisible()
    await expect(descriptionLink).toHaveAttribute("href", root + "/tickets/" + target.id)

    const composer = page.getByRole("textbox", { name: "Comment", exact: true })
    await composer.fill("Confirm #" + target.ticket_key)
    await option.tap()
    await expect(composer).toBeFocused()
    await expect(composer).toHaveValue("Confirm " + storedLink)
    await page.getByRole("button", { name: "Post Comment", exact: true }).click()
    const comment = page.locator("#td-comments article").first()
    await expect(comment.getByRole("link", { name: target.ticket_key })).toHaveAttribute("href", root + "/tickets/" + target.id)

    await comment.getByRole("button", { name: "Edit comment" }).click()
    const commentEditor = comment.getByRole("textbox", { name: "Edit comment" })
    await expect(commentEditor).toHaveValue("Confirm " + storedLink)
    await commentEditor.fill("#")
    await expect(list.getByRole("option")).toHaveCount(3)
    await expect(page.locator("#td-task-reference-picker")).toBeInViewport({ ratio: 0.95 })
    await expect(commentEditor).toBeFocused()
    const audit = await new AxeBuilder({ page }).include("#td-task-reference-picker").include("[data-comment-editor]").analyze()
    expect(audit.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) }))).toEqual([])
    const hostile = "[MTH-99](javascript:alert) [MTH-98](//example.invalid/tasks?open=x)"
    await commentEditor.fill("Revisit #orchard")
    await list.getByRole("option", { name: /Independent orchard fixture/ }).tap()
    await commentEditor.pressSequentially(" " + hostile)
    await comment.getByRole("button", { name: "Save comment" }).click()
    await expect(comment.getByRole("link", { name: other.ticket_key })).toHaveAttribute("href", root + "/tickets/" + other.id)
    await expect(comment).toContainText(hostile)
    await expect(comment.getByRole("link", { name: /MTH-9[89]/ })).toHaveCount(0)

    expect(await page.evaluate(async () => {
      const cachesWithRequests = await Promise.all((await caches.keys()).map(async key => (await caches.open(key)).keys()))
      return cachesWithRequests.flat().some(request => new URL(request.url).pathname.endsWith("/api/search"))
    })).toBe(false)
    await page.context().setOffline(true)
    await composer.fill("Offline #orchard")
    await expect(page.locator("#td-task-reference-picker").getByRole("status")).toHaveText("Could not find tasks. Edit your search to try again.")
    await expect(list).toBeHidden()
    await composer.press("Escape")
    await expect(composer).toHaveValue("Offline #orchard")
    await expect(page.getByRole("dialog", { name: "Task detail: Reference source" })).toBeVisible()
    await page.context().setOffline(false)

    const renamed = await pinRequest(page, prefix + "/api/tasks/" + target.id, "PUT", { title: "Renamed reference target" })
    expect(renamed.status).toBe(200)
    await page.reload()
    await expect(descriptionLink).toHaveAttribute("href", root + "/tickets/" + target.id)
    await expect(comment.getByRole("link", { name: other.ticket_key })).toHaveAttribute("href", root + "/tickets/" + other.id)
    await descriptionLink.click()
    await expect(page).toHaveURL(root + "/tickets/" + target.id)
    await expect(page.locator("#td-title")).toHaveValue("Renamed reference target")
    expect(lookups.every(url => url.pathname === prefix + "/api/search")).toBe(true)
  })
})

test("the reference picker leaves ordinary text editable under an older service worker", async () => {
  await withIngress(async (page, root, prefix, child) => {
    const source = await seedTask(page, prefix, "Reference worker source", "Existing description")
    const ack = once(child, "message", { signal: AbortSignal.timeout(3_000) })
    child.send({ type: "fixture-worker", old: true })
    expect((await ack)[0]).toEqual({ oldWorker: true })
    await page.evaluate(async scope => {
      await navigator.serviceWorker.register(scope + "/sw.js", { scope: scope + "/" })
    }, prefix)
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated")
    let searches = 0
    page.on("request", request => {
      if (new URL(request.url()).pathname.endsWith("/api/search")) searches++
    })
    await page.goto(root + "/today?open=" + source.id)
    const composer = page.getByRole("textbox", { name: "Comment", exact: true })
    await composer.fill("A plain comment #1")
    await expect(page.locator("#td-task-reference-picker").getByRole("status")).toHaveText("Update Meitheal to find and link tasks.")
    expect(searches).toBe(0)
    const [posted] = await Promise.all([
      page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `${prefix}/api/tasks/${source.id}/comments`),
      page.getByRole("button", { name: "Post Comment", exact: true }).click(),
    ])
    expect(posted.status()).toBe(201)
    await expect(page.locator("#td-comments article")).toContainText("A plain comment #1")
    expect(searches).toBe(0)
  })
})
