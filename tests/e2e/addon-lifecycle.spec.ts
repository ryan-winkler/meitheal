import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import http from "node:http"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const appRoot = join(repoRoot, "apps/web")
const entryPath = join(appRoot, "dist/server/entry.mjs")
const runShPath = join(repoRoot, "meitheal-hub/run.sh")

async function getFreePort(): Promise<number> {
  const server = createNetServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  if (!address || typeof address === "string") throw new Error("Missing ephemeral port")
  return address.port
}

function buildChildEnv(tmpDir: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: tmpDir,
    HOST: "127.0.0.1",
    PORT: String(port),
    NODE_ENV: "production",
    MEITHEAL_DB_URL: `file:${join(tmpDir, "meitheal.db")}`,
    MEITHEAL_BOARD_GRANT_PATH: join(tmpDir, "meitheal-board-grants.json"),
  }
  if (process.env.NODE_V8_COVERAGE) env.NODE_V8_COVERAGE = process.env.NODE_V8_COVERAGE
  return env
}

function findJsonEvent(output: string, eventName: string): Record<string, unknown> | undefined {
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim()
    if (!line.startsWith("{")) continue
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (parsed.event === eventName) return parsed
    } catch {
      // Ignore non-JSON log lines.
    }
  }
  return undefined
}

async function fetchHealth(port: number, agent: http.Agent): Promise<{ status: number; body: string }> {
  return await new Promise((resolveReq, rejectReq) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/health",
        method: "GET",
        agent,
      },
      res => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", chunk => { body += chunk })
        res.on("end", () => resolveReq({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on("error", rejectReq)
    req.end()
  })
}

async function openSseStream(port: number): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
  return await new Promise((resolveStream, rejectStream) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/sse",
        method: "GET",
        headers: { accept: "text/event-stream" },
      },
      res => {
        res.on("error", () => {})
        res.resume()
        resolveStream({ req, res })
      },
    )
    req.on("error", rejectStream)
    req.end()
  })
}

test("serve.mjs logs structured web.listen_error and exits 1 on EADDRINUSE", async () => {
  test.skip(!existsSync(entryPath), "Built Astro server entry is required")

  const tmpDir = mkdtempSync(join(tmpdir(), "meitheal-eaddrinuse-"))
  const blocker = createNetServer()
  let child: ReturnType<typeof spawn> | undefined
  try {
    blocker.listen(0, "127.0.0.1")
    await once(blocker, "listening")
    const address = blocker.address()
    if (!address || typeof address === "string") throw new Error("Missing blocker port")

    child = spawn(process.execPath, ["scripts/serve.mjs"], {
      cwd: appRoot,
      env: buildChildEnv(tmpDir, address.port),
      stdio: ["ignore", "ignore", "pipe"],
    })

    let stderr = ""
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", chunk => { stderr += chunk })

    const [exitCode, exitSignal] = await once(child, "close") as [number | null, NodeJS.Signals | null]
    expect(exitCode).toBe(1)
    expect(exitSignal).toBeNull()
    expect(stderr).not.toContain("Unhandled 'error' event")

    const event = findJsonEvent(stderr, "web.listen_error")
    expect(event).toBeDefined()
    expect(event?.level).toBe("error")
    expect(event?.code).toBe("EADDRINUSE")
    expect(event?.host).toBe("127.0.0.1")
    expect(event?.port).toBe(address.port)
    expect(typeof event?.time).toBe("string")
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL")
    }
    await new Promise<void>(resolveClose => blocker.close(() => resolveClose()))
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("serve.mjs exits with code 0 on SIGTERM with open SSE and keep-alive sockets", async () => {
  test.skip(!existsSync(entryPath), "Built Astro server entry is required")

  const tmpDir = mkdtempSync(join(tmpdir(), "meitheal-sigterm-"))
  const port = await getFreePort()
  const agent = new http.Agent({ keepAlive: true })
  let child: ReturnType<typeof spawn> | undefined
  let sseClient: { req: http.ClientRequest; res: http.IncomingMessage } | undefined
  let rebindServer: ReturnType<typeof createNetServer> | undefined
  try {
    child = spawn(process.execPath, ["scripts/serve.mjs"], {
      cwd: appRoot,
      env: buildChildEnv(tmpDir, port),
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", chunk => { stdout += chunk })
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", chunk => { stderr += chunk })

    let healthy = false
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`serve.mjs exited early with ${child.exitCode}: ${stderr}`)
      }
      try {
        const res = await fetchHealth(port, agent)
        if (res.status === 200) {
          const payload = JSON.parse(res.body) as { status?: string }
          if (payload.status === "ok") {
            healthy = true
            break
          }
        }
      } catch {
        // Wait for listener readiness.
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 150))
    }
    expect(healthy).toBe(true)

    sseClient = await openSseStream(port)
    expect(sseClient.res.statusCode).toBe(200)

    const closed = once(child, "close")
    const stopStarted = performance.now()
    child.kill("SIGTERM")
    const [exitCode, exitSignal] = await closed as [number | null, NodeJS.Signals | null]
    const elapsedMs = performance.now() - stopStarted

    expect(exitCode).toBe(0)
    expect(exitSignal).toBeNull()
    // Exit in under 2.5s to verify SSE streams close before the 3s force timer.
    expect(elapsedMs).toBeLessThan(2_500)

    const stopEvent = findJsonEvent(stdout, "web.stopping")
    expect(stopEvent).toBeDefined()
    expect(stopEvent?.signal).toBe("SIGTERM")

    rebindServer = createNetServer()
    rebindServer.listen(port, "127.0.0.1")
    await once(rebindServer, "listening")
  } finally {
    sseClient?.req.destroy()
    agent.destroy()
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL")
    }
    if (rebindServer && rebindServer.listening) {
      await new Promise<void>(resolveClose => rebindServer!.close(() => resolveClose()))
    }
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("run.sh passes bash -n and guards optional options, curl timeouts, and child supervision", () => {
  const syntax = spawnSync("bash", ["-n", runShPath], { encoding: "utf8" })
  expect(syntax.status, syntax.stderr).toBe(0)

  const content = readFileSync(runShPath, "utf8")
  expect(content).toContain("bashio::config.has_value 'loki_url'")
  expect(content).toContain("bashio::config.has_value 'license_key'")
  expect(content).not.toContain("bashio::config 'loki_url' ''")
  expect(content).not.toContain("bashio::config 'license_key' ''")
  expect(content).toContain("--connect-timeout 2 --max-time 5")
  expect(content).toContain("for _ in 1 2 3 4 5; do")
  expect(content).toContain("trap stop_child EXIT")
  expect(content).toContain("trap 'request_shutdown SIGTERM' SIGTERM")
  expect(content).toContain("start_child node scripts/migrate.mjs")
  expect(content).toContain("start_child node scripts/serve.mjs")
})
