import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../../scripts/database-client.mjs"
import { SettingsRepository } from "../tasks/persistence/settings-repository"
import { readUnifiedEnvSnapshot } from "./env-state"
import type { SupervisorWebserverSnapshot } from "./supervisor-webserver"
import type { HaAddonOptionsPayload } from "./webserver-config"
import {
  getUnifiedAllowedMcpOrigins,
  getUnifiedWebserverState,
  invalidateWebserverStateCache,
  saveWebserverConfiguration,
  verifyWebserverConfiguration,
  type WebserverServiceDeps,
} from "./webserver-service"

function makeSupervisorSnapshot(
  overrides: Partial<SupervisorWebserverSnapshot> = {},
): SupervisorWebserverSnapshot {
  return {
    mode: "standalone",
    supervisorAvailable: false,
    haConnected: false,
    haVersion: null,
    addonSlug: null,
    addonHostname: null,
    ingressUrl: null,
    ingressPort: null,
    networkPorts: {},
    detectedHaInternalUrl: null,
    detectedHaExternalUrl: null,
    detectedHaUrl: null,
    interfaces: [
      { address: "0.0.0.0", label: "0.0.0.0 [default — all IPv4 interfaces]" },
      { address: "127.0.0.1", label: "127.0.0.1 [loopback only]" },
    ],
    supervisorServices: [],
    ...overrides,
  }
}

interface TestHarness {
  dir: string
  dotenvPath: string
  processEnv: Record<string, string | undefined>
  supervisor: SupervisorWebserverSnapshot
  syncedPayloads: HaAddonOptionsPayload[]
  repo: SettingsRepository
  deps: WebserverServiceDeps
  cleanup: () => void
}

