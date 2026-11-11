import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { promisify } from "node:util"
import { expect, test } from "@playwright/test"
import { createLogger, VALID_ACTOR_TYPE_SET } from "../../packages/domain-observability/src/index"

test.describe.configure({ mode: "serial" })

const keys = ["LOKI_URL", "MEITHEAL_LOG_LEVEL", "MEITHEAL_LOG_CATEGORIES", "MEITHEAL_AUDIT_ENABLED", "MEITHEAL_AUDIT_LOGS", "MEITHEAL_LOG_REDACTION"] as const
type Options = Partial<Record<typeof keys[number], string>>
const event = { event: "fixture", domain: "tasks", component: "test", request_id: "test", message: "Acknowledged change" }
const config = { service: "option-fixture", env: "test", minLevel: "info" as const, enabledCategories: [], redactPatterns: [] }

test("add-on category export supplies the logger's CSV contract without running startup", async () => {
  const script = await readFile(new URL("../../meitheal-hub/run.sh", import.meta.url), "utf8")
  const line = script.split("\n").find(value => value.startsWith("export MEITHEAL_LOG_CATEGORIES="))
  expect(line).toBeDefined()
  const { stdout } = await promisify(execFile)("bash", ["-c", `bashio::config() { jq -r ".$1" <<< "$CATEGORY_FIXTURE"; }\n${line}\nprintf '%s' "$MEITHEAL_LOG_CATEGORIES"`], {
    env: { PATH: process.env.PATH, CATEGORY_FIXTURE: JSON.stringify({ log_categories: ["auth", "tasks"] }) },
  })
  expect(stdout).toBe("auth,tasks")
  const lines = capture({ MEITHEAL_LOG_CATEGORIES: stdout }, () => {
    const logger = createLogger(config)
    logger.log("info", event)
    logger.log("info", { ...event, domain: "integrations" })
  })
  expect(lines.map(value => JSON.parse(value).domain)).toEqual(["tasks"])
})

function capture(options: Options, run: () => void): string[] {
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const write = process.stdout.write
  const lines: string[] = []
  for (const key of keys) {
    if (options[key] === undefined) delete process.env[key]
    else process.env[key] = options[key]
  }
  process.stdout.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true }) as typeof process.stdout.write
  try { run() } finally {
    process.stdout.write = write
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
  return lines
}

test("global level and audit veto retain mandatory nested redaction", () => {
  const lines = capture({ MEITHEAL_LOG_LEVEL: "error", MEITHEAL_AUDIT_ENABLED: "false", MEITHEAL_LOG_REDACTION: "false" }, () => {
    const logger = createLogger({ ...config, minLevel: "debug", auditEnabled: true })
    const sensitive = { ...event, message: "Bearer fixture-bearer password=fixture-password api_key=fixture-key token=fixture-token", metadata: { nested: { authorization: "fixture-auth" }, email: "fixture@example.test" } }
    logger.log("info", sensitive)
    logger.audit(sensitive)
    logger.log("error", sensitive)
  })
  expect(lines).toHaveLength(1)
  for (const secret of ["fixture-bearer", "fixture-password", "fixture-key", "fixture-token", "fixture-auth", "fixture@example.test"]) expect(lines.join("")).not.toContain(secret)
  expect(JSON.parse(lines[0]!).metadata.nested.authorization).toBe("[REDACTED]")
})

test("application category override preserves independent audit events", () => {
  const lines = capture({ MEITHEAL_LOG_CATEGORIES: "auth", MEITHEAL_AUDIT_ENABLED: "true" }, () => {
    const logger = createLogger({ ...config, enabledCategories: ["tasks"] })
    logger.log("info", event)
    logger.log("info", { ...event, domain: "auth" })
    logger.audit(event)
    createLogger({ ...config, auditEnabled: false }).audit(event)
  })
  expect(lines.map(line => JSON.parse(line).domain)).toEqual(["auth", "audit"])
})

test("legacy false audit option and explicit false veto both audit entry points", () => {
  for (const options of [{ MEITHEAL_AUDIT_LOGS: "false" }, { MEITHEAL_AUDIT_ENABLED: "false", MEITHEAL_AUDIT_LOGS: "true" }]) {
    const lines = capture(options, () => {
      const logger = createLogger({ ...config, auditEnabled: true })
      logger.audit(event)
      logger.log("info", { ...event, domain: "audit" })
      logger.log("info", event)
    })
    expect(lines.map(line => JSON.parse(line).domain)).toEqual(["tasks"])
  }
})

test("invalid inherited-property level falls back and actor validation stays current", () => {
  const lines = capture({ MEITHEAL_LOG_LEVEL: "toString" }, () => {
    const logger = createLogger(config)
    logger.log("debug", event)
    logger.log("info", event)
  })
  expect(lines.map(line => JSON.parse(line).level)).toEqual(["info"])
  expect(VALID_ACTOR_TYPE_SET.has("agent")).toBe(true)
})
