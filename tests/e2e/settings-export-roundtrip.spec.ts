import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { startCoreFixture } from "../scripts/task-pins-fixture"

test("native Settings exports and historical exports restore decoded values without extra quoting", async ({ playwright }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and authenticated ingress")
  const work = await mkdtemp(join(tmpdir(), "meitheal-settings-roundtrip-"))
  const child = startCoreFixture(work, true)
  child.stdout?.resume()
  child.stderr?.resume()
  const api = await playwright.request.newContext()
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `http://127.0.0.1:${info.port}`
    const base = origin + info.configuredPath
    const headers = { origin, cookie: "feedback-fixture=admin", "content-type": "application/json" }
    const expected: Record<string, unknown> = {
      theme: "light", "ai-provider": "ha", n8n_events: ["task.completed"], n8n_mode: "webhook",
      notification_preferences: { push: false }, "ha-assist-agent": "conversation.fixture",
      "calendar-entities": null, completed_auto_hide_days: 21, feature_nfc: false,
      todo_entities: ["todo.household", "todo.shopping"], calendar_sync_mode: "import",
      calendar_sync_modes: { "calendar.family": "bidirectional" },
      grocy_sync_enabled: true, grocy_sync_interval: 300,
      custom_theme_name: '"quoted"',
    }
    const put = async (key: string, value: unknown) => {
      expect((await api.put(base + "/api/settings", { headers, data: { key, value } })).status()).toBe(200)
    }
    const verify = async (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) {
        const response = await api.get(base + "/api/settings?key=" + encodeURIComponent(key), { headers })
        expect(response.status()).toBe(200)
        expect((await response.json()).value, key).toEqual(value)
      }
    }
    const changeDestination = async () => {
      for (const [key, value] of Object.entries(expected)) {
        const changed = key === "theme" ? "auto"
          : value === null ? "previous non-null value"
          : typeof value === "boolean" ? !value
          : typeof value === "number" ? value + 1
          : Array.isArray(value) ? ["todo.different"]
          : typeof value === "object" ? { previous: true }
          : "different destination value"
        await put(key, changed)
      }
    }
    for (const [key, value] of Object.entries(expected)) await put(key, value)
    await put("ha_token", "roundtrip-fixture-secret")
    const exported = await api.get(base + "/api/export/settings.json", { headers })
    expect(exported.status()).toBe(200)
    expect(exported.headers()["cache-control"]).toBe("no-store")
    const bundle = await exported.json()
    expect(bundle).toMatchObject({ _version: 2, _settingsEncoding: "json-values", settings: expected })
    expect(bundle.settings).not.toHaveProperty("ha_token")
    expect(JSON.stringify(bundle)).not.toContain("roundtrip-fixture-secret")
    await changeDestination()
    expect((await api.post(base + "/api/import/settings", { headers, data: bundle })).status()).toBe(200)
    await verify(expected)

    const legacy = {
      _version: 2, _exportedAt: "2026-03-16T10:00:00Z",
      settings: Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, JSON.stringify(value)])),
    }
    await changeDestination()
    expect((await api.post(base + "/api/import/settings", { headers, data: legacy })).status()).toBe(200)
    await verify(expected)
    for (const literal of ["true", "null", "123", '"quoted"']) {
      const payload = { _version: 2, settings: { custom_theme_name: literal } }
      expect((await api.post(base + "/api/import/settings", { headers, data: payload })).status()).toBe(200)
      await verify({ custom_theme_name: literal })
    }
    const invalid = { _version: 2, _settingsEncoding: "future", settings: { theme: "dark" } }
    expect((await api.post(base + "/api/import/settings", { headers, data: invalid })).status()).toBe(400)
    await verify({ theme: "light" })
  } finally {
    await api.dispose()
    if (child.exitCode === null) {
      const stopped = once(child, "exit")
      child.kill("SIGTERM")
      await stopped
    }
    await rm(work, { recursive: true, force: true })
  }
})
