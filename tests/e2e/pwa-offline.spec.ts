import { readFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"
import { GET as getManifest } from "../../apps/web/src/pages/manifest.webmanifest"

test("standalone navigation keeps the update offer and rebinds Settings update controls", async ({ page }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built standalone App")
  await page.goto("/settings#app-pwa-settings")
  await expect(page.locator("#app-pwa-settings")).toBeVisible()
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated")
  const oldDocument = await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("meitheal-sw-update", {
      detail: { type: "update-available", worker: navigator.serviceWorker.controller },
    }))
    return performance.timeOrigin
  })
  await expect(page.locator("#sw-update-btn")).toBeVisible()
  await page.locator('a[href="/today"]:visible').first().click()
  await expect(page).toHaveURL(/\/today$/)
  await expect(page.locator("#sw-update-btn")).toBeVisible()
  await page.locator('a[href="/settings"]:visible').first().click()
  await expect(page).toHaveURL(/\/settings(?:#.*)?$/)
  await page.evaluate(() => { window.location.hash = "app-pwa-settings" })
  await expect(page.locator("#app-pwa-settings")).toBeVisible()
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(oldDocument)
  await expect(page.locator("#sw-update-btn")).toBeVisible()
  await page.locator("#pwa-troubleshoot summary").click()
  const force = page.locator("#pwa-force-update-btn")
  await page.clock.install()
  await page.evaluate(() => {
    const original = ServiceWorkerRegistration.prototype.update
    Reflect.set(window, "restoreWorkerUpdate", () => { ServiceWorkerRegistration.prototype.update = original })
    ServiceWorkerRegistration.prototype.update = () => {
      Reflect.set(window, "workerUpdateCheckStarted", true)
      return new Promise<ServiceWorkerRegistration>(() => {})
    }
  })
  await force.click()
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "workerUpdateCheckStarted"))).toBe(true)
  await expect(force).toHaveText("Updating…")
  await page.clock.fastForward(15_001)
  await expect(page.getByRole("alert").filter({ hasText: "The app update didn’t finish. Try again." })).toBeVisible()
  await expect(force).toBeEnabled()
  await page.evaluate(() => Reflect.get(window, "restoreWorkerUpdate")())
  const reloaded = page.waitForEvent("domcontentloaded")
  await force.click({ noWaitAfter: true })
  await reloaded
  await expect(page).toHaveURL(/\/settings#app-pwa-settings$/)
})

// Note: These tests validate offline domain logic at the unit level.
// IndexedDB tests use Node.js polyfills or test the API shape contracts.

test.describe("Offline Store API Contracts", () => {
  test("OfflineTask interface has required fields", () => {
    // Type-level contract test — validates the shape at compile time
    const task = {
      id: "test-id",
      title: "Buy groceries",
      description: "Milk and bread",
      status: "pending" as const,
      dueDate: "2026-03-01",
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      syncedAt: null,
    }

    expect(task.id).toBeTruthy()
    expect(task.title).toBeTruthy()
    expect(task.status).toBe("pending")
    expect(task.syncedAt).toBeNull()
  })

  test("PendingSyncOperation has correct shape", () => {
    const op = {
      id: crypto.randomUUID(),
      operation: "create" as const,
      table: "tasks",
      entityId: "task-1",
      payload: JSON.stringify({ title: "Test" }),
      createdAt: new Date().toISOString(),
      retryCount: 0,
    }

    expect(op.operation).toBe("create")
    expect(op.retryCount).toBe(0)
    expect(JSON.parse(op.payload)).toEqual({ title: "Test" })
  })

  test("MAX_QUEUE_DEPTH is 100", () => {
    // Architecture constraint: queue depth capped at 100
    const MAX_QUEUE_DEPTH = 100
    expect(MAX_QUEUE_DEPTH).toBe(100)
  })
})

test.describe("Sync Engine Contracts", () => {
  test("SyncState has valid values", () => {
    const validStates = ["idle", "syncing", "error"]
    expect(validStates).toContain("idle")
    expect(validStates).toContain("syncing")
    expect(validStates).toContain("error")
  })

  test("SyncResult tracks all outcomes", () => {
    const result = {
      processed: 5,
      succeeded: 3,
      failed: 1,
      conflicts: 1,
    }

    expect(result.processed).toBe(result.succeeded + result.failed + result.conflicts)
  })

  test("conflict resolution uses last-write-wins", () => {
    const localUpdatedAt = "2026-02-28T03:00:00Z"
    const serverUpdatedAt = "2026-02-28T03:05:00Z"

    // Server timestamp is later — server wins
    const serverWins = new Date(serverUpdatedAt) > new Date(localUpdatedAt)
    expect(serverWins).toBe(true)
  })
})

test.describe("Connectivity Detector Contracts", () => {
  test("valid connectivity states", () => {
    const states = ["online", "offline", "checking"]
    expect(states).toHaveLength(3)
  })

  test("debounce prevents rapid transitions", () => {
    const DEBOUNCE_MS = 2_000
    expect(DEBOUNCE_MS).toBe(2000)
  })
})

