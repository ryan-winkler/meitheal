import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { request as httpsRequest } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Browser, type Page, type Route } from "@playwright/test"
import { launchPinBrowser, pinRequest, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires built app and simulated Core roster")

async function fixture(run: (f: {
  page: Page, origin: string, prefix: string, work: string,
  core: (change: Record<string, unknown>) => Promise<void>,
  bodyStarted: () => Promise<void>,
}) => Promise<void>) {
  const work = await mkdtemp(join(tmpdir(), "meitheal-label-lifecycle-"))
  const child = startCoreFixture(work)
  const logs: string[] = []
  child.stdout?.on("data", value => logs.push(String(value)))
  child.stderr?.on("data", value => logs.push(String(value)))
  let browser: Browser | undefined
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${info.port}`
    const core = async (change: Record<string, unknown>) => {
      const updated = once(child, "message", { signal: AbortSignal.timeout(3000) })
      child.send({ type: "fixture-core", user: "admin", isOwner: false, ...change })
      await updated
    }
    await core({ groupIds: ["system-admin"] })
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {},
      viewport: { width: 320, height: 800 }, reducedMotion: "reduce", serviceWorkers: "block" })
    await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const page = await context.newPage()
    await page.goto(origin + info.configuredPath + "/settings#workflow-settings")
    await expect(page.locator("[data-label-editor]")).toHaveAttribute("data-labels-ready", "true")
    const bodyStarted = async () => {
      const [message] = await once(child, "message", { signal: AbortSignal.timeout(3000) })
      expect(message).toEqual({ participantBodyStarted: true })
    }
    await run({ page, origin, prefix: info.configuredPath, work, core, bodyStarted })
  } catch (error) {
    console.error(logs.slice(-8).join(""))
    throw error
  } finally {
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) })
      child.kill("SIGTERM")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
}

for (const refreshFails of [false, true]) {
  test(`explicit label saves and cleanup reconciliation retain dirty values and focus (${refreshFails ? "failed" : "successful"} refresh)`, async () => {
    test.slow()
    await fixture(async ({ page, origin, prefix }) => {
      const errors: string[] = []
      page.on("pageerror", error => errors.push(String(error)))
      const a = await pinRequest(page, prefix + "/api/labels", "POST", { title: 'Roof "family" repairs', hex_color: "#ffffff" })
      const b = await pinRequest(page, prefix + "/api/labels", "POST", { title: "Garden", hex_color: "#000000" })
      expect(a.status).toBe(201)
      expect(b.status).toBe(201)
      const task = await pinRequest(page, prefix + "/api/tasks", "POST", { title: "Roof task", labels: JSON.stringify([a.body.title]) })
      expect(task.status).toBe(201)
      await page.reload()
      const row = page.locator(`.label-settings-row[data-id="${a.body.id}"]`)
      const garden = page.locator(`.label-settings-row[data-id="${b.body.id}"]`)
      const title = row.locator("input[type=text]")
      const save = row.locator("button[type=submit]")
      await title.fill('Loft "family" repairs')
      await expect(row.locator("[data-badge-id]")).toHaveText(a.body.title)
      await save.click()
      await expect(row.locator(".label-row-status")).toHaveText("Saved.")
      await expect(row.locator("[data-badge-id]")).toHaveText('Loft "family" repairs')
      const stored = await (await page.request.get(origin + prefix + "/api/tasks/" + task.body.id)).json()
      expect(JSON.parse(stored.labels)).toEqual(['Loft "family" repairs'])
      await page.route("**/api/labels/" + a.body.id, route => route.fulfill({ status: 409,
        contentType: "application/json", body: JSON.stringify({ ok: false, errorCode: "conflict", detail: "Conflict" }) }))
      await title.fill("Unsaved household edit")
      await save.click()
      await expect(row.locator(".label-row-status")).toContainText("shares the old or new name")
      await expect(title).toBeEditable()
      await expect(title).toHaveValue("Unsaved household edit")
      await expect(row.locator("[data-badge-id]")).toHaveText('Loft "family" repairs')
      await page.unroute("**/api/labels/" + a.body.id)

      const cleanup = page.locator("[data-label-cleanup]")
      await cleanup.locator("[data-cleanup-review]").click()
      await expect(cleanup.getByRole("checkbox", { name: "Garden", exact: true })).toBeVisible()
      const headers = { origin, referer: page.url(), "sec-fetch-mode": "same-origin", "sec-fetch-site": "same-origin" }
      async function heldPreview(action: () => Promise<void>, focus: () => Promise<void>) {
        let captured = false
        let release!: () => void
        const hold = new Promise<void>(resolve => { release = resolve })
        const handler = async (route: Route) => {
          if (captured || route.request().postDataJSON().action !== "preview") return route.continue()
          const response = await route.fetch({ headers: { ...await route.request().allHeaders(), ...headers } })
          expect(response.status()).toBe(200)
          captured = true
          await hold
          if (refreshFails) await route.fulfill({ status: 503, contentType: "application/json",
            body: JSON.stringify({ ok: false, errorCode: "unavailable" }) })
          else await route.fulfill({ response })
        }
        await page.route("**/api/labels/cleanup", handler)
        try {
          await action()
          await expect.poll(() => captured).toBe(true)
          await focus()
          release()
          if (refreshFails) await expect(cleanup.locator("[data-cleanup-status]")).toContainText("Could not complete cleanup")
          else await expect(cleanup.getByRole("checkbox", { name: "Garden", exact: true })).toBeVisible()
        } finally {
          release()
          await page.unroute("**/api/labels/cleanup", handler)
        }
      }
      await heldPreview(async () => {
        await title.fill('Loft "family" repairs again')
        await save.click()
        await expect(row.locator(".label-row-status")).toHaveText("Saved.")
      }, async () => { await expect(save).toBeFocused() })
      await expect(save).toBeFocused()
      await cleanup.locator("[data-cleanup-review]").click()
      await expect(cleanup.getByRole("checkbox", { name: "Garden", exact: true })).toBeVisible()
      await title.fill("Another unsaved edit")

      // Removal refreshes asynchronously; a user moving focus away retains it.
      let release!: () => void
      let captured = false
      const hold = new Promise<void>(resolve => { release = resolve })
      const delayed = async (route: Route) => {
        if (captured || route.request().postDataJSON().action !== "preview") return route.continue()
        const response = await route.fetch({ headers: { ...await route.request().allHeaders(), ...headers } })
        expect(response.status()).toBe(200)
        captured = true
        await hold
        if (refreshFails) await route.fulfill({ status: 503, contentType: "application/json", body: '{"ok":false,"errorCode":"unavailable"}' })
        else await route.fulfill({ response })
      }
      await page.route("**/api/labels/cleanup", delayed)
      try {
        await cleanup.getByRole("checkbox", { name: "Garden", exact: true }).check()
        await cleanup.locator("[data-cleanup-remove]").click()
        await page.getByRole("alertdialog").getByRole("button", { name: "Remove selected labels", exact: true }).click()
        await expect.poll(() => captured).toBe(true)
        await expect(garden).toHaveCount(0)
        await title.focus()
        release()
        await expect(cleanup.locator("[data-cleanup-status]")).toHaveText(refreshFails
          ? "Could not complete cleanup. Review the current labels before trying again." : "Label removed.")
        await expect(title).toHaveValue("Another unsaved edit")
        await expect(title).toBeFocused()
      } finally {
        release()
        await page.unroute("**/api/labels/cleanup", delayed)
      }

      await row.locator("[data-delete-label]").click()
      await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(row).toBeVisible()
      await expect(row.locator("[data-delete-label]")).toBeFocused()
      await page.route("**/api/labels/" + a.body.id, route => route.fulfill({ status: 503,
        contentType: "application/json", body: '{"ok":false,"errorCode":"unavailable"}' }))
      await row.locator("[data-delete-label]").click()
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click()
      await expect(row.locator(".label-row-status")).toContainText("Could not complete this change")
      await expect(title).toHaveValue("Another unsaved edit")
      await page.unroute("**/api/labels/" + a.body.id)
      await row.locator("[data-delete-label]").click()
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click()
      await expect(row).toHaveCount(0)
      await expect(page.locator("#new-label-title")).toBeFocused()
      const deleted = await (await page.request.get(origin + prefix + "/api/tasks/" + task.body.id)).json()
      expect(JSON.parse(deleted.labels)).toEqual([])
      expect(errors).toEqual([])
    })
  })
}

test("retained admin pages and a partially streamed write cannot outlive current Core permissions", async () => {
  test.slow()
  await fixture(async ({ page, origin, prefix, work, core, bodyStarted }) => {
    const created = await pinRequest(page, prefix + "/api/labels", "POST", { title: "Roof" })
    expect(created.status).toBe(201)
    const path = prefix + "/api/labels/" + created.body.id
    const ca = await readFile(join(work, "fixture-cert.pem"))
    let finish!: () => void
    let cancel!: () => void
    const started = bodyStarted()
    const result = new Promise<{ status: number, body: string }>((resolve, reject) => {
      const request = httpsRequest(origin + path, { method: "PUT", ca,
        headers: { origin, referer: page.url(), cookie: "feedback-fixture=admin", "content-type": "application/json",
          "sec-fetch-mode": "same-origin", "sec-fetch-site": "same-origin", "x-meitheal-fixture-held-body": "1" } }, response => {
        let body = ""
        response.on("data", chunk => { body += chunk })
        response.on("end", () => resolve({ status: response.statusCode!, body }))
      })
      request.on("error", reject)
      cancel = () => request.destroy()
      request.write('{"title":')
      finish = () => request.end('"New roof"}')
    })
    void result.catch(() => {})
    try {
      await started
      await core({ groupIds: ["system-users"] })
      finish()
      expect((await result).status).toBe(403)
    } finally { cancel() }
    const denied = await pinRequest(page, path, "PUT", { title: "Still denied" })
    expect(denied).toMatchObject({ status: 403, cache: "private, no-store", body: { ok: false, errorCode: "denied" } })
    await core({ groupIds: ["system-admin"], unavailable: true })
    expect((await pinRequest(page, path, "PUT", { title: "Unavailable" })).status).toBe(503)
    await core({ unavailable: false })
    const labels = await (await page.request.get(origin + prefix + "/api/labels")).json()
    expect(labels.find((label: { id: number }) => label.id === created.body.id).title).toBe("Roof")
  })
})

for (const heldMethod of ["GET", "POST"]) {
  test(`a delayed ${heldMethod} cannot restore an observed deleted label`, async () => {
    test.slow()
    await fixture(async ({ page, prefix }) => {
      const label = await pinRequest(page, prefix + "/api/labels", "POST", { title: "Planned roof" })
      expect(label.status).toBe(201)
      if (heldMethod === "POST") await page.reload()
      let captured = false
      let release!: () => void
      const hold = new Promise<void>(resolve => { release = resolve })
      const delayed = async (route: Route) => {
        if (captured || route.request().method() !== heldMethod) return route.continue()
        const response = await route.fetch({ headers: await route.request().allHeaders() })
        expect(response.status()).toBe(heldMethod === "GET" ? 200 : 201)
        captured = true
        await hold
        await route.fulfill({ response })
      }
      await page.route("**/api/labels", delayed)
      try {
        if (heldMethod === "GET") await page.reload()
        else {
          await page.locator("#new-label-title").fill("Planned roof")
          await page.locator("#create-label-form button[type=submit]").click()
        }
        await expect.poll(() => captured).toBe(true)
        const cleanup = page.locator("[data-label-cleanup]")
        await cleanup.locator("[data-cleanup-review]").click()
        await cleanup.getByRole("checkbox", { name: "Planned roof", exact: true }).check()
        await cleanup.locator("[data-cleanup-remove]").click()
        await page.getByRole("alertdialog").getByRole("button", { name: "Remove selected labels", exact: true }).click()
        await expect(cleanup.locator("[data-cleanup-status]")).toHaveText("Label removed.")
        release()
        if (heldMethod === "GET") await expect(page.locator("[data-label-editor]")).toHaveAttribute("data-labels-ready", "true")
        else {
          await expect(page.locator("[data-label-editor-status]")).toHaveText("This label is no longer available. Reload Labels.")
          await expect(page.locator("#new-label-title")).toHaveValue("Planned roof")
        }
        await expect(page.locator(`.label-settings-row[data-id="${label.body.id}"]`)).toHaveCount(0)
      } finally {
        release()
        await page.unroute("**/api/labels", delayed)
      }
      await page.locator("#new-label-title").fill("A newly created household label")
      await page.locator("#create-label-form button[type=submit]").click()
      await expect(page.locator("[data-badge-id]")).toHaveText("A newly created household label")
    })
  })
}

for (const status of [409, 503]) {
  test(`a delayed ${status} cleanup removal retains editor focus and unsaved values`, async () => {
    test.slow()
    await fixture(async ({ page, prefix }) => {
      await pinRequest(page, prefix + "/api/labels", "POST", { title: "Keep editing" })
      await pinRequest(page, prefix + "/api/labels", "POST", { title: "Unused garden" })
      await page.reload()
      const editor = page.locator(".label-settings-row").filter({ has: page.getByText("Keep editing", { exact: true }) })
      const title = editor.locator("input[type=text]")
      await title.fill("Unsaved repairs")
      const cleanup = page.locator("[data-label-cleanup]")
      await cleanup.locator("[data-cleanup-review]").click()
      await cleanup.getByRole("checkbox", { name: "Unused garden", exact: true }).check()
      let captured = false
      let release!: () => void
      const hold = new Promise<void>(resolve => { release = resolve })
      const delayed = async (route: Route) => {
        if (route.request().postDataJSON().action !== "remove") return route.continue()
        captured = true
        await hold
        await route.fulfill({ status, contentType: "application/json",
          body: JSON.stringify({ ok: false, errorCode: status === 409 ? "stale" : "unavailable" }) })
      }
      await page.route("**/api/labels/cleanup", delayed)
      try {
        await cleanup.locator("[data-cleanup-remove]").click()
        await page.getByRole("alertdialog").getByRole("button", { name: "Remove selected labels", exact: true }).click()
        await expect.poll(() => captured).toBe(true)
        await expect(page.getByRole("alertdialog")).toHaveCount(0)
        await title.focus()
        release()
        await expect(cleanup.getByRole("checkbox")).toHaveCount(0)
        await expect(title).toBeFocused()
        await expect(title).toHaveValue("Unsaved repairs")
        await expect(page.locator("[data-badge-id]").filter({ hasText: "Unused garden" })).toBeVisible()
      } finally {
        release()
        await page.unroute("**/api/labels/cleanup", delayed)
      }
    })
  })
}

test("label editor handles long multilingual names and white/black colours in narrow, enlarged and Irish layouts", async () => {
  test.slow()
  await fixture(async ({ page, origin, prefix, work }) => {
    const db = new DatabaseSync(join(work, "pins.db"), { timeout: 5000 })
    const names = ['Roof <img src=x onerror="window.labelInjected=1"> & attic', "Cothabháil an tí agus sábháilteacht an teaghlaigh · حديقة المنزل", "家のメンテナンスと防災準備 🏡", "X"]
    try {
      const insert = db.prepare("INSERT INTO vikunja_labels (title,hex_color) VALUES (?,?)")
      for (const [index, name] of names.entries()) insert.run(name, index % 2 ? "#000000" : "#ffffff")
    } finally { db.close() }
    await page.reload()
    await expect(page.locator(".label-settings-row")).toHaveCount(names.length)
    for (const name of names) await expect(page.locator("[data-label-editor]").getByText(name, { exact: true })).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { labelInjected?: number }).labelInjected)).toBeUndefined()
    expect(await page.locator("[data-label-editor] img").count()).toBe(0)
    const violations = await new AxeBuilder({ page }).include("[data-label-editor]").analyze()
    expect(violations.violations).toEqual([])
    for (const [width, scale, direction, theme] of [[320, 1, "ltr", "light"], [736, 2, "rtl", "dark"]] as const) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate(({ scale, direction, theme }) => {
        document.documentElement.style.fontSize = `${16 * scale}px`
        document.documentElement.dir = direction
        document.documentElement.setAttribute("data-theme", theme)
      }, { scale, direction, theme })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    }
    await page.context().addCookies([{ name: "meitheal-locale", value: "ga", url: origin }])
    await page.reload()
    await expect(page.locator("html")).toHaveAttribute("lang", "ga")
    const copy = await page.locator("[data-label-editor]").getAttribute("data-copy")
    expect(JSON.parse(copy!).save).toBe("Sábháil")
    await expect(page.locator(".label-settings-row button[type=submit]").first()).toHaveText("Sábháil")
  })
})
