import test from "node:test"
import assert from "node:assert/strict"
import { evaluatePluginHealth, summarizeFleetHealth } from "./plugin-health"
import type { PluginRecord } from "./types"

const VALID_SHA = "a".repeat(64)

function makeRecord(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: "sample-ext",
    source: "uploaded",
    enabled: true,
    needsReconsent: false,
    manifest: {
      id: "sample-ext",
      name: "Sample Extension",
      version: "1.0.0",
      minMeithealVersion: "0.0.1",
      type: "extension",
      description: "Local sandbox extension.",
      author: "Community",
      license: "AGPL-3.0-only",
      entry: "plugin.js",
      iFrame: "index.html",
      sidePanel: true,
      permissions: ["tasks:read", "ui:side-panel"],
      hooks: [],
      allowedHosts: [],
      dataSharing: {
        outbound: false,
        destinations: [],
        dataTypes: ["tasks"],
        summary: "Local only.",
      },
    },
    files: {
      entryJs: "MeithealPlugin.onInit(() => {})",
      iframeHtml: "<!doctype html><html><body>OK</body></html>",
    },
    sha256: VALID_SHA,
    config: {},
    approvedUserServer: null,
    installedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

test("evaluatePluginHealth reports green Operational & 5/5 Compliant for healthy local extension", () => {
  const report = evaluatePluginHealth({
    record: makeRecord(),
    secrets: [],
    safeMode: false,
  })
  assert.equal(report.overall, "healthy")
  assert.equal(report.operationalState, "operational")
  assert.equal(report.securityTone, "healthy")
  assert.equal(report.passedChecks, 5)
  assert.equal(report.totalChecks, 5)
  assert.equal(report.remediation, undefined)
})

test("evaluatePluginHealth reports amber Paused (Safe Mode) when Safe Mode is enabled", () => {
  const report = evaluatePluginHealth({
    record: makeRecord(),
    secrets: [],
    safeMode: true,
  })
  assert.equal(report.overall, "warning")
  assert.equal(report.operationalState, "paused_safe_mode")
  assert.match(report.operationalLabel, /Safe Mode/)
  assert.ok(report.remediation)
})

test("evaluatePluginHealth reports amber Needs Configuration when connector config or secret is missing", () => {
  const connector = makeRecord({
    id: "gitea-issues",
    source: "builtin",
    manifest: {
      id: "gitea-issues",
      name: "Gitea Issues",
      version: "1.0.0",
      minMeithealVersion: "0.0.1",
      type: "connector",
      description: "Gitea connector",
      author: "Meitheal",
      license: "AGPL-3.0-only",
      permissions: ["tasks:write", "http:outbound", "secrets:use"],
      hooks: [],
      allowedHosts: ["$userServer"],
      dataSharing: {
        outbound: true,
        destinations: [{ host: "$userServer", purpose: "Sync issues" }],
        dataTypes: ["issues"],
        summary: "Calls approved server.",
      },
      connector: {
        configFields: [
          { key: "serverUrl", label: "Gitea Server URL", type: "url", required: true, bindUserServer: true },
          { key: "apiToken", label: "Personal Access Token", type: "secret", required: true, secretKey: "gitea_token" },
        ],
      },
    },
    files: {},
  })

  const unconfigured = evaluatePluginHealth({
    record: connector,
    secrets: [{ key: "gitea_token", configured: false }],
    safeMode: false,
  })
  assert.equal(unconfigured.overall, "warning")
  assert.equal(unconfigured.operationalState, "needs_config")
  assert.equal(unconfigured.securityTone, "warning")
  assert.match(unconfigured.remediation ?? "", /Gitea Server URL/)

  const configured = evaluatePluginHealth({
    record: {
      ...connector,
      config: { serverUrl: "https://git.home.lan" },
      approvedUserServer: "https://git.home.lan",
    },
    secrets: [{ key: "gitea_token", configured: true }],
    safeMode: false,
  })
  assert.equal(configured.overall, "healthy")
  assert.equal(configured.operationalState, "operational")
  assert.equal(configured.securityTone, "healthy")
  assert.equal(configured.passedChecks, 5)
})

test("evaluatePluginHealth reports red Blocked (Re-Consent) and Runtime Error states", () => {
  const reconsent = evaluatePluginHealth({
    record: makeRecord({ enabled: false, needsReconsent: true }),
    secrets: [],
    safeMode: false,
  })
  assert.equal(reconsent.overall, "critical")
  assert.equal(reconsent.operationalState, "blocked_reconsent")
  assert.equal(reconsent.securityTone, "critical")

  const errored = evaluatePluginHealth({
    record: makeRecord(),
    secrets: [],
    safeMode: false,
    runtimeError: "ReferenceError: badVar is not defined",
  })
  assert.equal(errored.overall, "critical")
  assert.equal(errored.operationalState, "error")
  assert.match(errored.remediation ?? "", /ReferenceError/)
})

test("evaluatePluginHealth flags uploaded outbound plugins for provenance review and invalid SHA-256 as critical", () => {
  const outboundUploaded = evaluatePluginHealth({
    record: makeRecord({
      manifest: {
        ...makeRecord().manifest,
        permissions: ["tasks:read", "http:outbound"],
        allowedHosts: ["api.example.com"],
        dataSharing: {
          outbound: true,
          destinations: [{ host: "api.example.com", purpose: "Sync" }],
          dataTypes: ["tasks"],
          summary: "Calls api.example.com.",
        },
      },
    }),
    secrets: [],
    safeMode: false,
  })
  assert.equal(outboundUploaded.securityTone, "warning")
  assert.equal(outboundUploaded.overall, "warning")
  assert.equal(
    outboundUploaded.checks.find((c) => c.id === "provenance_integrity")?.status,
    "warn",
  )

  const badHash = evaluatePluginHealth({
    record: makeRecord({ enabled: false, sha256: "not-a-sha" }),
    secrets: [],
    safeMode: false,
  })
  assert.equal(badHash.securityTone, "critical")
  assert.equal(badHash.overall, "critical")

  const externalScript = evaluatePluginHealth({
    record: makeRecord({
      files: {
        entryJs: "MeithealPlugin.onInit(() => {})",
        iframeHtml: '<script src="https://evil.example/x.js"></script>',
      },
    }),
    secrets: [],
    safeMode: false,
  })
  assert.equal(externalScript.securityTone, "warning")
  assert.equal(externalScript.checks.find((c) => c.id === "sandbox_isolation")?.status, "warn")
})

test("summarizeFleetHealth aggregates active, healthy, warning, critical, and inactive counts accurately", () => {
  const healthy = evaluatePluginHealth({ record: makeRecord({ id: "p1" }), secrets: [], safeMode: false })
  const disabled = evaluatePluginHealth({ record: makeRecord({ id: "p2", enabled: false }), secrets: [], safeMode: false })
  const blocked = evaluatePluginHealth({ record: makeRecord({ id: "p3", enabled: false, needsReconsent: true }), secrets: [], safeMode: false })
  const disabledBadHash = evaluatePluginHealth({ record: makeRecord({ id: "p4", enabled: false, sha256: "bad" }), secrets: [], safeMode: false })

  const summary = summarizeFleetHealth([healthy, disabled, blocked, disabledBadHash], false)
  assert.equal(summary.activeCount, 1)
  assert.equal(summary.healthyCount, 1)
  assert.equal(summary.warningCount, 0)
  assert.equal(summary.criticalCount, 2)
  assert.equal(summary.inactiveCount, 1)
  assert.equal(summary.overall, "critical")
})