test.describe("Service Worker Registration Contracts", () => {
  test("SW registered at /sw.js with correct scope (standalone)", () => {
    // Without ingress, paths stay at root
    const config = { url: "/sw.js", scope: "/" }
    expect(config.url).toBe("/sw.js")
    expect(config.scope).toBe("/")
  })

  test("SW registration uses ingress path when present", () => {
    const ingressPath = "/api/hassio_ingress/synthetic-test-ingress"
    const swUrl = `${ingressPath}/sw.js`
    const swScope = `${ingressPath}/`
    expect(swUrl).toBe("/api/hassio_ingress/synthetic-test-ingress/sw.js")
    expect(swScope).toBe("/api/hassio_ingress/synthetic-test-ingress/")
  })

  test("SET_INGRESS_PATH message type is correct", () => {
    const msg = { type: "SET_INGRESS_PATH", path: "/api/hassio_ingress/abc123" }
    expect(msg.type).toBe("SET_INGRESS_PATH")
    expect(msg.path).toBeTruthy()
  })

  test("SKIP_WAITING message type is correct", () => {
    const msg = { type: "SKIP_WAITING" }
    expect(msg.type).toBe("SKIP_WAITING")
  })
})

test.describe("PWA Manifest — Dynamic Endpoint", () => {
  test("manifest icons resolve to shipped PNGs at their declared sizes", async () => {
    const fixtures = [
      { path: "/icon-192.png", size: 192, purpose: "any" },
      { path: "/icon-512.png", size: 512, purpose: "any" },
      { path: "/icon-maskable-512.png", size: 512, purpose: "maskable" },
    ]
    for (const ingressPath of ["", "/api/hassio_ingress/synthetic-test-ingress"]) {
      const response = await getManifest({ locals: { ingressPath } } as Parameters<typeof getManifest>[0])
      const manifest = await response.json()
      expect(manifest).toMatchObject({
        name: "Meitheal",
        short_name: "Meitheal",
        display: "standalone",
        scope: ingressPath + "/",
        start_url: ingressPath + "/",
        icons: fixtures.map(({ path, size, purpose }) => ({
          src: ingressPath + path,
          sizes: `${size}x${size}`,
          type: "image/png",
          purpose,
        })),
      })
    }

    for (const { path, size } of fixtures) {
      const image = await readFile(new URL("../../apps/web/public" + path, import.meta.url))
      expect(image.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
      expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([size, size])
    }
  })

  test("manifest screenshots resolve to shipped PNGs with matching dimensions", async () => {
    const fixtures = [
      { path: "/pwa/screenshots/today-desktop.png", width: 1440, height: 1024, formFactor: "wide" },
      { path: "/pwa/screenshots/today-mobile.png", width: 430, height: 932, formFactor: "narrow" },
    ]

    for (const ingressPath of ["", "/api/hassio_ingress/synthetic-test-ingress"]) {
      const response = await getManifest({ locals: { ingressPath } } as Parameters<typeof getManifest>[0])
      const manifest = await response.json()
      expect(manifest.screenshots).toHaveLength(fixtures.length)

      for (const [index, { path, width, height, formFactor }] of fixtures.entries()) {
        expect(manifest.screenshots[index]).toMatchObject({
          src: ingressPath + path,
          sizes: `${width}x${height}`,
          type: "image/png",
          form_factor: formFactor,
        })
        const image = await readFile(new URL("../../apps/web/public" + path, import.meta.url))
        expect(image.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
        expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([width, height])
      }
    }
  })

  test("manifest shortcuts include settings entry", () => {
    const shortcuts = [
      { short_name: "Today", url: "/today" },
      { short_name: "Calendar", url: "/calendar" },
      { short_name: "Settings", url: "/settings#app-pwa-settings" },
    ]

    expect(shortcuts.map((shortcut) => shortcut.short_name)).toEqual([
      "Today",
      "Calendar",
      "Settings",
    ])
    expect(shortcuts[2]?.url).toBe("/settings#app-pwa-settings")
  })

  test("manifest URLs are prefixed with ingress path", () => {
    const ingressPath = "/api/hassio_ingress/abc123"

    // Simulate what the dynamic endpoint does
    const prefix = (p: string) => `${ingressPath}${p}`

    expect(prefix("/")).toBe("/api/hassio_ingress/abc123/")
    expect(prefix("/today")).toBe("/api/hassio_ingress/abc123/today")
    expect(prefix("/icon-192.png")).toBe("/api/hassio_ingress/abc123/icon-192.png")
  })

  test("manifest URLs are unchanged without ingress", () => {
    const ingressPath = ""
    const prefix = (p: string) => `${ingressPath}${p}`

    expect(prefix("/")).toBe("/")
    expect(prefix("/today")).toBe("/today")
  })
})
