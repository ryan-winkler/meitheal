import { expect, test } from "@playwright/test"
import { resolveHAConfiguration } from "../../apps/web/src/domains/ha/ha-configuration"
import { calendarSyncResult } from "../../apps/web/src/domains/calendar/calendar-sync-result"

test("HA credential precedence is Supervisor, saved complete pair, then environment", () => {
  const env = { SUPERVISOR_TOKEN: "supervisor-test", HA_BASE_URL: "http://env.test", HA_TOKEN: "environment-test" }
  const saved = { ha_url: "http://saved.test/", ha_token: "saved-test" }
  expect(resolveHAConfiguration(env, saved)).toEqual({ baseUrl: "http://supervisor/core", token: "supervisor-test", source: "supervisor" })
  const standaloneEnv = { HA_BASE_URL: env.HA_BASE_URL, HA_TOKEN: env.HA_TOKEN }
  expect(resolveHAConfiguration(standaloneEnv, saved)).toEqual({ baseUrl: "http://saved.test", token: "saved-test", source: "settings" })
  expect(resolveHAConfiguration(standaloneEnv, { ha_url: "http://saved.test" })?.source).toBe("environment")
  expect(resolveHAConfiguration({})).toBeNull()
  expect(() => resolveHAConfiguration({}, { ha_url: "file:///tmp/socket", ha_token: "test" })).toThrow("HTTP(S)")
  expect(() => resolveHAConfiguration({}, { ha_url: "http://user:pass@ha.test", ha_token: "test" })).toThrow("embedded credentials")
})

test("calendar distinguishes empty success, rejection, partial success and skipped sync", () => {
  const success = { status: "fulfilled" as const, value: { created: 0, updated: 0, total: 0 } }
  expect(calendarSyncResult(["calendar.empty"], [success]).ok).toBe(true)
  const failed = { status: "rejected" as const, reason: new Error("fixture secret must not reach response") }
  const outcome = calendarSyncResult(["calendar.empty", "calendar.failed"], [success, failed])
  expect(outcome).toMatchObject({ ok: false, partial: true, total: 0 })
  expect(JSON.stringify(outcome)).not.toContain("fixture secret")
  expect(calendarSyncResult(["calendar.running"], [{ status: "fulfilled", value: { created: 0, updated: 0, total: 0, skipped: "sync already running" } }]).ok).toBe(false)
})

