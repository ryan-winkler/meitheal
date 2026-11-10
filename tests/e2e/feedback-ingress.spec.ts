import { execFileSync, fork, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
const fixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))
const browserMutation = { "x-meitheal-feedback": "1" }

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Run with MEITHEAL_TEST_BROWSER=1 and a built web app")

let work: string
let server: ChildProcess | undefined
let origin: string
let prefix: string

async function startServer(): Promise<void> {
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    MEITHEAL_DB_URL: `file:${path.join(work, "meitheal.db")}`,
  }
  execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: web, env })
  server = fork(fixture, { cwd: web, env, stdio: ["ignore", "ignore", "inherit", "ipc"] })
  const child = server
  const [info] = await Promise.race([
    once(child, "message", { signal: AbortSignal.timeout(10_000) }),
    once(child, "exit").then(([code]) => { throw new Error(`Feedback fixture exited with ${code}`) }),
  ])
  origin = `http://127.0.0.1:${info.port}`
  prefix = info.configuredPath
}

async function stopServer(): Promise<void> {
  if (!server || server.exitCode !== null || server.signalCode !== null) return
  const exited = once(server, "exit")
  server.kill()
  await exited
}

test.beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "meitheal-feedback-ingress-"))
  await startServer()
})

test.afterEach(async () => {
  await stopServer()
  await rm(work, { recursive: true, force: true })
})

test("ingress loads board dependencies from the app path", async ({ page, context }) => {
  await context.setExtraHTTPHeaders({})
  await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])

  const escapedAssets: string[] = []
  await page.route(url => url.origin === origin && url.pathname.startsWith("/_astro/"), route => {
    escapedAssets.push(new URL(route.request().url()).pathname)
    return route.fulfill({ status: 404 })
  })
  const [controller] = await Promise.all([
    page.waitForResponse(response => response.url().startsWith(origin + prefix + "/_astro/kanban-page-controller.")),
    page.goto(origin + prefix + "/tasks"),
  ])
  expect(controller.ok()).toBe(true)
  await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
  expect(escapedAssets).toEqual([])
})