async function createIsolatedHarness(initial: {
  dotenvContent?: string
  processEnv?: Record<string, string | undefined>
  supervisor?: Partial<SupervisorWebserverSnapshot>
} = {}): Promise<TestHarness> {
  const dir = mkdtempSync(join(tmpdir(), "meitheal-ws-service-"))
  const dbPath = join(dir, "webserver-test.db")
  const dotenvPath = join(dir, ".env")

  if (initial.dotenvContent !== undefined) {
    writeFileSync(dotenvPath, initial.dotenvContent, "utf8")
  }

  const client = openDatabase(`file:${dbPath}`)
  const repo = new SettingsRepository(client)
  await repo.ensureSettingsTable()

  const processEnv: Record<string, string | undefined> = { ...(initial.processEnv ?? {}) }
  const supervisor = makeSupervisorSnapshot(initial.supervisor)
  const syncedPayloads: HaAddonOptionsPayload[] = []

  const deps: WebserverServiceDeps = {
    openRepo: async () => repo,
    readEnv: () => readUnifiedEnvSnapshot({
      processEnv,
      candidates: [{ path: dotenvPath, label: ".env" }],
    }),
    readSupervisor: async () => supervisor,
    syncSupervisor: async (options) => {
      syncedPayloads.push(options)
      return { synced: true, detail: "Synced to Home Assistant Supervisor." }
    },
  }

  invalidateWebserverStateCache()

  return {
    dir,
    dotenvPath,
    processEnv,
    supervisor,
    syncedPayloads,
    repo,
    deps,
    cleanup: () => {
      invalidateWebserverStateCache()
      client.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const sampleRequest = new Request("http://localhost:3000/api/webserver")

test("unifies DB > process.env > .env > Supervisor > default precedence and tracks per-field provenance", async () => {
  const h = await createIsolatedHarness({
    dotenvContent: [
      "PORT=8095",
      "HOST=127.0.0.1",
      "SITE_URL=https://dotenv.example.com",
      "MEITHEAL_INTERNAL_URL=http://meitheal.local:8095",
      "MEITHEAL_SERVER_NAME=DotenvHub",
      "HA_TOKEN=super-secret-must-never-leak",
    ].join("\n"),
    processEnv: {
      PORT: "3000",
    },
    supervisor: {
      mode: "ha-addon",
      supervisorAvailable: true,
      haConnected: true,
      haVersion: "2026.4.0",
      addonHostname: "meitheal-canary",
      detectedHaUrl: "https://ha.home.arpa",
    },
  })

  try {
    const view = await getUnifiedWebserverState(sampleRequest, h.deps)

    // process.env overrides .env for PORT
    assert.equal(view.config.portsSpec, "3000")
    assert.deepEqual(view.config.ports, [3000])
    assert.deepEqual(view.provenance.portsSpec, { source: "process_env", envVar: "PORT" })

    // .env fills fields absent from DB and process.env
    assert.equal(view.config.bindAddress, "127.0.0.1")
    assert.deepEqual(view.provenance.bindAddress, { source: "dotenv", envVar: "HOST" })
    assert.equal(view.config.externalUrl, "https://dotenv.example.com")
    assert.deepEqual(view.provenance.externalUrl, { source: "dotenv", envVar: "SITE_URL" })
    assert.equal(view.config.internalUrl, "http://meitheal.local:8095")
    assert.deepEqual(view.provenance.internalUrl, { source: "dotenv", envVar: "MEITHEAL_INTERNAL_URL" })
    assert.equal(view.config.serverName, "DotenvHub")
    assert.deepEqual(view.provenance.serverName, { source: "dotenv", envVar: "MEITHEAL_SERVER_NAME" })

    // Supervisor fills Home Assistant URL when DB has no saved value
    assert.equal(view.config.homeAssistantUrl, "https://ha.home.arpa")
    assert.deepEqual(view.provenance.homeAssistantUrl, { source: "supervisor", envVar: null })
    assert.equal(view.mcp.mcpServerUrl, "https://dotenv.example.com/api/mcp")
    assert.equal(view.mcp.homeAssistantAiUrl, "https://ha.home.arpa/config/ai")

    // Secrets in .env are never exposed anywhere in the serialized snapshot
    assert.equal(JSON.stringify(view).includes("super-secret-must-never-leak"), false)
    assert.equal(view.activeRuntime.dotenvFound, true)
    assert.equal(view.activeRuntime.restartRequired, false)
  } finally {
    h.cleanup()
  }
})

test("reflects real-time .env file edits and live process.env changes immediately", async () => {
  const h = await createIsolatedHarness({
    dotenvContent: "PORT=3000\nSITE_URL=https://v1.example.com\n",
    processEnv: {},
  })

  try {
    const first = await getUnifiedWebserverState(sampleRequest, h.deps)
    assert.equal(first.config.externalUrl, "https://v1.example.com")
    assert.equal(first.mcp.mcpServerUrl, "https://v1.example.com/api/mcp")
    assert.deepEqual(first.provenance.externalUrl, { source: "dotenv", envVar: "SITE_URL" })

    // Edit .env on disk (different content + size invalidates mtime/size cache immediately)
    writeFileSync(
      h.dotenvPath,
      "PORT=3000\nSITE_URL=https://v2-live.example.com\nMEITHEAL_INTERNAL_URL=http://meitheal.lan:3000\n",
      "utf8",
    )

    const afterDotenvEdit = await getUnifiedWebserverState(sampleRequest, h.deps)
    assert.equal(afterDotenvEdit.config.externalUrl, "https://v2-live.example.com")
    assert.equal(afterDotenvEdit.config.internalUrl, "http://meitheal.lan:3000")
    assert.equal(afterDotenvEdit.mcp.mcpServerUrl, "https://v2-live.example.com/api/mcp")
    assert.deepEqual(afterDotenvEdit.provenance.externalUrl, { source: "dotenv", envVar: "SITE_URL" })

    // Change live process.env -> immediately supersedes .env
    h.processEnv.MEITHEAL_EXTERNAL_URL = "https://env-override.example.com"
    const afterProcessEnv = await getUnifiedWebserverState(sampleRequest, h.deps)
    assert.equal(afterProcessEnv.config.externalUrl, "https://env-override.example.com")
    assert.equal(afterProcessEnv.mcp.mcpServerUrl, "https://env-override.example.com/api/mcp")
    assert.deepEqual(afterProcessEnv.provenance.externalUrl, {
      source: "process_env",
      envVar: "MEITHEAL_EXTERNAL_URL",
    })
  } finally {
    h.cleanup()
  }
})

test("saves database settings, synchronizes ha_url safely, and forwards options to Supervisor", async () => {
  const h = await createIsolatedHarness({
    processEnv: { PORT: "3000", HOST: "0.0.0.0" },
  })

  try {
    const saved = await saveWebserverConfiguration(
      sampleRequest,
      {
        serverName: "Family Hub",
        internalUrl: "http://meitheal.local:3000",
        externalUrl: "https://tasks.family.example",
        homeAssistantUrl: "https://ha.family.example",
        portsSpec: "3000, 8095",
        bindAddress: "0.0.0.0",
        tlsEnabled: false,
        syncHaOptions: true,
      },
      h.deps,
    )

    assert.equal(saved.ok, true)
    if (!saved.ok) return

    // Saved view reflects DB provenance and detects listener mismatch (3000 vs 3000, 8095)
    assert.equal(saved.view.config.serverName, "Family Hub")
    assert.deepEqual(saved.view.config.ports, [3000, 8095])
    assert.deepEqual(saved.view.provenance.portsSpec, { source: "database", envVar: null })
    assert.deepEqual(saved.view.provenance.externalUrl, { source: "database", envVar: null })
    assert.equal(saved.view.activeRuntime.restartRequired, true)
    assert.equal(saved.supervisorSync.synced, true)

    // Supervisor received projected options including live MCP URL
    assert.equal(h.syncedPayloads.length, 1)
    assert.deepEqual(h.syncedPayloads[0]?.ports, [3000, 8095])
    assert.equal(h.syncedPayloads[0]?.mcp_server_url, "https://tasks.family.example/api/mcp")
    assert.equal(h.syncedPayloads[0]?.home_assistant_url, "https://ha.family.example")

    // SQLite persisted webserver_* keys AND synchronized ha_url
    const rows = await h.repo.getByKeys([
      "webserver_server_name",
      "webserver_ports",
      "webserver_home_assistant_url",
      "ha_url",
    ])
    assert.equal(rows.webserver_server_name, "Family Hub")
    assert.equal(rows.webserver_ports, "3000, 8095")
    assert.equal(rows.webserver_home_assistant_url, "https://ha.family.example")
    assert.equal(rows.ha_url, "https://ha.family.example")

    // Updating homeAssistantUrl when ha_url previously matched keeps ha_url in sync
    const updated = await saveWebserverConfiguration(
      sampleRequest,
      {
        serverName: "Family Hub",
        homeAssistantUrl: "https://ha2.family.example",
        portsSpec: "3000",
        syncHaOptions: false,
      },
      h.deps,
    )
    assert.equal(updated.ok, true)
    if (!updated.ok) return
    assert.equal(updated.supervisorSync.synced, false)
    assert.equal(h.syncedPayloads.length, 1) // syncHaOptions: false skipped Supervisor call

    const rowsAfterSync = await h.repo.getByKeys(["webserver_home_assistant_url", "ha_url"])
    assert.equal(rowsAfterSync.webserver_home_assistant_url, "https://ha2.family.example")
    assert.equal(rowsAfterSync.ha_url, "https://ha2.family.example")

    // When Connected Services has a distinct ha_url, saving webserver_home_assistant_url preserves it
    await h.repo.importBatch([{ key: "ha_url", value: JSON.stringify("http://supervisor-internal:8123") }])
    const preserved = await saveWebserverConfiguration(
      sampleRequest,
      {
        serverName: "Family Hub",
        homeAssistantUrl: "https://ha-public.family.example",
        portsSpec: "3000",
        syncHaOptions: false,
      },
      h.deps,
    )
    assert.equal(preserved.ok, true)
    const rowsPreserved = await h.repo.getByKeys(["webserver_home_assistant_url", "ha_url"])
    assert.equal(rowsPreserved.webserver_home_assistant_url, "https://ha-public.family.example")
    assert.equal(rowsPreserved.ha_url, "http://supervisor-internal:8123")
  } finally {
    h.cleanup()
  }
})

test("rejects invalid configurations atomically without mutating stored database state", async () => {
  const h = await createIsolatedHarness({
    processEnv: { PORT: "3000", HOST: "0.0.0.0" },
  })

  try {
    const baseline = await saveWebserverConfiguration(
      sampleRequest,
      {
        serverName: "Baseline Hub",
        externalUrl: "https://baseline.example.com",
        portsSpec: "3000",
        bindAddress: "0.0.0.0",
        syncHaOptions: false,
      },
      h.deps,
    )
    assert.equal(baseline.ok, true)

    const invalidCases: Array<{ label: string; input: Parameters<typeof saveWebserverConfiguration>[1]; expectedField: string }> = [
      { label: "out-of-range port", input: { portsSpec: "70000" }, expectedField: "portsSpec" },
      { label: "inverted port range", input: { portsSpec: "3010-3000" }, expectedField: "portsSpec" },
      { label: "javascript URL scheme", input: { externalUrl: "javascript:alert(1)", portsSpec: "3000" }, expectedField: "externalUrl" },
      { label: "credentials in URL", input: { internalUrl: "http://admin:pass@meitheal.local:3000", portsSpec: "3000" }, expectedField: "internalUrl" },
      { label: "malformed bind address", input: { bindAddress: "999.999.0.1", portsSpec: "3000" }, expectedField: "bindAddress" },
      { label: "TLS enabled without cert", input: { tlsEnabled: true, portsSpec: "3000" }, expectedField: "sslCertificate" },
      { label: "SSL certificate path traversal", input: { sslCertificate: "/ssl/../etc/shadow", portsSpec: "3000" }, expectedField: "sslCertificate" },
    ]

    for (const tc of invalidCases) {
      const saveRes = await saveWebserverConfiguration(sampleRequest, tc.input, h.deps)
      assert.equal(saveRes.ok, false, `save should fail for ${tc.label}`)
      if (!saveRes.ok) {
        assert.equal(saveRes.field, tc.expectedField, `save field mismatch for ${tc.label}`)
      }

      const verifyRes = await verifyWebserverConfiguration(sampleRequest, tc.input, h.deps)
      assert.equal(verifyRes.ok, false, `verify should fail for ${tc.label}`)
      if (!verifyRes.ok) {
        assert.equal(verifyRes.field, tc.expectedField, `verify field mismatch for ${tc.label}`)
        assert.equal(verifyRes.checks[0]?.status, "fail")
      }
    }

    // Stored SQLite rows must remain completely intact after all rejected writes
    const intact = await getUnifiedWebserverState(sampleRequest, h.deps)
    assert.equal(intact.config.serverName, "Baseline Hub")
    assert.equal(intact.config.externalUrl, "https://baseline.example.com")
    assert.equal(intact.config.portsSpec, "3000")
    assert.equal(intact.config.bindAddress, "0.0.0.0")
  } finally {
    h.cleanup()
  }
})

test("redacts stored SSL private keys, preserves them on placeholder saves, and allows clearing", async () => {
  const h = await createIsolatedHarness({
    processEnv: { PORT: "3000", HOST: "0.0.0.0" },
  })

  try {
    const withTls = await saveWebserverConfiguration(
      sampleRequest,
      {
        portsSpec: "3000",
        tlsEnabled: true,
        sslCertificate: "/ssl/fullchain.pem",
        sslPrivateKey: "/ssl/secret-privkey.pem",
        syncHaOptions: false,
      },
      h.deps,
    )
    assert.equal(withTls.ok, true)
    if (!withTls.ok) return
    assert.equal(withTls.view.config.tlsEnabled, true)
    assert.equal(withTls.view.config.sslPrivateKeyConfigured, true)
    assert.equal(JSON.stringify(withTls.view).includes("secret-privkey.pem"), false)

    // Saving again with redacted placeholder or omitted key preserves existing private key
    const kept = await saveWebserverConfiguration(
      sampleRequest,
      {
        serverName: "TLS Hub",
        portsSpec: "3000",
        tlsEnabled: true,
        sslCertificate: "/ssl/fullchain.pem",
        sslPrivateKey: "••••••••",
        syncHaOptions: false,
      },
      h.deps,
    )
    assert.equal(kept.ok, true)
    if (!kept.ok) return
    assert.equal(kept.view.config.sslPrivateKeyConfigured, true)

    // Explicitly clearing private key with TLS disabled removes it
    const cleared = await saveWebserverConfiguration(
      sampleRequest,
      {
        portsSpec: "3000",
        tlsEnabled: false,
        sslCertificate: "",
        sslPrivateKey: "",
        syncHaOptions: false,
      },
      h.deps,
    )
    assert.equal(cleared.ok, true)
    if (!cleared.ok) return
    assert.equal(cleared.view.config.sslPrivateKeyConfigured, false)
  } finally {
    h.cleanup()
  }
})

test("verifyWebserverConfiguration checks live listener alignment and flags restartRequired accurately", async () => {
  const h = await createIsolatedHarness({
    processEnv: { PORT: "3000", HOST: "0.0.0.0" },
  })

  try {
    const aligned = await verifyWebserverConfiguration(
      sampleRequest,
      { portsSpec: "3000", bindAddress: "0.0.0.0" },
      h.deps,
    )
    assert.equal(aligned.ok, true)
    if (!aligned.ok) return
    assert.equal(aligned.view.activeRuntime.restartRequired, false)
    assert.equal(aligned.checks.find((c) => c.id === "runtime_sync")?.status, "pass")

    const portMismatch = await verifyWebserverConfiguration(
      sampleRequest,
      { portsSpec: "8095-8097", bindAddress: "0.0.0.0" },
      h.deps,
    )
    assert.equal(portMismatch.ok, true)
    if (!portMismatch.ok) return
    assert.equal(portMismatch.view.activeRuntime.restartRequired, true)
    assert.equal(portMismatch.checks.find((c) => c.id === "runtime_sync")?.status, "warn")

    const hostMismatch = await verifyWebserverConfiguration(
      sampleRequest,
      { portsSpec: "3000", bindAddress: "127.0.0.1" },
      h.deps,
    )
    assert.equal(hostMismatch.ok, true)
    if (!hostMismatch.ok) return
    assert.equal(hostMismatch.view.activeRuntime.restartRequired, true)
    assert.equal(hostMismatch.checks.find((c) => c.id === "runtime_sync")?.status, "warn")
  } finally {
    h.cleanup()
  }
})

test("getUnifiedAllowedMcpOrigins merges SQLite, process.env, and .env origins and invalidates cache on save", async () => {
  const h = await createIsolatedHarness({
    dotenvContent: "SITE_URL=https://dotenv-origin.example.com/app\n",
    processEnv: {
      MEITHEAL_INTERNAL_URL: "http://meitheal.local:3000/tasks",
    },
  })

  try {
    const initialOrigins = await getUnifiedAllowedMcpOrigins(h.deps)
    assert.deepEqual(
      [...initialOrigins].sort(),
      ["http://meitheal.local:3000", "https://dotenv-origin.example.com"],
    )

    // Save a new external URL in SQLite -> cache must invalidate immediately
    const saved = await saveWebserverConfiguration(
      sampleRequest,
      {
        externalUrl: "https://db-origin.example.com/custom-path",
        portsSpec: "3000",
        syncHaOptions: false,
      },
      h.deps,
    )
    assert.equal(saved.ok, true)

    const updatedOrigins = await getUnifiedAllowedMcpOrigins(h.deps)
    assert.deepEqual(
      [...updatedOrigins].sort(),
      [
        "http://meitheal.local:3000",
        "https://db-origin.example.com",
        "https://dotenv-origin.example.com",
      ],
    )
  } finally {
    h.cleanup()
  }
})
