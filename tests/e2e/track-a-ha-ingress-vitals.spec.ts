import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, test } from "@playwright/test"
import { createLogger, defaultRedactionPatterns } from "../../packages/domain-observability/src/index"
import { rewriteIngressHtml } from "../../apps/web/src/lib/rewrite-ingress-html"
import { GET as healthGET, resetHealthSupervisorCacheForTests } from "../../apps/web/src/pages/api/health"
import { startHAWebSocketFixture, type FixtureRegistryEntry, type FixtureStateEntry } from "../scripts/ha-websocket-fixture"

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const webDir = join(repoRoot, "apps/web")

test("A1/A2: scopes 3,000-entity HA state to calendar/todo/watched IDs, decodes diffs in place, and singleflights feature checks", async () => {
  test.setTimeout(20_000)
  const directory = await mkdtemp(join(tmpdir(), "meitheal-track-a-ha-"))
  const envKeys = ["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"] as const
  const previousEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]))

  // Build 3,000 HA entities:
  // - 2,988 sensor.* and light.*
  // - 6 active registry calendar.*/todo.*
  // - 2 disabled registry calendar.*
  // - 2 unique_id-less YAML todo.* present in get_states only
  const iso0 = "2026-11-13T10:00:00.000Z"
  const registry: FixtureRegistryEntry[] = [
    { entity_id: "calendar.family", disabled_by: null },
    { entity_id: "calendar.work_old", disabled_by: null },
    { entity_id: "calendar.birthdays", disabled_by: null },
    { entity_id: "todo.shopping", disabled_by: null },
    { entity_id: "todo.chores", disabled_by: null },
    { entity_id: "todo.errands", disabled_by: null },
    { entity_id: "calendar.disabled_user", disabled_by: "user" },
    { entity_id: "calendar.disabled_integration", disabled_by: "integration" },
  ]

  const states: FixtureStateEntry[] = []
  for (let i = 0; i < 1495; i++) {
    states.push({
      entity_id: `sensor.power_${i}`,
      state: String(i),
      attributes: { unit_of_measurement: "W", raw_telemetry: "x".repeat(128) },
      last_changed: iso0,
      last_updated: iso0,
    })
    states.push({
      entity_id: `light.room_${i}`,
      state: "off",
      attributes: { brightness: 200, color_temp: 350 },
      last_changed: iso0,
      last_updated: iso0,
    })
  }
  for (const entry of registry) {
    states.push({
      entity_id: entry.entity_id,
      state: "off",
      attributes: {
        friendly_name: `Name ${entry.entity_id}`,
        supported_features: 7,
        raw_ical_blob: "BEGIN:VCALENDAR...".repeat(20),
      },
      last_changed: iso0,
      last_updated: iso0,
    })
  }
  for (const yamlId of ["todo.yaml_alpha", "todo.yaml_beta"]) {
    states.push({
      entity_id: yamlId,
      state: "2",
      attributes: { friendly_name: yamlId, supported_features: 15, extra_yaml_meta: "strip-me" },
      last_changed: iso0,
      last_updated: iso0,
    })
  }
  expect(states).toHaveLength(3000)

  const ha = await startHAWebSocketFixture({
    entityRegistry: registry,
    states,
    filterSubscribeEntities: true,
    restStates: {
      "sensor.door_contact": {
        entity_id: "sensor.door_contact",
        state: "closed",
        attributes: { device_class: "door", battery_level: 94 },
        last_changed: iso0,
        last_updated: iso0,
      },
      "calendar.uncached_cal": {
        entity_id: "calendar.uncached_cal",
        state: "off",
        attributes: { friendly_name: "Uncached", supported_features: 3 },
        last_changed: iso0,
        last_updated: iso0,
      },
    },
  })

  const store = await import("../../apps/web/src/domains/tasks/persistence/store")
  const haConn = await import("../../apps/web/src/domains/ha/ha-connection")
  const haEntities = await import("../../apps/web/src/domains/ha/ha-entities")
  const haServices = await import("../../apps/web/src/domains/ha/ha-services")

  try {
    delete process.env.SUPERVISOR_TOKEN
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "ha.db")}`
    process.env.HA_BASE_URL = ha.url
    process.env.HA_TOKEN = "track-a-token"
    store.resetPersistenceForTests()
    await store.ensureSchema()

    const conn = await haConn.getHAConnection()
    expect(conn).not.toBeNull()
    await haEntities.waitForInitialEntityHydration(5_000)

    // 1. Scoped discovery: 6 active registry + 2 YAML todo = 8 tracked & cached
    expect(ha.eventTypesSubscribed).not.toContain("state_changed")
    expect(ha.subscribeEntitiesCalls.length).toBeGreaterThanOrEqual(1)
    const initialFilter = [...(ha.subscribeEntitiesCalls[0]!.entity_ids ?? [])].sort()
    expect(initialFilter).toEqual([
      "calendar.birthdays",
      "calendar.family",
      "calendar.work_old",
      "todo.chores",
      "todo.errands",
      "todo.shopping",
      "todo.yaml_alpha",
      "todo.yaml_beta",
    ])
    const diag = haEntities.getEntityCacheDiagnostics()
    expect(diag.trackedCount).toBe(8)
    expect(diag.cachedCount).toBe(8)
    expect(diag.registrySubscribed).toBe(true)
    expect(diag.approxBytes).toBeLessThan(32_768)
    expect(haEntities.getEntity("sensor.power_0")).toBeUndefined()
    expect(haEntities.getEntity("calendar.disabled_user")).toBeUndefined()

    // Scoped attributes stripped bulky raw_ical_blob
    const familyBefore = haEntities.getEntity("calendar.family")!
    expect(familyBefore.attributes).toEqual({
      friendly_name: "Name calendar.family",
      supported_features: 7,
    })
    const birthdaysRefBefore = haEntities.getEntity("calendar.birthdays")!

    // 2. Compressed diff (`c` `+`/`-` and `r`) mutates target in place without cloning untouched entities
    ha.emitEntities("track-a-token", {
      c: {
        "calendar.family": {
          "+": { s: "on", lu: 1700000100, a: { message: "Dinner", ignored_extra: "drop" } },
          "-": { a: ["friendly_name"] },
        },
        "sensor.power_0": {
          "+": { s: "999", lu: 1700000100 },
        },
      },
      r: ["todo.errands"],
    })

    await expect.poll(() => haEntities.getEntity("calendar.family")?.state).toBe("on")
    expect(haEntities.getEntity("calendar.family")?.attributes).toEqual({
      supported_features: 7,
      message: "Dinner",
    })
    expect(haEntities.getEntity("todo.errands")).toBeUndefined()
    expect(haEntities.getEntity("sensor.power_0")).toBeUndefined()
    // Unchanged entity reference was NOT cloned
    expect(Object.is(haEntities.getEntity("calendar.birthdays"), birthdaysRefBefore)).toBe(true)

    // 3. Dynamic entity_registry_updated: rename calendar.work_old -> calendar.work_renamed
    const updatedRegistry: FixtureRegistryEntry[] = registry
      .filter(r => r.entity_id !== "calendar.work_old")
      .concat([{ entity_id: "calendar.work_renamed", disabled_by: null }])
    ha.setEntityRegistry(updatedRegistry)
    ha.setStates([
      ...states.filter(s => s.entity_id !== "calendar.work_old"),
      {
        entity_id: "calendar.work_renamed",
        state: "off",
        attributes: { friendly_name: "Renamed Work", supported_features: 7 },
        last_changed: iso0,
        last_updated: iso0,
      },
    ])
    expect(ha.emitEvent("track-a-token", "entity_registry_updated", {
      action: "update",
      entity_id: "calendar.work_renamed",
      old_entity_id: "calendar.work_old",
    })).toBe(true)

    await expect.poll(() => haEntities.getEntity("calendar.work_renamed")?.attributes?.friendly_name, { timeout: 2_000 }).toBe("Renamed Work")
    expect(haEntities.getEntity("calendar.work_old")).toBeUndefined()

    // 4. Dynamic component_loaded ("todo") discovers late YAML entity
    ha.setStates([
      ...states.filter(s => s.entity_id !== "calendar.work_old"),
      {
        entity_id: "calendar.work_renamed",
        state: "off",
        attributes: { friendly_name: "Renamed Work", supported_features: 7 },
        last_changed: iso0,
        last_updated: iso0,
      },
      {
        entity_id: "todo.late_yaml",
        state: "4",
        attributes: { friendly_name: "Late YAML Todo", supported_features: 15 },
        last_changed: iso0,
        last_updated: iso0,
      },
    ])
    expect(ha.emitEvent("track-a-token", "component_loaded", { component: "todo" })).toBe(true)
    await expect.poll(() => haEntities.getEntity("todo.late_yaml")?.state, { timeout: 2_000 }).toBe("4")

    // 5. Late onEntityChange("sensor.door_contact") hydrates full attributes via REST and cleans up on unsubscribe
    const sensorEvents: Array<{ state: string; attrs: Record<string, unknown> }> = []
    const unsubDoor = haEntities.onEntityChange("sensor.door_contact", entity => {
      sensorEvents.push({ state: entity.state, attrs: { ...entity.attributes } })
    })
    await expect.poll(() => sensorEvents.length, { timeout: 2_000 }).toBe(1)
    expect(sensorEvents[0]).toEqual({
      state: "closed",
      attrs: { device_class: "door", battery_level: 94 },
    })
    unsubDoor()
    expect(haEntities.getEntity("sensor.door_contact")).toBeUndefined()

    // 6. A2 getCalendarEntityFeatures: hits cache with zero extra get_states, singleflights REST on cold miss
    const getStatesBeforeFeatures = ha.getStatesCount
    expect(await haServices.getCalendarEntityFeatures("calendar.family")).toBe(7)
    expect(ha.getStatesCount).toBe(getStatesBeforeFeatures)

    const concurrentMisses = await Promise.all([
      haServices.getCalendarEntityFeatures("calendar.uncached_cal"),
      haServices.getCalendarEntityFeatures("calendar.uncached_cal"),
      haServices.getCalendarEntityFeatures("calendar.uncached_cal"),
      haServices.getCalendarEntityFeatures("calendar.uncached_cal"),
    ])
    expect(concurrentMisses).toEqual([3, 3, 3, 3])
    expect(ha.restStateRequests.filter(id => id === "calendar.uncached_cal")).toHaveLength(1)
    expect(ha.getStatesCount).toBe(getStatesBeforeFeatures)
  } finally {
    haEntities.stopEntitySubscription()
    haConn.closeHAConnection()
    await ha.close()
    store.resetPersistenceForTests()
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key]
      else process.env[key] = previousEnv[key]
    }
    await rm(directory, { recursive: true, force: true })
  }
})

test("A5: rewriteIngressHtml streams chunk-split UTF-8 emojis, preserves script JSON and data-* attributes, and avoids double-prefixing", async () => {
  for (const rawPrefix of ["/api/hassio_ingress/tok", "/api/hassio_ingress/tok/"]) {
    const normalized = "/api/hassio_ingress/tok"
    const html = [
      '<!DOCTYPE html><html><head data-astro-cid="abc123"><title>Clann 👨‍👩‍👧‍👦 &amp; 📋</title>',
      '<script type="application/json">{"href":"/api/tasks","src":"/keep","action":"/raw"}</script>',
      "</head><body>",
      '<a href="/tasks" data-href="/ignore">📋 Tasks 👨‍👩‍👧‍👦</a>',
      `<a href="${normalized}">Root</a>`,
      `<a href="${normalized}/tickets/MTH-1">Ticket</a>`,
      `<a href="${normalized}#personal-settings">Hash</a>`,
      '<img src="/icons/logo.svg" srcset="/a.png 1x, /b.png 2x, https://cdn.example/c.png 3x">',
      '<form action="/api/tasks"><textarea>href="/do-not-touch"</textarea></form>',
      "</body></html>",
    ].join("")

    const encoded = new TextEncoder().encode(html)
    // Stream 3 bytes at a time so multi-byte UTF-8 emojis (👨‍👩‍👧‍👦 = 25 bytes, 📋 = 4 bytes) and tags split mid-sequence
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < encoded.length; offset += 3) {
          controller.enqueue(encoded.subarray(offset, Math.min(offset + 3, encoded.length)))
        }
        controller.close()
      },
    })

    const response = await rewriteIngressHtml(
      new Response(stream, { headers: { "content-type": "text/html; charset=utf-8", "content-length": String(encoded.length) } }),
      rawPrefix,
    )
    expect(response.headers.has("content-length")).toBe(false)
    const out = await response.text()

    expect(out).toContain(`<head data-astro-cid="abc123"><script>window.__ingress_path="${normalized}";</script><title>Clann 👨‍👩‍👧‍👦 &amp; 📋</title>`)
    expect(out).toContain('<script type="application/json">{"href":"/api/tasks","src":"/keep","action":"/raw"}</script>')
    expect(out).toContain(`<a href="${normalized}/tasks" data-href="/ignore">📋 Tasks 👨‍👩‍👧‍👦</a>`)
    expect(out).toContain(`<a href="${normalized}">Root</a>`)
    expect(out).toContain(`<a href="${normalized}/tickets/MTH-1">Ticket</a>`)
    expect(out).toContain(`<a href="${normalized}#personal-settings">Hash</a>`)
    expect(out).toContain(`src="${normalized}/icons/logo.svg"`)
    expect(out).toContain(`srcset="${normalized}/a.png 1x, ${normalized}/b.png 2x, https://cdn.example/c.png 3x"`)
    expect(out).toContain(`<form action="${normalized}/api/tasks"><textarea>href="/do-not-touch"</textarea></form>`)
    expect(out).not.toContain(`${normalized}${normalized}`)
  }
})

test("A4/A5/A8: live serve.mjs leaves Ingress HTML uncompressed, keeps attributes < 32 KiB, records mid-stream aborts once, and gates /api/diagnostics", async () => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires built dist/server/entry.mjs")
  test.setTimeout(25_000)

  const work = await mkdtemp(join(tmpdir(), "meitheal-serve-ingress-"))
  const preloadPath = join(work, "supervisor-preload.mjs")

  // Preload lets unmodified scripts/serve.mjs simulate Supervisor peer 172.30.32.2 + HA Core config/auth/list
  await writeFile(preloadPath, `
    import { once } from "node:events"
    import http from "node:http"
    import { createRequire } from "node:module"

    const require = createRequire(${JSON.stringify(join(webDir, "package.json"))})
    const { WebSocketServer } = require("ws")
    const core = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    await once(core, "listening")
    const corePort = core.address().port
    core.on("connection", socket => {
      socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.11.0" }))
      socket.on("message", raw => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === "auth") socket.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.11.0" }))
        else if (msg.type === "ping") socket.send(JSON.stringify({ id: msg.id, type: "pong" }))
        else if (msg.type === "config/auth/list") {
          socket.send(JSON.stringify({
            id: msg.id,
            type: "result",
            success: true,
            result: [
              { id: "admin-1", is_active: true, system_generated: false, is_owner: true, group_ids: ["system-admin"] },
              { id: "member-1", is_active: true, system_generated: false, is_owner: false, group_ids: ["system-users"] },
            ],
          }))
        } else {
          socket.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: [] }))
        }
      })
    })
    process.once("SIGTERM", () => {
      for (const s of core.clients) s.terminate()
      core.close()
      process.exit(0)
    })

    const realRequest = http.request
    http.request = function (options, ...rest) {
      if (options?.host === "supervisor" && options.path === "/core/api/websocket") {
        options = { ...options, host: "127.0.0.1", port: corePort }
      }
      return realRequest.call(this, options, ...rest)
    }

    const origFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url === "http://172.30.32.2/info") {
        return Response.json({ data: { supervisor: "2026.11.0" } })
      }
      if (url.startsWith("http://supervisor/")) {
        return Response.json({ data: { state: "started", addons: [] } })
      }
      return origFetch(input, init)
    }
    const origCreateServer = http.createServer
    http.createServer = function (listener) {
      const srv = origCreateServer.call(this, (req, res) => {
        if (req.headers["x-test-peer"] === "supervisor") {
          Object.defineProperty(req.socket, "remoteAddress", { value: "172.30.32.2", configurable: true })
        } else if (req.headers["x-test-peer"] === "lan") {
          Object.defineProperty(req.socket, "remoteAddress", { value: "198.51.100.25", configurable: true })
        } else {
          delete req.socket.remoteAddress
        }
        if (req.headers["x-test-slow-stream"] === "1") {
          const origEnd = res.end.bind(res)
          res.end = (...args) => {
            setTimeout(() => {
              if (!res.destroyed) origEnd(...args)
            }, 250).unref()
            return res
          }
        }
        return listener(req, res)
      })
      srv.once("listening", () => {
        const addr = srv.address()
        if (addr && typeof addr === "object") process.send?.({ type: "listening", port: addr.port })
      })
      return srv
    }
  `)

  const env = {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: "0",
    SUPERVISOR_TOKEN: "test-sup-token",
    INGRESS_PATH: "/api/hassio_ingress/live_tok",
    MEITHEAL_DB_URL: `file:${join(work, "live.db")}`,
  }
  await execFileAsync(process.execPath, ["scripts/migrate.mjs"], { cwd: webDir, env })

  const child = spawn(process.execPath, ["--import", preloadPath, "scripts/serve.mjs"], {
    cwd: webDir,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  child.stdout?.resume()
  let childStderr = ""
  child.stderr?.on("data", chunk => {
    if (childStderr.length < 16_384) childStderr += String(chunk)
  })

  try {
    const port = await new Promise<number>((resolve, reject) => {
      const onMessage = (msg: unknown) => {
        cleanup()
        const boundPort = (msg as { port?: number } | null)?.port
        if (typeof boundPort === "number" && boundPort > 0) resolve(boundPort)
        else reject(new Error(`Unexpected IPC message: ${JSON.stringify(msg)}`))
      }
      const onExit = (code: number | null, sig: NodeJS.Signals | null) => {
        cleanup()
        reject(new Error(`serve.mjs exited before listening (code=${String(code)}, sig=${String(sig)}): ${childStderr}`))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`serve.mjs listen timeout: ${childStderr}`))
      }, 10_000)
      function cleanup() {
        clearTimeout(timer)
        child.off("message", onMessage)
        child.off("exit", onExit)
      }
      child.once("message", onMessage)
      child.once("exit", onExit)
    })
    const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`)
    expect(healthRes.status, childStderr).toBe(200)

    const adminIngressHeaders = {
      "x-test-peer": "supervisor",
      "x-ingress-path": "/api/hassio_ingress/live_tok",
      "x-remote-user-id": "admin-1",
      "x-remote-user-groups": "system-admin",
      "accept-encoding": "gzip, deflate, br",
    }

    // Seed 40 tasks with rich descriptions so /tasks HTML streams multiple chunks
    for (let i = 0; i < 40; i++) {
      const cr = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: "POST",
        headers: {
          ...adminIngressHeaders,
          "content-type": "application/json",
          origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({
          title: `Streaming task ${i}`,
          description: `Detailed markdown note ${"word ".repeat(80)}`,
        }),
      })
      expect(cr.status).toBe(201)
    }

    // 1. Uncompressed Ingress HTML & attribute size < 32 KiB
    for (const route of ["/tasks", "/planning", "/eisenhower"]) {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, { headers: adminIngressHeaders })
      expect(res.status, childStderr).toBe(200)
      expect(res.headers.get("content-encoding")).toBeNull()
      const body = await res.text()
      expect(body).toContain('window.__ingress_path="/api/hassio_ingress/live_tok"')
      const attrMatches = body.matchAll(/\s[a-zA-Z_:][-a-zA-Z0-9_:.]*="([^"]*)"/g)
      for (const m of attrMatches) {
        expect((m[1] ?? "").length).toBeLessThan(32_768)
      }
    }

    // 2. Diagnostics before abort
    const diagBeforeRes = await fetch(`http://127.0.0.1:${port}/api/diagnostics`, { headers: adminIngressHeaders })
    expect(diagBeforeRes.status).toBe(200)
    const diagBefore = await diagBeforeRes.json()
    for (const key of [
      "ts", "rss_bytes", "heap_used_bytes", "heap_total_bytes", "heap_limit_bytes",
      "old_space_used_bytes", "external_bytes",
      "cgroup_current_bytes", "cgroup_max_bytes", "cgroup_oom_kill_count",
      "ha_tracked_entities", "ha_cached_entities", "ha_cache_approx_bytes",
      "sse_clients_active", "sse_backpressure_drops_total", "ingress_stream_aborts_total",
      "sqlite_busy_retries_total", "sqlite_busy_exhausted_total",
      "sqlite_read_pool_hits_total", "sqlite_read_pool_overflow_total",
      "sqlite_read_lease_slow_warnings_total",
    ]) {
      expect(diagBefore).toHaveProperty(key)
    }
    expect(diagBefore.ingress_stream_aborts_total).toBe(0)

    // 3. Mid-stream disconnect on Ingress HTML response increments ingress_stream_aborts_total once
    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        path: "/tasks",
        method: "GET",
        headers: { ...adminIngressHeaders, "x-test-slow-stream": "1" },
      }, res => {
        res.once("data", () => {
          req.destroy()
          resolve()
        })
      })
      req.on("error", err => {
        if ((err as NodeJS.ErrnoException).code === "ECONNRESET") resolve()
        else reject(err)
      })
      req.end()
    })

    await expect.poll(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/api/diagnostics`, { headers: adminIngressHeaders })
      const j = await r.json()
      return j.ingress_stream_aborts_total
    }, { timeout: 3_000 }).toBe(1)

    // 4. Access control on GET /api/diagnostics: reject unauthenticated LAN, non-admin member, and Bearer agent token
    const lanRes = await fetch(`http://127.0.0.1:${port}/api/diagnostics`, {
      headers: { "x-test-peer": "lan" },
    })
    expect([401, 403]).toContain(lanRes.status)

    const memberRes = await fetch(`http://127.0.0.1:${port}/api/diagnostics`, {
      headers: {
        "x-test-peer": "supervisor",
        "x-ingress-path": "/api/hassio_ingress/live_tok",
        "x-remote-user-id": "member-1",
        "x-remote-user-groups": "system-users",
      },
    })
    expect(memberRes.status).toBe(403)

    const tokenCreate = await fetch(`http://127.0.0.1:${port}/api/agent-tokens`, {
      method: "POST",
      headers: {
        ...adminIngressHeaders,
        "content-type": "application/json",
        origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ name: "Diag probe", scopes: ["tasks:read", "mcp:execute"] }),
    })
    expect(tokenCreate.status).toBe(201)
    const { token } = await tokenCreate.json()
    const agentDiagRes = await fetch(`http://127.0.0.1:${port}/api/diagnostics`, {
      headers: { "x-test-peer": "lan", authorization: `Bearer ${token}` },
    })
    expect([401, 403]).toContain(agentDiagRes.status)
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit")
      child.kill("SIGTERM")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})

