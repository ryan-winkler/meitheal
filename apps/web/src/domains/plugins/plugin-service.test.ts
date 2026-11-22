import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { buildPluginZip } from "./plugin-zip"
import { PluginService } from "./plugin-service"
import type { PluginDbClient } from "./plugin-repository"

async function createTempDb(): Promise<{ db: PluginDbClient; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meitheal-plugins-test-"))
  const sqlite = new DatabaseSync(path.join(dir, "test.db"))
  sqlite.exec("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")

  const db: PluginDbClient = {
    async execute(query) {
      const sql = typeof query === "string" ? query : query.sql
      const args = typeof query === "string" ? [] : (query.args ?? [])
      const trimmed = sql.trim().toUpperCase()
      if (trimmed.startsWith("SELECT")) {
        const rows = sqlite.prepare(sql).all(...(args as never[])) as Array<Record<string, unknown>>
        return { rows }
      }
      sqlite.prepare(sql).run(...(args as never[]))
      return { rows: [] }
    },
  }

  return {
    db,
    async cleanup() {
      sqlite.close()
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

test("PluginService lifecycle: production connectors only, AI bundle install, ZIP packager, re-consent, health, secrets, Safe Mode", async () => {
  const { db, cleanup } = await createTempDb()
  const tmpOutDir = await fs.mkdtemp(path.join(os.tmpdir(), "meitheal-pack-test-"))
  try {
    const service = new PluginService({
      db,
      httpDeps: {
        dnsLookup: async () => [{ address: "140.82.121.6", family: 4 }],
        fetchImpl: async () =>
          new Response(
            JSON.stringify([
              { number: 42, title: "Fix porch light", body: "LED flickering", html_url: "https://github.com/home/ops/issues/42" },
            ]),
            { status: 200 },
          ),
      },
    })

    // 1. Lists only the 2 production built-in connectors (no example development plugins pre-installed)
    const initial = await service.listPlugins()
    assert.equal(initial.safeMode, false)
    assert.equal(initial.plugins.length, 2)
    assert.deepEqual(initial.plugins.map((p) => p.id), ["github-issues", "gitea-issues"])
    assert.equal(initial.fleetHealth.activeCount, 0)
    assert.equal(initial.fleetHealth.inactiveCount, 2)
    assert.equal(await service.hasActivePlugins(), false)

    // 2. Pack standalone reference app via scripts/pack-plugin.mjs and install via ZIP pipeline
    const repoRoot = path.resolve(import.meta.dirname, "../../../../..")
    const packedZipPath = path.join(tmpOutDir, "carryover-helper.zip")
    execFileSync(process.execPath, [
      path.join(repoRoot, "scripts", "pack-plugin.mjs"),
      path.join(repoRoot, "examples", "plugins", "yesterday-carryover"),
      "--out",
      packedZipPath,
    ])
    const refZipBuffer = await fs.readFile(packedZipPath)
    const refInstall = await service.installFromZip(refZipBuffer)
    assert.equal(refInstall.ok, true)
    if (refInstall.ok) {
      assert.equal(refInstall.data.id, "carryover-helper")
      assert.equal(refInstall.data.enabled, false)
      assert.equal(refInstall.data.health.passedChecks, 5)
    }

    // 3. Install AI-generated bundle via installFromBundle, enable, verify isolated storage & green health
    const aiInstall = await service.installFromBundle({
      manifest: {
        schemaVersion: 1,
        id: "focus-notes",
        name: "Focus Notes",
        version: "1.0.0",
        minMeithealVersion: "0.0.1",
        type: "extension",
        description: "Local focus scratchpad.",
        author: "Community",
        license: "AGPL-3.0-only",
        entry: "plugin.js",
        icon: "icon.svg",
        permissions: ["storage:local"],
        hooks: [],
        allowedHosts: [],
        dataSharing: { outbound: false, destinations: [], dataTypes: ["plugin-storage"], summary: "Local only." },
      },
      pluginJs: "MeithealPlugin.onInit(() => {})",
      iconSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M4 12h16"/></svg>',
    })
    assert.equal(aiInstall.ok, true)

    const enabled = await service.updatePlugin("focus-notes", { enabled: true })
    assert.equal(enabled.ok, true)
    if (enabled.ok) {
      assert.equal(enabled.data.health.overall, "healthy")
      assert.equal(enabled.data.health.operationalState, "operational")
      assert.equal(enabled.data.health.securityTone, "healthy")
    }
    assert.equal(await service.hasActivePlugins(), true)

    const writeRes = await service.writeStorage("focus-notes", "focusNote", "Clean garage")
    assert.equal(writeRes.ok, true)
    const readRes = await service.readStorage("focus-notes", "focusNote")
    assert.equal(readRes.ok, true)
    if (readRes.ok) assert.equal(readRes.data, "Clean garage")

    // 4. Safe Mode pauses all runtime bundles, storage, and flips health to amber Paused
    await service.setSafeMode(true)
    assert.equal(await service.hasActivePlugins(), false)
    const pausedList = await service.listPlugins()
    assert.equal(pausedList.fleetHealth.overall, "warning")
    assert.equal(pausedList.plugins.find((p) => p.id === "focus-notes")?.health.operationalState, "paused_safe_mode")
    const runtimePaused = await service.getRuntimeBundles()
    assert.equal(runtimePaused.bundles.length, 0)
    const storagePaused = await service.readStorage("focus-notes", "focusNote")
    assert.equal(storagePaused.ok, false)
    await service.setSafeMode(false)

    // 5. Write-only secrets never leak in listSecrets / listPlugins, and turn connector health green when configured
    const ghEnabledUnconfigured = await service.updatePlugin("github-issues", { enabled: true })
    assert.equal(ghEnabledUnconfigured.ok, true)
    if (ghEnabledUnconfigured.ok) {
      assert.equal(ghEnabledUnconfigured.data.health.operationalState, "needs_config")
      assert.equal(ghEnabledUnconfigured.data.health.overall, "warning")
    }

    await service.updatePlugin("github-issues", { enabled: true, config: { repository: "home/ops" } })
    const secretSave = await service.setSecret("github-issues", "github_token", "ghp_secret_value_123456")
    assert.equal(secretSave.ok, true)
    const listedSecrets = await service.listSecrets("github-issues")
    assert.equal(listedSecrets.ok, true)
    assert.equal(JSON.stringify(listedSecrets).includes("ghp_secret_value_123456"), false)

    const ghHealthy = await service.getPlugin("github-issues")
    assert.equal(ghHealthy?.health.overall, "healthy")
    assert.equal(ghHealthy?.health.operationalState, "operational")

    const items = await service.fetchConnectorItems("github-issues")
    assert.equal(items.ok, true)
    if (items.ok) {
      assert.equal(items.data.length, 1)
      assert.equal(items.data[0]!.externalId, "github-issues:home/ops#42")
    }

    // 6. Upgrade requesting new permission forces re-consent & red Blocked health
    const v2Zip = buildPluginZip([
      {
        name: "manifest.json",
        content: JSON.stringify({
          id: "focus-notes",
          name: "Focus Notes",
          version: "1.1.0",
          minMeithealVersion: "0.0.1",
          type: "extension",
          description: "Local focus scratchpad with task writes.",
          author: "Community",
          license: "AGPL-3.0-only",
          entry: "plugin.js",
          permissions: ["storage:local", "tasks:write"],
          hooks: [],
          allowedHosts: [],
          dataSharing: { outbound: false, destinations: [], dataTypes: ["tasks"], summary: "Local only." },
        }),
      },
      { name: "plugin.js", content: "MeithealPlugin.onInit(() => {})" },
    ])
    const installedV2 = await service.installFromZip(v2Zip)
    assert.equal(installedV2.ok, true)
    if (installedV2.ok) {
      assert.equal(installedV2.data.enabled, false)
      assert.equal(installedV2.data.needsReconsent, true)
      assert.equal(installedV2.data.health.overall, "critical")
      assert.equal(installedV2.data.health.operationalState, "blocked_reconsent")
    }

    const blockedEnable = await service.updatePlugin("focus-notes", { enabled: true })
    assert.equal(blockedEnable.ok, false)
    if (!blockedEnable.ok) assert.equal(blockedEnable.errorCode, "RECONSENT_REQUIRED")

    const approved = await service.updatePlugin("focus-notes", { approveReconsent: true, enabled: true })
    assert.equal(approved.ok, true)
    if (approved.ok) {
      assert.equal(approved.data.enabled, true)
      assert.equal(approved.data.needsReconsent, false)
      assert.equal(approved.data.health.overall, "healthy")
    }

    // 7. Remove all uploaded removes both uploaded plugins but keeps production built-ins
    const removed = await service.removeAllUploadedPlugins()
    assert.equal(removed.removedCount, 2)
    assert.equal(await service.getPlugin("focus-notes"), null)
    assert.equal(await service.getPlugin("carryover-helper"), null)
    assert.notEqual(await service.getPlugin("github-issues"), null)
  } finally {
    await fs.rm(tmpOutDir, { recursive: true, force: true })
    await cleanup()
  }
})
