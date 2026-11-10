import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect } from "@playwright/test"
import { test } from "../scripts/settings-persistence-fixture"

test("default Astro development saves and retries the latest rule edit before ClientRouter navigation", async ({ household, page, request }) => {
  test.setTimeout(60000)
  const work = await mkdtemp(join(tmpdir(), "meitheal-settings-dev-"))
  const portProbe = createServer()
  portProbe.listen(0, "127.0.0.1")
  await once(portProbe, "listening")
  const port = (portProbe.address() as { port: number }).port
  await new Promise<void>(resolve => portProbe.close(() => resolve()))
  const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
  const child = spawn(process.execPath, [join(web, "node_modules/astro/bin/astro.mjs"), "dev", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: web, env: { PATH: process.env.PATH, NODE_ENV: "development", TZ: "Europe/Dublin", MEITHEAL_DB_URL: `file:${join(work, "dev.db")}` },
    stdio: ["ignore", "ignore", "ignore"],
  })
  const origin = `http://127.0.0.1:${port}`
  try {
    await expect.poll(async () => fetch(origin + "/api/health").then(response => response.status).catch(() => 0), { timeout: 20000 }).toBe(200)
    await request.put("/api/rules", { data: { rules: [{ name: "Task Default", ruleType: "strategic-lens", taskTypes: ["task"], lensIds: [] }] } })
    let reject = true
    await page.route("**/api/**", async route => {
      const incoming = route.request()
      const url = new URL(incoming.url())
      if (url.origin !== origin) return route.continue()
      if (reject && incoming.method() === "PUT" && url.pathname === "/api/rules") return route.fulfill({ status: 503, json: { ok: false } })
      const body = incoming.postDataBuffer()
      const response = await household.api.fetch(household.origin + household.prefix + url.pathname + url.search, {
        method: incoming.method(), ...(body ? { data: body } : {}),
        headers: { origin: household.origin, ...(incoming.headers()["content-type"] ? { "content-type": incoming.headers()["content-type"]! } : {}) },
      })
      await route.fulfill({ response })
    })
    await page.goto(origin + "/settings#rules-lenses-settings")
    const checkbox = page.locator('.rules-fw-check[data-task-type="task"][data-framework="kcs"]')
    await checkbox.locator("..").click()
    await expect(page.locator("#toast-container .toast.error")).not.toHaveCount(0)
    await expect(checkbox).toBeChecked()
    expect((await (await request.get("/api/rules")).json()).data[0].lensIds).toEqual([])
    let preparations = 0
    await page.exposeFunction("recordSettingsPreparation", () => { ++preparations })
    await page.evaluate(() => document.addEventListener("astro:before-preparation", () => Reflect.get(window, "recordSettingsPreparation")()))
    await page.evaluate(() => {
      const link = document.createElement("a")
      link.href = "/today"
      document.body.append(link)
      link.click()
    })
    await expect.poll(() => preparations).toBeGreaterThan(0)
    await page.waitForTimeout(500)
    await expect(page).toHaveURL(origin + "/settings#rules-lenses-settings")
    await expect(checkbox).toBeChecked()
    reject = false
    await page.evaluate(() => {
      document.querySelector('.rules-fw-check[data-task-type="task"][data-framework="kcs"]')!.dispatchEvent(new Event("change", { bubbles: true }))
      const link = document.createElement("a")
      link.href = "/today"
      document.body.append(link)
      link.click()
    })
    await expect(page).toHaveURL(origin + "/today")
    expect(preparations).toBeGreaterThan(0)
    expect((await (await request.get("/api/rules")).json()).data.find((item: { name: string }) => item.name === "Task Default").lensIds).toContain("kcs")
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit")
      child.kill()
      const force = setTimeout(() => child.kill("SIGKILL"), 5000)
      force.unref()
      await exited
      clearTimeout(force)
    }
    await rm(work, { recursive: true, force: true })
  }
})
