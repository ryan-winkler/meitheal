import { expect, test } from "@playwright/test"
import { resolveHAConfiguration } from "../../apps/web/src/domains/ha/ha-configuration"
import { calendarSyncResult } from "../../apps/web/src/domains/calendar/calendar-sync-result"
import { goalProgress, isValidGoalProgress } from "../../packages/domain-tasks/src/goal-progress"
import { createLogger } from "../../packages/domain-observability/src/logger"

// Test only explicit local fixtures; do not use real HA credentials or production data.
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

test("goal progress validates percentages and bounds metric-derived display", () => {
  expect(goalProgress(250, 1000)).toBe(25)
  expect(goalProgress(120, 100)).toBe(100)
  expect(goalProgress(-5, 100)).toBe(0)
  expect(goalProgress(5, null)).toBe(0)
  expect(isValidGoalProgress(0)).toBe(true)
  expect(isValidGoalProgress(100)).toBe(true)
  for (const value of [NaN, Infinity, -1, 101, "50", null]) expect(isValidGoalProgress(value)).toBe(false)
})

test("add-on logging options apply globally and cannot disable secret redaction", () => {
  const previousLevel = process.env.MEITHEAL_LOG_LEVEL
  const previousAudit = process.env.MEITHEAL_AUDIT_ENABLED
  const previousRedaction = process.env.MEITHEAL_LOG_REDACTION
  const chunks: string[] = []
  const originalWrite = process.stdout.write
  try {
    process.env.MEITHEAL_LOG_LEVEL = "error"
    process.env.MEITHEAL_AUDIT_ENABLED = "false"
    process.env.MEITHEAL_LOG_REDACTION = "false"
    process.stdout.write = ((chunk: string) => { chunks.push(chunk); return true }) as typeof process.stdout.write
    const logger = createLogger({ service: "test", env: "test", minLevel: "debug", enabledCategories: [], redactPatterns: [], auditEnabled: true })
    const event = { event: "fixture", domain: "test", component: "spec", request_id: "test", message: "authorization: Bearer private-value password=private-pass secret=private-secret api_key=private-key token=private-assignment", metadata: { token: "private-token" } }
    logger.log("info", event)
    logger.audit(event)
    logger.log("error", event)
  } finally {
    process.stdout.write = originalWrite
    for (const [key, value] of Object.entries({ MEITHEAL_LOG_LEVEL: previousLevel, MEITHEAL_AUDIT_ENABLED: previousAudit, MEITHEAL_LOG_REDACTION: previousRedaction })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  expect(chunks).toHaveLength(1)
  expect(chunks[0]).not.toContain("private-value")
  expect(chunks[0]).not.toContain("private-token")
  for (const secret of ["private-pass", "private-secret", "private-key", "private-assignment"]) expect(chunks[0]).not.toContain(secret)
})


test("add-on category option filters application events without affecting stdout transport", () => {
  const previous = process.env.MEITHEAL_LOG_CATEGORIES
  const chunks: string[] = []
  const write = process.stdout.write
  try {
    process.env.MEITHEAL_LOG_CATEGORIES = "auth"
    process.stdout.write = ((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true }) as typeof process.stdout.write
    const logger = createLogger({ service: "category-fixture", env: "test", minLevel: "info", enabledCategories: ["tasks", "auth"], redactPatterns: [] })
    const event = { event: "fixture", component: "test", request_id: "test", message: "category filter" }
    logger.log("info", { ...event, domain: "tasks" })
    logger.log("info", { ...event, domain: "auth" })
  } finally {
    process.stdout.write = write
    if (previous === undefined) delete process.env.MEITHEAL_LOG_CATEGORIES
    else process.env.MEITHEAL_LOG_CATEGORIES = previous
  }
  expect(chunks).toHaveLength(1)
  expect(JSON.parse(chunks[0]!).domain).toBe("auth")
})


test("audit option remains independent of application category filtering", () => {
  const keys = ["MEITHEAL_LOG_CATEGORIES", "MEITHEAL_AUDIT_ENABLED", "MEITHEAL_LOG_LEVEL"] as const
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const chunks: string[] = []
  const write = process.stdout.write
  try {
    process.env.MEITHEAL_LOG_CATEGORIES = "auth,tasks,integrations,observability"
    process.env.MEITHEAL_LOG_LEVEL = "info"
    process.env.MEITHEAL_AUDIT_ENABLED = "true"
    process.stdout.write = ((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true }) as typeof process.stdout.write
    const event = { event: "audit-fixture", domain: "tasks", component: "test", request_id: "test", message: "acknowledged change" }
    createLogger({ service: "audit-fixture", env: "test", minLevel: "info", enabledCategories: [], redactPatterns: [] }).audit(event)
    process.env.MEITHEAL_AUDIT_ENABLED = "false"
    createLogger({ service: "audit-fixture", env: "test", minLevel: "info", enabledCategories: [], redactPatterns: [] }).audit(event)
  } finally {
    process.stdout.write = write
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
  expect(chunks).toHaveLength(1)
  expect(JSON.parse(chunks[0]!).domain).toBe("audit")
})