test("ingress Settings keeps readable palettes and resolves Auto from the panel or system", async ({ page, context }) => {
  await context.setExtraHTTPHeaders({})
  await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
  const settings = origin + prefix + "/settings"
  const panel = origin + "/theme-panel-fixture"
  await page.route(panel, route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html lang="en"><title>Home Assistant theme fixture</title>
      <style>:root {
        --primary-color: #0288d1;
        --primary-background-color: #fafafa;
        --secondary-background-color: #e5e5e5;
        --primary-text-color: #212121;
      } iframe { width: 100%; height: 900px; border: 0 }</style>
      <iframe src="${settings}" title="Meitheal"></iframe></html>`,
  }))

  for (const location of [settings, panel]) {
    await page.goto(location)
    const content = location === panel ? page.frameLocator("iframe") : page
    const root = content.locator("html")
    const body = content.locator("body")
    await expect(content.locator("#settings-shell")).toHaveAttribute("data-settings-booted", "true")
    await expect(content.locator("#local-feedback [data-feedback-form] fieldset")).toBeEnabled()
    if (location === panel) await expect(root).toHaveAttribute("data-ha-theme", "light")
    await body.evaluate(() => document.fonts.ready)

    const themeSelect = content.locator("#theme-select")
    for (const theme of ["light", "dark", "auto"]) {
      const [saved] = await Promise.all([
        page.waitForResponse(response => response.url() === origin + prefix + "/api/settings"
          && response.request().method() === "PUT"
          && response.request().postDataJSON()?.key === "theme"),
        themeSelect.selectOption(theme),
      ])
      expect(saved.ok()).toBe(true)
      await expect(root).toHaveAttribute("data-theme", theme)
      const toast = content.locator(".toast.success")
      await expect(toast).toBeVisible()
      await expect(toast).toHaveCSS("opacity", "1")
      const toastContrast = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze()
      expect(toastContrast.violations.flatMap(violation =>
        violation.nodes.filter(node => node.target.join(" ").includes(".toast")).map(node => node.target),
      )).toEqual([])
      await page.reload()
      await expect(content.locator("#settings-shell")).toHaveAttribute("data-settings-booted", "true")
      await expect(content.locator("#local-feedback [data-feedback-form] fieldset")).toBeEnabled()
      await expect(root).toHaveAttribute("data-theme", theme)
      await body.evaluate(() => document.fonts.ready)
      const light = theme === "light" || (theme === "auto" && location === panel)
      await expect.poll(() => body.evaluate(element =>
        getComputedStyle(element).getPropertyValue("--bg-secondary").trim().toLowerCase(),
      )).toBe(light ? "#f1f5f9" : "#1e293b")

      const { violations } = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze()
      expect(violations.flatMap(violation => violation.nodes.map(node => node.target))).toEqual([])
    }

    if (location === panel) {
      await page.evaluate(() => { document.documentElement.style.colorScheme = "dark" })
      await root.evaluate(() => new Promise<void>(resolve => {
        function observe(event: MessageEvent): void {
          if (event.source !== window || event.data?.probe !== "untrusted-theme-event") return
          window.removeEventListener("message", observe)
          resolve()
        }
        window.addEventListener("message", observe)
        window.postMessage({ type: "theme-changed", probe: "untrusted-theme-event" }, window.location.origin)
      }))
      await expect(root).toHaveAttribute("data-ha-theme", "light")

      await page.evaluate(() => {
        document.querySelector("iframe")?.contentWindow?.postMessage({ type: "theme-changed" }, window.location.origin)
      })
      await expect(root).toHaveAttribute("data-ha-theme", "dark")
      await expect(root).toHaveAttribute("data-theme", "auto")
      expect(await body.evaluate(element =>
        getComputedStyle(element).getPropertyValue("--bg-secondary").trim().toLowerCase(),
      )).toBe("#1e293b")
    }
  }
})

test("verified members receive durable receipts and queue APIs fail closed", async ({ playwright }) => {
  const api = await playwright.request.newContext()
  const at = (route: string) => origin + prefix + route
  const member = { cookie: "feedback-fixture=member" }
  const admin = { cookie: "feedback-fixture=admin" }
  const fake = { "x-ingress-path": prefix, "x-remote-user-id": "fake", "x-remote-user-groups": "system-admin" }
  const body = { submissionId: randomUUID(), category: "problem", message: "Synthetic private report" }
  const post = (data: object, headers: Record<string, string> = member) => api.post(at("/api/feedback"), {
    data, headers: { ...browserMutation, ...headers },
  })
  try {
    const anonymous = await api.get(at("/api/feedback"), { headers: fake })
    const sibling = await api.get(origin + "/api/feedback", { headers: fake })
    const old = await api.get(at("/api/feedback"), { headers: { cookie: "feedback-fixture=old" } })
    expect([anonymous.status(), sibling.status(), old.status()]).toEqual([403, 403, 403])
    expect((await post(body, fake)).status()).toBe(403)
    expect((await api.post(at("/api/feedback"), { headers: member, data: body })).status()).toBe(403)
    expect((await post(body, { ...member, "sec-fetch-site": "same-site" })).status()).toBe(403)
    expect((await post({ ...body, screenshot: "not accepted" })).status()).toBe(400)
    expect((await post({ ...body, message: "€".repeat(1400) })).status()).toBe(400)

    const mediaType = await api.post(at("/api/feedback"), { headers: { ...member, ...browserMutation }, data: "text" })
    expect(mediaType.status()).toBe(415)
    const malformed = await api.post(at("/api/feedback"), {
      headers: { ...member, ...browserMutation, "content-type": "application/json" }, data: "{",
    })
    expect(malformed.status()).toBe(400)
    const declared = await post({ ...body, message: "x".repeat(8192) })
    expect(declared.status()).toBe(413)
    const streamed = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(at("/api/feedback"), {
        method: "POST",
        headers: { ...member, ...browserMutation, "content-type": "application/json" },
      }, response => {
        response.resume()
        resolve(response.statusCode)
      })
      request.on("error", reject)
      request.write("x".repeat(4096))
      request.end("x".repeat(4097))
    })
    expect(streamed).toBe(413)

    const [first, second] = await Promise.all([post(body), post(body)])
    expect(first.status()).toBe(201)
    expect(second.status()).toBe(201)
    expect(first.headers()["cache-control"]).toBe("no-store")
    const receipt = await first.json()
    expect(Object.keys(receipt).sort()).toEqual(["id", "receivedAt"])
    expect(await second.json()).toEqual(receipt)
    expect((await post({ ...body, message: "Changed content" })).status()).toBe(409)

    const reportPath = `/api/feedback/${receipt.id}`
    const memberReads = await Promise.all([
      api.get(at("/api/feedback"), { headers: member }),
      api.patch(at(reportPath), { headers: { ...member, ...browserMutation }, data: { state: "in_progress" } }),
      api.post(at(reportPath + "/export"), { headers: { ...member, ...browserMutation }, data: { reviewedMessage: "test" } }),
      api.delete(at(reportPath), { headers: { ...member, ...browserMutation } }),
      api.get(at("/api/export/database.sqlite"), { headers: member }),
      api.get(origin + "/api/export/database.sqlite", { headers: fake }),
    ])
    expect(memberReads.map(response => response.status())).toEqual([403, 403, 403, 403, 403, 403])

    await stopServer()
    await startServer()
    const persisted = await post(body)
    expect(await persisted.json()).toEqual(receipt)
    const list = await api.get(at("/api/feedback?state=open"), { headers: admin })
    expect(list.headers()["cache-control"]).toBe("no-store")
    expect((await list.json()).reports).toMatchObject([{ id: receipt.id, message: body.message, state: "open" }])

    const enrollment = await api.post(at("/api/agent-tokens"), {
      headers: admin, data: { name: "Feedback fixture", scopes: ["mcp:execute", "tasks:write"] },
    })
    expect(enrollment.status()).toBe(201)
    const { token } = await enrollment.json()
    const agent = { authorization: `Bearer ${token}` }
    expect((await api.get(at("/api/feedback"), { headers: { ...admin, ...agent } })).status()).toBe(403)
    expect((await api.get(at("/api/export/database.sqlite"), { headers: { ...admin, ...agent } })).status()).toBe(403)
    const tools = await api.post(at("/api/mcp"), {
      headers: agent, data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    })
    expect(tools.ok()).toBeTruthy()
    const catalog = (await tools.json()).result.tools as { name: string }[]
    expect(catalog.some(tool => tool.name === "createTask")).toBe(true)
    expect(catalog.some(tool => /localfeedback|exportdatabase/i.test(tool.name))).toBe(false)
    for (const route of ["/api/export/settings.json", "/api/search?q=Synthetic%20private%20report"]) {
      const response = await api.get(at(route), { headers: admin })
      expect(response.status()).toBe(200)
      expect(await response.text()).not.toContain(receipt.id)
    }

    const backup = await api.get(at("/api/export/database.sqlite"), { headers: admin })
    expect(backup.status()).toBe(200)
    expect(backup.headers()["cache-control"]).toBe("no-store")
    expect((await backup.body()).subarray(0, 16).toString()).toBe("SQLite format 3\0")
  } finally {
    await api.dispose()
  }
})

test("Settings saves and retries feedback, then reviews, downloads and deletes it", async ({ browser }) => {
  const member = await browser.newContext({ extraHTTPHeaders: {} })
  const admin = await browser.newContext({ extraHTTPHeaders: {}, viewport: { width: 390, height: 844 }, acceptDownloads: true })
  const settings = origin + prefix + "/settings#local-feedback"
  const message = 'Synthetic <img src=x onerror="window.feedbackExecuted=true"> report'
  try {
    await member.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const userPage = await member.newPage()
    const submissionIds: string[] = []
    await userPage.route("**/api/feedback", async route => {
      const request = route.request()
      if (request.method() !== "POST") return route.continue()
      submissionIds.push(request.postDataJSON().submissionId)
      if (submissionIds.length > 1) return route.continue()
      const saved = await route.fetch()
      expect(saved.status()).toBe(201)
      await route.abort()
    })
    await userPage.goto(settings)
    await expect(userPage.getByText("Local feedback queue")).toHaveCount(0)
    await expect(userPage.locator("#export-db-btn")).toHaveCount(0)
    await userPage.getByLabel("Category", { exact: true }).selectOption("problem")
    await userPage.getByLabel("Message", { exact: true }).fill(message)
    await userPage.getByRole("button", { name: "Save feedback" }).click()
    await expect(userPage.locator("[data-feedback-status]")).toContainText("Could not reach")
    await expect(userPage.getByLabel("Message", { exact: true })).toHaveValue(message)
    await userPage.getByRole("button", { name: "Save feedback" }).click()
    await expect(userPage.locator("[data-feedback-status]")).toContainText("Feedback saved. Receipt")
    expect(submissionIds).toHaveLength(2)
    expect(submissionIds[0]).toBe(submissionIds[1])

    await admin.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const adminPage = await admin.newPage()
    await adminPage.goto(settings)
    await adminPage.getByText("Local feedback queue", { exact: true }).click()
    await expect(adminPage.locator("[data-queue-status]")).toHaveText("1 report shown.")
    await adminPage.getByLabel("Report state").selectOption("")
    const entry = adminPage.locator("[data-report-id]")
    await entry.getByText(/^Problem · Open/).click()
    await expect(entry.getByText(message, { exact: true })).toBeVisible()
    await expect(entry.locator("img")).toHaveCount(0)
    await entry.getByRole("button", { name: "Claim report" }).click()
    await expect(entry.getByText(/^Problem · In progress/)).toBeVisible()
    await entry.getByLabel("Disposition").fill("Synthetic fix verified")
    await entry.getByRole("button", { name: "Resolve report" }).click()
    await expect(entry.getByText(/^Problem · Resolved/)).toBeVisible()
    await entry.getByText("Prepare a reviewed export").click()
    await entry.getByLabel("Text to share").fill("Reviewed reproduction")
    await entry.getByRole("button", { name: "Preview export" }).click()
    await expect(entry.locator("[data-export-preview]")).toContainText("Reviewed reproduction")
    await expect(entry.locator("[data-export-preview]")).not.toContainText("fixture-member")
    const download = adminPage.waitForEvent("download")
    await entry.getByRole("button", { name: "Download reviewed JSON" }).click()
    expect(JSON.parse(await readFile(await (await download).path(), "utf-8"))).toEqual({
      category: "problem", message: "Reviewed reproduction", appVersion: null, routeFamily: null,
    })

    await entry.getByRole("button", { name: "Delete closed report" }).click()
    await adminPage.getByRole("alertdialog").getByRole("button", { name: "Delete report" }).click()
    await expect(entry).toHaveCount(0)
    await expect(adminPage.locator("[data-queue-status]")).toHaveText("Report deleted.")
  } finally {
    await member.close()
    await admin.close()
  }
})
