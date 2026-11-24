import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  mergeEnvLayers,
  parseAllowlistedDotenvContent,
  readSafeDotenvState,
} from "./env-state"
import {
  hydrateWebserverConfig,
  resolveWebserverRuntimeState,
} from "./webserver-config"

test("parseAllowlistedDotenvContent extracts allowlisted keys and discards all secrets", () => {
  const sample = [
    "# Comments and blanks are ignored",
    "PORT=8095 # inline comment",
    "export MEITHEAL_HOST=\"127.0.0.1\"",
    "SITE_URL='https://tasks.home.arpa'",
    "HA_BASE_URL=https://ha.home.arpa",
    "TZ=Europe/Dublin",
    // Non-allowlisted sensitive keys must NEVER be parsed or returned
    "HA_TOKEN=super-secret-ha-token",
    "SUPERVISOR_TOKEN=super-secret-supervisor",
    "DATABASE_URL=postgres://admin:pass@localhost/db",
    "API_KEY=sk-live-secret",
    "JWT_SECRET=top-secret-signing-key",
    "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----",
  ].join("\n")

  const parsed = parseAllowlistedDotenvContent(sample) as Record<string, string | undefined>
  assert.equal(parsed.PORT, "8095")
  assert.equal(parsed.MEITHEAL_HOST, "127.0.0.1")
  assert.equal(parsed.SITE_URL, "https://tasks.home.arpa")
  assert.equal(parsed.HA_BASE_URL, "https://ha.home.arpa")
  assert.equal(parsed.TZ, "Europe/Dublin")

  assert.equal(parsed.HA_TOKEN, undefined)
  assert.equal(parsed.SUPERVISOR_TOKEN, undefined)
  assert.equal(parsed.DATABASE_URL, undefined)
  assert.equal(parsed.API_KEY, undefined)
  assert.equal(parsed.JWT_SECRET, undefined)
  assert.equal(parsed.PRIVATE_KEY, undefined)
})

test("readSafeDotenvState detects live edits, rejects symlinks and oversized files, and never exposes host paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "meitheal-env-test-"))
  try {
    const envPath = join(dir, ".env")
    const targetPath = join(dir, "real.env")
    const linkPath = join(dir, "link.env")
    const bigPath = join(dir, "big.env")

    writeFileSync(envPath, "PORT=3000\nHA_TOKEN=secret\n", "utf8")
    writeFileSync(targetPath, "PORT=9999\n", "utf8")
    symlinkSync(targetPath, linkPath)
    writeFileSync(bigPath, `PORT=4000\n${"#".repeat(70_000)}\n`, "utf8")

    const initial = readSafeDotenvState([
      { path: linkPath, label: "symlink.env" },
      { path: bigPath, label: "big.env" },
      { path: envPath, label: ".env" },
    ])
    assert.equal(initial.found, true)
    assert.equal(initial.fileLabel, ".env")
    assert.equal(initial.values.PORT, "3000")
    assert.equal(initial.keys.includes("PORT"), true)
    assert.equal((initial.values as Record<string, unknown>).HA_TOKEN, undefined)
    // Symlink and oversized candidates must be skipped
    assert.equal(initial.fileLabel?.includes(dir), false)

    // Real-time update: edit file size/content and verify cache invalidates immediately
    writeFileSync(envPath, "PORT=8095\nMEITHEAL_SERVER_NAME=HomeHub\n", "utf8")
    const updated = readSafeDotenvState([{ path: envPath, label: ".env" }])
    assert.equal(updated.values.PORT, "8095")
    assert.equal(updated.values.MEITHEAL_SERVER_NAME, "HomeHub")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("mergeEnvLayers prioritizes live process.env over .env file values", () => {
  const dotenv = {
    found: true,
    fileLabel: ".env",
    values: {
      PORT: "8095",
      HOST: "127.0.0.1",
      SITE_URL: "https://from-dotenv.example.com",
    },
    keys: ["PORT", "HOST", "SITE_URL"] as const,
  }
  const snapshot = mergeEnvLayers(
    {
      PORT: "3000",
      MEITHEAL_EXTERNAL_URL: "https://from-process.example.com",
      HA_TOKEN: "must-be-ignored",
    },
    { ...dotenv, keys: [...dotenv.keys] },
  )

  assert.equal(snapshot.merged.PORT, "3000")
  assert.equal(snapshot.keyOrigin.PORT, "process_env")
  assert.equal(snapshot.merged.HOST, "127.0.0.1")
  assert.equal(snapshot.keyOrigin.HOST, "dotenv")
  assert.equal(snapshot.merged.SITE_URL, "https://from-dotenv.example.com")
  assert.equal(snapshot.keyOrigin.SITE_URL, "dotenv")
  assert.equal(snapshot.merged.MEITHEAL_EXTERNAL_URL, "https://from-process.example.com")
  assert.equal(snapshot.keyOrigin.MEITHEAL_EXTERNAL_URL, "process_env")
  assert.equal(snapshot.keyOrigin.HA_BASE_URL, "unset")
  assert.equal((snapshot.merged as Record<string, unknown>).HA_TOKEN, undefined)
})

test("resolveWebserverRuntimeState computes exact per-field provenance and restartRequired", () => {
  const processEnv = { PORT: "3000", HOST: "0.0.0.0" }
  const dotenvValues = { SITE_URL: "https://tasks.example.com", MEITHEAL_SERVER_NAME: "DotenvHub" }
  const settings = { webserver_ports: "8095", webserver_internal_url: "http://meitheal.local:8095" }

  const config = hydrateWebserverConfig(settings, {
    detectedHaUrl: "https://ha.example.com",
    env: { ...dotenvValues, ...processEnv },
  })

  const { provenance, activeRuntime } = resolveWebserverRuntimeState({
    config,
    settings,
    processEnv,
    dotenvValues,
    dotenvFound: true,
    dotenvLabel: ".env",
    dotenvKeys: ["SITE_URL", "MEITHEAL_SERVER_NAME"],
    detectedHaUrl: "https://ha.example.com",
  })

  assert.deepEqual(provenance.portsSpec, { source: "database", envVar: null })
  assert.deepEqual(provenance.internalUrl, { source: "database", envVar: null })
  assert.deepEqual(provenance.externalUrl, { source: "dotenv", envVar: "SITE_URL" })
  assert.deepEqual(provenance.serverName, { source: "dotenv", envVar: "MEITHEAL_SERVER_NAME" })
  assert.deepEqual(provenance.homeAssistantUrl, { source: "supervisor", envVar: null })
  assert.deepEqual(provenance.bindAddress, { source: "process_env", envVar: "HOST" })

  // Saved port 8095 differs from live listening port 3000 -> restart required
  assert.equal(activeRuntime.listeningPortsSpec, "3000")
  assert.equal(activeRuntime.listeningHost, "0.0.0.0")
  assert.equal(activeRuntime.restartRequired, true)
  assert.equal(activeRuntime.dotenvFound, true)

  // Matching saved port 3000 -> no restart required
  const alignedSettings = { webserver_ports: "3000" }
  const alignedConfig = hydrateWebserverConfig(alignedSettings, { env: processEnv })
  const alignedState = resolveWebserverRuntimeState({
    config: alignedConfig,
    settings: alignedSettings,
    processEnv,
    dotenvValues: {},
    dotenvFound: false,
    dotenvLabel: null,
    dotenvKeys: [],
  })
  assert.equal(alignedState.activeRuntime.restartRequired, false)
})
