import { once } from "node:events"
import { createServer, type ServerResponse } from "node:http"
import { expect, test } from "@playwright/test"
import { createLogger } from "../../packages/domain-observability/src/logger"

test.describe.configure({ mode: "serial" })

type Push = { streams: Array<{ stream: Record<string, string>; values: string[][] }> }
async function receiver(reply: (response: ServerResponse) => void = response => { response.writeHead(204).end() }) {
  const pushes: Push[] = []
  const closed: number[] = []
  const server = createServer(async (request, response) => {
    response.on("close", () => closed.push(Date.now()))
    let body = ""
    for await (const chunk of request) body += chunk
    expect(request.url).toBe("/loki/api/v1/push")
    expect(request.headers["content-type"]).toBe("application/json")
    pushes.push(JSON.parse(body))
    reply(response)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing local fixture address")
  return {
    pushes, closed, url: `http://127.0.0.1:${address.port}/loki/api/v1/push`,
    async close() {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

async function capture(run: (stdout: string[], stderr: string[]) => Promise<void>) {
  const original = { stdout: process.stdout.write, stderr: process.stderr.write }
  const previous = { LOKI_URL: process.env.LOKI_URL, MEITHEAL_LOG_LEVEL: process.env.MEITHEAL_LOG_LEVEL }
  const stdout: string[] = []
  const stderr: string[] = []
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true }) as typeof process.stderr.write
  delete process.env.MEITHEAL_LOG_LEVEL
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
        expect(Object.keys(stream.stream).sort()).toEqual(["env", "service"])
        expect(stream.stream.env).toBe("test")
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
        const started = Date.now()
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