test("A7: resolve_max_old_space_mb computes dynamic V8 heap ceilings across cgroup v2/v1 fixtures in run.sh and run-local.sh", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-cgroup-heap-"))
  try {
    const cgV2 = join(work, "memory.max")
    const cgV1 = join(work, "memory.limit_in_bytes")
    const scripts = [
      join(repoRoot, "meitheal-hub/run.sh"),
      join(repoRoot, "meitheal-hub/run-local.sh"),
    ]

    const cases: Array<{ v2?: string; envOverride?: string; expected: string }> = [
      { v2: "max\n", expected: "128" },
      { v2: "201326592\n", expected: "105" },
      { v2: "268435456\n", expected: "140" },
      { v2: "536870912\n", expected: "160" },
      { v2: "268435456\n", envOverride: "192", expected: "192" },
    ]

    for (const scriptPath of scripts) {
      for (const c of cases) {
        await writeFile(cgV2, c.v2 ?? "max\n")
        await writeFile(cgV1, "9223372036854771712\n")
        const { stdout } = await execFileAsync("sh", [
          "-c",
          `. "$1"; resolve_max_old_space_mb; NODE_OPTIONS="--enable-source-maps"; apply_resolved_node_options; printf '%s\n' "$NODE_OPTIONS"`,
          "sh",
          scriptPath,
        ], {
          env: {
            PATH: process.env.PATH ?? "",
            MEITHEAL_SOURCE_LIB_ONLY: "1",
            MEITHEAL_CGROUP_V2_MAX_FILE: cgV2,
            MEITHEAL_CGROUP_V1_LIMIT_FILE: cgV1,
            ...(c.envOverride ? { MEITHEAL_MAX_OLD_SPACE_MB: c.envOverride } : {}),
          },
        })
        const lines = stdout.trim().split("\n")
        expect(lines[0]).toBe(c.expected)
        expect(lines[1]).toBe(`--enable-source-maps --max-old-space-size=${c.expected}`)
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test("A8: logger bypasses category filter on warn/error, health.ts caches only HTTP 200, and config.river uses 5 low-cardinality labels", async () => {
  // 1. Logger warn/error category bypass
  const captured: string[] = []
  const origWrite = process.stdout.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    const text = String(chunk)
    if (text.includes('"component":"track-a-logger-test"')) {
      captured.push(text.trim())
      return true
    }
    return origWrite.call(process.stdout, chunk)
  }) as typeof process.stdout.write

  try {
    const logger = createLogger({
      service: "meitheal-web",
      env: "production",
      minLevel: "info",
      enabledCategories: ["tasks"],
      redactPatterns: defaultRedactionPatterns,
      auditEnabled: false,
    })
    logger.log("info", {
      event: "calendar.sync.tick",
      domain: "calendar",
      component: "track-a-logger-test",
      request_id: "r1",
      message: "suppressed info",
    })
    logger.log("warn", {
      event: "calendar.sync.degraded",
      domain: "calendar",
      component: "track-a-logger-test",
      request_id: "r2",
      message: "emitted warn",
    })
    logger.log("error", {
      event: "calendar.sync.failed",
      domain: "calendar",
      component: "track-a-logger-test",
      request_id: "r3",
      message: "emitted error",
    })
  } finally {
    process.stdout.write = origWrite
  }

  expect(captured).toHaveLength(2)
  expect(JSON.parse(captured[0]!).level).toBe("warn")
  expect(JSON.parse(captured[1]!).level).toBe("error")

  // 2. health.ts Supervisor cache: do NOT cache 502/504, DO cache 200 for 60s
  const healthWork = await mkdtemp(join(tmpdir(), "meitheal-health-cache-"))
  const store = await import("../../apps/web/src/domains/tasks/persistence/store")
  const prevSupToken = process.env.SUPERVISOR_TOKEN
  const prevDbUrl = process.env.MEITHEAL_DB_URL
  const origFetch = globalThis.fetch
  let supervisorCalls = 0
  let nextStatus = 502
  process.env.MEITHEAL_DB_URL = `file:${join(healthWork, "health.db")}`
  process.env.SUPERVISOR_TOKEN = "health-cache-token"
  store.resetPersistenceForTests()
  resetHealthSupervisorCacheForTests()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (u === "http://supervisor/addons/self/info") {
      supervisorCalls++
      if (nextStatus !== 200) return new Response("Bad Gateway", { status: nextStatus })
      return Response.json({ data: { state: "started" } })
    }
    return origFetch(input, init)
  }) as typeof fetch

  try {
    const res502 = await (await healthGET({} as Parameters<typeof healthGET>[0])).json()
    expect(res502.supervisor_reachable).toBe(false)
    expect(supervisorCalls).toBe(1)

    nextStatus = 504
    const res504 = await (await healthGET({} as Parameters<typeof healthGET>[0])).json()
    expect(res504.supervisor_reachable).toBe(false)
    expect(supervisorCalls).toBe(2)

    nextStatus = 200
    const res200First = await (await healthGET({} as Parameters<typeof healthGET>[0])).json()
    expect(res200First.supervisor_reachable).toBe(true)
    expect(supervisorCalls).toBe(3)

    // Subsequent call within 60s hits cache without calling fetch
    nextStatus = 502
    const res200Cached = await (await healthGET({} as Parameters<typeof healthGET>[0])).json()
    expect(res200Cached.supervisor_reachable).toBe(true)
    expect(supervisorCalls).toBe(3)
  } finally {
    resetHealthSupervisorCacheForTests()
    store.resetPersistenceForTests()
    globalThis.fetch = origFetch
    if (prevSupToken === undefined) delete process.env.SUPERVISOR_TOKEN
    else process.env.SUPERVISOR_TOKEN = prevSupToken
    if (prevDbUrl === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = prevDbUrl
    await rm(healthWork, { recursive: true, force: true })
  }

  // 3. Alloy config.river static check
  const river = await readFile(join(repoRoot, "meitheal-hub/rootfs/etc/alloy/config.river"), "utf8")
  expect(river).toContain('addon = "meitheal"')
  expect(river).toContain('service = "service"')
  expect(river).toContain('env = "env"')
  expect(river).toContain('level = "level"')
  expect(river).toContain('domain = "domain"')
  expect(river).not.toContain("actor_type")
  expect(river).not.toContain("stage.output")
})
