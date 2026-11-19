import dns from "node:dns"
import { createServer, type Server } from "node:http"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests
} from "../helpers/persistence-fixture"
import {
  registerVerifiedPrincipal,
  type VerifiedPrincipal
} from "../../apps/web/src/domains/tasks/board-scope"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { readWorkDestinations } from "../../apps/web/src/domains/tasks/integration-destinations"
import { saveWorkBinding } from "../../apps/web/src/domains/tasks/work-binding-manager"
import { verifiedBoardRequestPrincipal } from "../../apps/web/src/lib/board-request-context"
import { boardSessionProof } from "../../apps/web/src/lib/named-board-request"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { POST as autoKey } from "../../apps/web/src/pages/api/grocy/auto-key"
import { POST as importSettings } from "../../apps/web/src/pages/api/import/settings"

let directory: string
let originalLookup: typeof dns.lookup
let provider: Server
let origin: string
let keyPosts: number
let gate: Promise<void> | null
let release: (() => void) | null
let requestSeen: Promise<void>
let markSeen: () => void
const previousUrl = process.env.MEITHEAL_DB_URL
const previousSupervisor = process.env.SUPERVISOR_TOKEN
const transport = {
  peer: "127.0.0.1",
  fromSupervisor: false,
  identityHeadersSafe: true,
  configuredPath: undefined
}
let operator: VerifiedPrincipal
function routeContext(path: string, payload: unknown) {
  const url = new URL(`http://localhost${path}`)
  return {
    request: new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-meitheal-board-session": boardSessionProof(operator.id)
      },
      body: JSON.stringify(payload)
    }),
    url,
    params: {},
    locals: { hassIsAdmin: true }
  } as Parameters<typeof autoKey>[0]
}
async function bind(principal: VerifiedPrincipal) {
  const created = await new NamedBoardRepository(getPersistenceClient()).create(
    principal,
    "Private Work"
  )
  if (created.status !== "committed") throw new Error("Board fixture")
  const configuration = await readWorkDestinations(getPersistenceClient())
  const binding = await saveWorkBinding(
    getPersistenceClient(),
    principal,
    configuration!.revision,
    {
      id: randomUUID(),
      generation: 1,
      integration: "grocy",
      sourceId: "configured-grocy",
      purpose: "grocy.sync",
      enabled: true,
      destination: { boardId: created.result.id },
      allowedOperations: [{ resource: "task", action: "read" }]
    }
  )
  if (!binding.ok) throw new Error("Binding fixture")
  return binding.binding
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ordinary-profile-boundaries-"))
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "test.db")}`
  delete process.env.SUPERVISOR_TOKEN
  await ensureSchema()
  const principal = await runWithIngressTransport(transport, () =>
    verifiedBoardRequestPrincipal({
      request: new Request("http://localhost/api/settings"),
      locals: {} as App.Locals
    })
  )
  if (!principal) throw new Error("Current standalone operator fixture")
  operator = principal
  keyPosts = 0
  gate = null
  release = null
  requestSeen = new Promise((resolve) => {
    markSeen = resolve
  })
  provider = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/objects/api_keys") {
      keyPosts++
      markSeen()
      if (gate) await gate
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ api_key: "fixture-provider-created-key" }))
    } else res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
  const address = provider.address()
  if (!address || typeof address === "string") throw new Error("Provider fixture")
  origin = `http://grocy-profile.internal:${address.port}`
  originalLookup = dns.lookup
  dns.lookup = ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const done = typeof options === "function" ? (options as typeof callback) : callback
    if (hostname === "grocy-profile.internal") {
      if (options && typeof options === "object" && "all" in options && options.all)
        done(null, [{ address: "127.0.0.1", family: 4 }])
      else done(null, "127.0.0.1", 4)
      return
    }
    if (hostname === "supervisor") {
      done(Object.assign(new Error("Synthetic no Supervisor"), { code: "ENOTFOUND" }))
      return
    }
    return originalLookup(hostname, options as dns.LookupOptions, done as never)
  }) as typeof dns.lookup
})
test.afterEach(async () => {
  release?.()
  dns.lookup = originalLookup
  provider.closeAllConnections()
  await new Promise<void>((resolve) => provider.close(() => resolve()))
  resetPersistenceForTests()
  if (previousUrl === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previousUrl
  if (previousSupervisor === undefined) delete process.env.SUPERVISOR_TOKEN
  else process.env.SUPERVISOR_TOKEN = previousSupervisor
  await rm(directory, { recursive: true, force: true })
})

test("AutoKey cannot contact provider key creation without managing every affected private Board", async () => {
  const owner = registerVerifiedPrincipal(
    { kind: "ha_user", id: "work-owner" },
    { administrator: true, expiresAt: Date.now() + 60_000 }
  )
  const binding = await bind(owner)
  const response = await runWithIngressTransport(transport, () =>
    autoKey(routeContext("/api/grocy/auto-key", { url: origin }))
  )
  expect(response.status).toBe(409)
  expect(keyPosts).toBe(0)
  expect(
    (await getPersistenceClient().execute("SELECT value FROM settings WHERE key='grocy_url'")).rows
  ).toHaveLength(0)
  expect(
    (await readWorkDestinations(getPersistenceClient()))?.bindings.find(
      (item) => item.id === binding.id
    )
  ).toMatchObject({ generation: 1, enabled: true })
})

test("AutoKey journals profile and replacement identity after actual provider reply", async () => {
  const binding = await bind(operator)
  const response = await runWithIngressTransport(transport, () =>
    autoKey(routeContext("/api/grocy/auto-key", { url: origin }))
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true })
  expect(keyPosts).toBe(1)
  const configuration = await readWorkDestinations(getPersistenceClient())
  expect(configuration?.bindings.find((item) => item.id === binding.id)).toMatchObject({
    retired: true,
    enabled: false
  })
  expect(
    configuration?.bindings.find((item) => item.integration === "grocy" && !item.retired)?.id
  ).not.toBe(binding.id)
  const stored = await getPersistenceClient().execute(
    "SELECT value FROM settings WHERE key='grocy_api_key'"
  )
  expect(stored.rows).toHaveLength(1)
  expect(JSON.stringify(configuration)).not.toContain("fixture-provider-created-key")
})

