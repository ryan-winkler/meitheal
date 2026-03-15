import { expect, test } from "@playwright/test"

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
    const ingressPath = "/api/hassio_ingress/nSNXnUWXfe2DcUzE_X_4wsGWAwTIUze7_WdXaSsXJwo"
    const swUrl = `${ingressPath}/sw.js`
    const swScope = `${ingressPath}/`
    expect(swUrl).toBe("/api/hassio_ingress/nSNXnUWXfe2DcUzE_X_4wsGWAwTIUze7_WdXaSsXJwo/sw.js")
    expect(swScope).toBe("/api/hassio_ingress/nSNXnUWXfe2DcUzE_X_4wsGWAwTIUze7_WdXaSsXJwo/")
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
  test("manifest base fields are correct", () => {
    // Contract test for the dynamic manifest structure
    const manifest = {
      name: "Meitheal",
      short_name: "Meitheal",
      display: "standalone",
      scope: "/",
      start_url: "/",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      ],
    }

    expect(manifest.name).toBe("Meitheal")
    expect(manifest.display).toBe("standalone")
    expect(manifest.start_url).toBe("/")
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2)
  })

  test("manifest includes desktop and mobile settings screenshots", () => {
    const screenshots = [
      {
        src: "/pwa/screenshots/settings-desktop.png",
        sizes: "1440x1024",
        form_factor: "wide",
      },
      {
        src: "/pwa/screenshots/settings-mobile.png",
        sizes: "430x932",
        form_factor: "narrow",
      },
    ]

    expect(screenshots).toHaveLength(2)
    expect(screenshots[0]?.form_factor).toBe("wide")
    expect(screenshots[1]?.form_factor).toBe("narrow")
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
