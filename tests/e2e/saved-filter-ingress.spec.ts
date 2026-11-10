import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

const predecessorHash = "21bed59f3a8f3bb401f7ee9fede5e2d6c3b64e6a68cdfb27fb2af225486059ff"
test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Run with MEITHEAL_TEST_BROWSER=1 and a built web app")

test("saved filters wait for the scoped worker and stay unavailable offline", async () => {
  const exactWorker = process.env.MEITHEAL_PRESETS_EXACT_WORKER === "1"
  if (exactWorker) {
    const pin = process.env.MEITHEAL_PIN_LEGACY_WORKER
    expect(pin, "Provide the exact archived predecessor worker").toBeTruthy()
    expect(createHash("sha256").update(await readFile(pin!)).digest("hex")).toBe(predecessorHash)
  }

  const work = await mkdtemp(join(tmpdir(), "meitheal-preset-ingress-"))
  const child = startCoreFixture(work)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser
  async function useOldWorker(old: boolean) {
    const ack = once(child, "message", { signal: AbortSignal.timeout(3_000) })
    child.send({ type: "fixture-worker", old })
    expect((await ack)[0]).toEqual({ oldWorker: old })
  }

  try {
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const prefix: string = fixture.configuredPath
    const endpoint = prefix + "/api/saved-filters"
    const variants = [endpoint + "?fixture=1", prefix + "/api/%2573aved-filters/", prefix + "/api//saved-filters"]
    await useOldWorker(true)
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
    await context.setExtraHTTPHeaders({})
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const page = await context.newPage()
    expect((await page.goto(origin + prefix + "/fixture"))?.status()).toBe(200)

    const untrusted = await page.request.get(origin + "/api/saved-filters")
    expect(untrusted.status()).toBe(401)
    expect(untrusted.headers()["cache-control"]).toBe("private, no-store")

    await page.evaluate(async scope => {
      await navigator.serviceWorker.register(scope + "/sw.js", { scope: scope + "/" })
    }, prefix)
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
    if (exactWorker) {
      expect(await page.evaluate(() => new Promise<boolean>(resolve => {
        const channel = new MessageChannel()
        const timer = setTimeout(() => resolve(false), 2_000)
        channel.port1.onmessage = event => {
          clearTimeout(timer)
          channel.port1.close()
          resolve(event.data === true)
        }
        navigator.serviceWorker.controller?.postMessage({ type: "MEITHEAL_SEARCH_NETWORK_ONLY" }, [channel.port2])
      }))).toBe(true)
    }
    const seeded = await page.evaluate(async ({ prefix, endpoint, variants }) => {
      const created = await fetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json" },
        mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "same-origin",
        body: JSON.stringify({ name: "Scoped fixture preset", query_json: { status: "active" } }),
      })
      if (!created.ok) throw new Error("Preset fixture could not be created")
      const { version } = await (await fetch(prefix + "/version.json")).json()
      const cache = await caches.open(`meitheal-api-v${version}`)
      for (const path of [...variants, prefix + "/unrelated-preset-fixture"]) {
        await cache.put(path, new Response("Synthetic cached entry", { headers: { date: new Date().toUTCString() } }))
      }
      return { version: String(version), id: (await created.json()).id }
    }, { prefix, endpoint, variants })

    const reads: string[] = []
    const escaped: string[] = []
    page.on("request", request => {
      const path = new URL(request.url()).pathname
      if (path.endsWith("/api/saved-filters") && request.method() === "GET") reads.push(path)
      if (/^\/(?:api|_astro)\//.test(path) && !path.startsWith(prefix + "/")) escaped.push(path)
    })
    await page.goto(origin + prefix + "/table")
    await expect(page).toHaveURL(origin + prefix + "/tasks?view=table#table")
    const toggle = page.getByRole("button", { name: "Saved filter presets" })
    const panel = page.getByRole("region", { name: "Saved Filter Presets" })
    const apply = panel.getByRole("button", { name: "Apply Scoped fixture preset" })
    await toggle.press("Enter")
    await expect(panel).toContainText("until the app updates")
    expect(reads).toEqual([])

    await useOldWorker(false)
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update() })
    await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))
    await toggle.press("Escape")
    await toggle.press("Enter")
    await expect(panel.getByRole("button", { name: "Activate update" })).toBeVisible()
    expect(reads).toEqual([])
    await panel.getByRole("button", { name: "Activate update" }).press("Enter")
    await expect(apply).toBeVisible()
    expect(reads).toEqual([endpoint])
    expect(escaped).toEqual([])

    const cached = await page.evaluate(async ({ prefix, variants, version }) => {
      const cache = await caches.open(`meitheal-api-v${version}`)
      return {
        stale: await Promise.all(variants.map(async path => Boolean(await cache.match(path)))),
        unrelated: Boolean(await cache.match(prefix + "/unrelated-preset-fixture")),
      }
    }, { prefix, variants, version: seeded.version })
    expect(cached).toEqual({ stale: [false, false, false], unrelated: true })

    await apply.press("Enter")
    await expect(page).toHaveURL(url => url.pathname === prefix + "/tasks" && url.searchParams.get("status") === "active")
    await expect(toggle).toBeFocused()
    await toggle.press("Enter")
    await expect(apply).toBeVisible()
    await panel.getByRole("button", { name: "Delete Scoped fixture preset" }).press("Enter")
    await expect(page.getByRole("alertdialog")).toBeVisible()
    await context.setOffline(true)
    await expect(page.getByRole("alertdialog")).toBeHidden()
    await expect(panel).toContainText("unavailable offline")
    await expect(apply).toHaveCount(0)
    await expect(toggle).toBeFocused()
    await context.setOffline(false)
    await expect(apply).toBeVisible()
    const after = await page.request.get(origin + endpoint)
    expect((await after.json()).filters).toContainEqual(expect.objectContaining({ id: seeded.id }))
  } finally {
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
      child.kill("SIGKILL")
      await closed
    }
    await rm(work, { recursive: true, force: true })
  }
})