test("AutoKey holds no SQLite writer during provider await and reports an uncommitted created key", async () => {
  await bind(operator)
  gate = new Promise((resolve) => {
    release = resolve
  })
  const pending = runWithIngressTransport(transport, () =>
    autoKey(routeContext("/api/grocy/auto-key", { url: origin }))
  )
  await requestSeen
  // This actual writer can finish while the provider is held. Its change invalidates
  // the original profile snapshot before the reply is allowed to commit anything.
  const tx = await getPersistenceClient().transaction("write")
  await tx.execute(
    "INSERT INTO settings(key,value) VALUES('grocy_url','\"http://changed.example.test\"')"
  )
  await tx.commit()
  tx.close()
  release!()
  const response = await pending
  expect(response.status).toBe(500)
  expect((await response.json()).error).toContain("API key was created")
  expect(keyPosts).toBe(1)
  expect(
    (await getPersistenceClient().execute("SELECT value FROM settings WHERE key='grocy_api_key'"))
      .rows
  ).toHaveLength(0)
})

test("changed profile import rejects every settings, rules and framework effect before writing", async () => {
  await getPersistenceClient().execute(
    "INSERT INTO settings(key,value) VALUES('theme','\"light\"')"
  )
  await getPersistenceClient().execute(
    "INSERT INTO rules(id,name,created_at,updated_at) VALUES('retained-rule','Retain this rule','before','before')"
  )
  await getPersistenceClient().execute(
    "INSERT INTO framework_configs(id,framework_id,created_at,updated_at) VALUES('retained-framework','retained-framework','before','before')"
  )
  const response = await runWithIngressTransport(transport, () =>
    importSettings(
      routeContext("/api/import/settings", {
        _version: 2,
        _settingsEncoding: "json-values",
        settings: { theme: "dark", grocy_url: origin },
        rules: [],
        frameworkOverrides: []
      })
    )
  )
  expect(response.status).toBe(409)
  expect((await response.json()).error).toContain("Nothing was imported")
  expect(
    (await getPersistenceClient().execute("SELECT value FROM settings WHERE key='theme'")).rows[0]
      ?.value
  ).toBe('"light"')
  expect(
    (await getPersistenceClient().execute("SELECT value FROM settings WHERE key='grocy_url'")).rows
  ).toHaveLength(0)
  expect(keyPosts).toBe(0)
  expect((await getPersistenceClient().execute("SELECT id FROM rules")).rows).toEqual([
    expect.objectContaining({ id: "retained-rule" })
  ])
  expect((await getPersistenceClient().execute("SELECT id FROM framework_configs")).rows).toEqual([
    expect.objectContaining({ id: "retained-framework" })
  ])
})

test("unchanged legacy scalar profile bytes survive an otherwise atomic normal import", async () => {
  await getPersistenceClient().execute({
    sql: "INSERT INTO settings(key,value) VALUES('grocy_url',?)",
    args: [origin]
  })
  const response = await runWithIngressTransport(transport, () =>
    importSettings(
      routeContext("/api/import/settings", {
        _version: 2,
        _settingsEncoding: "json-values",
        settings: { theme: "dark", grocy_url: origin }
      })
    )
  )
  expect(response.status).toBe(200)
  expect(
    (await getPersistenceClient().execute("SELECT value FROM settings WHERE key='grocy_url'"))
      .rows[0]?.value
  ).toBe(origin)
  expect(
    (await getPersistenceClient().execute("SELECT value FROM settings WHERE key='theme'")).rows[0]
      ?.value
  ).toBe('"dark"')
})
