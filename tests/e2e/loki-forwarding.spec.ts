import { once } from "node:events"
import { createServer, type ServerResponse } from "node:http"
import { expect, test } from "@playwright/test"
import { computeLokiBackoffMs, createLogger } from "../../packages/domain-observability/src/index"

test.describe.configure({ mode: "serial" })

type Push = { streams: Array<{ stream: Record<string, string>; values: string[][] }> }
async function receiver(reply: (response: ServerResponse) => void = response => { response.writeHead(204).end() }) {
  const pushes: Push[] = []
  const receivedAt: number[] = []
  const closed: number[] = []
  const server = createServer(async (request, response) => {
    response.on("close", () => closed.push(performance.now()))
    let body = ""
    for await (const chunk of request) body += chunk
    expect(request.url).toBe("/loki/api/v1/push")
    expect(request.headers["content-type"]).toBe("application/json")
    receivedAt.push(performance.now())
    pushes.push(JSON.parse(body))
    reply(response)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing local fixture address")
  return {
    pushes, receivedAt, closed, url: `http://127.0.0.1:${address.port}/loki/api/v1/push`,
    async close() {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

async function capture(run: (stdout: string[], stderr: string[]) => Promise<void>) {
  const original = { stdout: process.stdout.write, stderr: process.stderr.write }
  const keys = ["LOKI_URL", "MEITHEAL_LOG_LEVEL", "MEITHEAL_LOG_CATEGORIES", "MEITHEAL_AUDIT_ENABLED", "MEITHEAL_AUDIT_LOGS"] as const
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const stdout: string[] = []
  const stderr: string[] = []
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true }) as typeof process.stderr.write
  for (const key of keys) delete process.env[key]
  try { await run(stdout, stderr) } finally {
    process.stdout.write = original.stdout
    process.stderr.write = original.stderr
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function logger(service = "loki-fixture") {
  return createLogger({ service, env: "test", minLevel: "info", enabledCategories: [], redactPatterns: [] })
}
const event = { event: "loki.fixture", domain: "test", component: "fixture", request_id: "private-request-id", message: "Fixture log" }

test("native Loki push receives exactly the redacted stdout lines with static labels", async () => {
  const local = await receiver()
  try {
    await capture(async stdout => {
      process.env.LOKI_URL = local.url
      logger().log("info", { ...event, task_id: "private-task-id", message: "Bearer fixture-bearer-secret", metadata: { password: "fixture-password-secret", nested: { api_key: "fixture-api-secret" } } })
      logger("second-service").log("warn", { ...event, message: "Second logger shares the batch" })
      await expect.poll(() => local.pushes.length).toBe(1)
      const push = local.pushes[0]!
      expect(push.streams).toHaveLength(2)
      for (const stream of push.streams) {
        expect(Object.keys(stream.stream).sort()).toEqual(["addon", "domain", "env", "level", "service"])
        expect(stream.stream.addon).toBe("meitheal")
        expect(stream.stream.env).toBe("test")
        expect(stream.stream.domain).toBe("test")
        for (const [timestamp, line] of stream.values) {
          expect(timestamp).toMatch(/^\d{19}$/)
          expect(BigInt(timestamp!)).toBe(BigInt(Date.parse(JSON.parse(line!).ts)) * 1_000_000n)
          expect(stdout).toContain(`${line}\n`)
        }
      }
      const remote = JSON.stringify(push)
      for (const secret of ["fixture-bearer-secret", "fixture-password-secret", "fixture-api-secret"]) {
        expect(remote).not.toContain(secret)
        expect(stdout.join("")).not.toContain(secret)
      }
      expect(JSON.parse(push.streams[0]!.values[0]![1]!).metadata).toEqual({ password: "[REDACTED]", nested: { api_key: "[REDACTED]" } })
    })
  } finally { await local.close() }
})

test("unset or invalid Loki URL makes no network call and preserves stdout", async () => {
  await capture(async stdout => {
    const nativeFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = (async () => { requests++; throw new Error("Unexpected network call") }) as typeof fetch
    try {
      delete process.env.LOKI_URL
      logger().log("info", event)
      process.env.LOKI_URL = "file:///tmp/loki"
      logger().log("info", event)
      await new Promise(resolve => setTimeout(resolve, 350))
      expect(requests).toBe(0)
      expect(stdout).toHaveLength(2)
    } finally { globalThis.fetch = nativeFetch }
  })
})

test("non-2xx and timeout drop one batch without retries while stdout continues", async () => {
  for (const mode of ["reject", "timeout"]) {
    const local = await receiver(response => {
      if (mode === "reject") response.writeHead(503).end("private receiver failure")
    })
    try {
      await capture(async stdout => {
        process.env.LOKI_URL = local.url
        const started = performance.now()
        logger().log("info", event)
        await expect.poll(() => local.pushes.length).toBe(1)
        delete process.env.LOKI_URL
        logger().log("error", { ...event, message: "Stdout still works during a delivery failure" })
        await expect.poll(() => local.closed.length, { timeout: 2500 }).toBe(1)
        if (mode === "timeout") expect(local.closed[0]! - started).toBeLessThan(2200)
        await new Promise(resolve => setTimeout(resolve, 400))
        expect(local.pushes).toHaveLength(1)
        expect(stdout).toHaveLength(2)
        expect(stdout.join("")).toContain("Stdout still works")
      })
    } finally { await local.close() }
  }
})

test("a burst is bounded to 200 waiting lines and 50-line batches across loggers", async () => {
  const local = await receiver()
  try {
    await capture(async stdout => {
      process.env.LOKI_URL = local.url
      const first = logger("first-service")
      const second = logger("second-service")
      for (let index = 0; index < 300; index++) (index % 2 ? first : second).log("info", { ...event, message: `Line ${index}` })
      await expect.poll(() => local.pushes.length, { timeout: 3000 }).toBe(4)
      await new Promise(resolve => setTimeout(resolve, 350))
      const batchSizes = local.pushes.map(push => push.streams.reduce((total, stream) => total + stream.values.length, 0))
      expect(batchSizes).toEqual([50, 50, 50, 50])
      expect(stdout).toHaveLength(300)
      // Oversized telemetry remains intact on stdout without entering a batch.
      logger().log("info", { ...event, message: "x".repeat(17_000) })
      await new Promise(resolve => setTimeout(resolve, 350))
      expect(local.pushes).toHaveLength(4)
      expect(stdout).toHaveLength(301)
    })
  } finally { await local.close() }
})

test("computeLokiBackoffMs doubles from 2s to 60s and clamps invalid or large failure counts", () => {
  const inputs = [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 1, 2, 3, 4, 5, 6, 7, 2000]
  const expected = [0, 0, 0, 0, 0, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]
  expect(inputs.map(computeLokiBackoffMs)).toEqual(expected)
})

test("delivery failure applies backoff and resets on same-URL recovery, URL change, and stale timeout", async () => {
  let failFirst = true
  const flaky = await receiver(response => {
    if (failFirst) {
      failFirst = false
      response.writeHead(503).end("temporary failure")
      return
    }
    response.writeHead(204).end()
  })
  const alwaysFail = await receiver(response => { response.writeHead(503).end("receiver down") })
  const healthy = await receiver()
  const slow = await receiver(() => {})
  const healthyAfterSlow = await receiver()
  try {
    await capture(async () => {
      // 1. Same-URL failure triggers 2s backoff, then successful push resets backoff.
      process.env.LOKI_URL = flaky.url
      logger().log("info", { ...event, message: "Trigger 503 failure" })
      await expect.poll(() => flaky.closed.length, { intervals: [50], timeout: 2500 }).toBe(1)

      logger().log("info", { ...event, message: "Delayed by backoff" })
      await expect.poll(() => flaky.closed.length, { intervals: [50], timeout: 4000 }).toBe(2)
      expect(flaky.receivedAt[1]! - flaky.closed[0]!).toBeGreaterThanOrEqual(1_800)

      const afterRecovery = performance.now()
      logger().log("info", { ...event, message: "Fast after recovery" })
      await expect.poll(() => flaky.pushes.length, { intervals: [50], timeout: 1500 }).toBe(3)
      expect(performance.now() - afterRecovery).toBeLessThan(1_500)

      // 2. Changing LOKI_URL clears active backoff and pending timer on the next enqueue.
      process.env.LOKI_URL = alwaysFail.url
      logger().log("info", { ...event, message: "Trigger failure before switch" })
      await expect.poll(() => alwaysFail.closed.length, { intervals: [50], timeout: 2500 }).toBe(1)
      await new Promise(resolve => setTimeout(resolve, 25))

      // Schedule an active 2s backoff timer and queued line for the failing URL.
      logger().log("info", { ...event, message: "Queued during backoff before URL change" })

      const switchedAt = performance.now()
      process.env.LOKI_URL = healthy.url
      logger().log("info", { ...event, message: "Fast after URL switch" })
      await expect.poll(() => healthy.pushes.length, { intervals: [50], timeout: 1500 }).toBe(1)
      expect(performance.now() - switchedAt).toBeLessThan(1_500)
      expect(JSON.stringify(healthy.pushes[0])).toContain("Fast after URL switch")
      expect(JSON.stringify(healthy.pushes[0])).not.toContain("Queued during backoff")
      expect(alwaysFail.pushes).toHaveLength(1)

      // 3. Late timeout from the previous URL does not cause backoff for the new URL.
      process.env.LOKI_URL = slow.url
      logger().log("info", { ...event, message: "Trigger slow in-flight push" })
      await expect.poll(() => slow.pushes.length, { intervals: [50], timeout: 1500 }).toBe(1)

      process.env.LOKI_URL = healthyAfterSlow.url
      logger().log("info", { ...event, message: "Queued while prior push times out" })
      await expect.poll(() => slow.closed.length, { intervals: [50], timeout: 2500 }).toBe(1)
      const slowClosedAt = performance.now()
      await expect.poll(() => healthyAfterSlow.pushes.length, { intervals: [50], timeout: 1500 }).toBe(1)
      expect(performance.now() - slowClosedAt).toBeLessThan(1_500)
    })
  } finally {
    await flaky.close()
    await alwaysFail.close()
    await healthy.close()
    await slow.close()
    await healthyAfterSlow.close()
  }
})
