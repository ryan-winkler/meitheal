import test from "node:test"
import assert from "node:assert/strict"
import { classifyIpAddress, executePluginHttpRequest } from "./plugin-http-gateway"
import type { PluginRecord } from "./types"

function makePlugin(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: "github-issues",
    source: "builtin",
    enabled: true,
    needsReconsent: false,
    sha256: "abc",
    config: {},
    approvedUserServer: null,
    installedAt: "2026-11-21T00:00:00Z",
    updatedAt: "2026-11-21T00:00:00Z",
    files: {},
    manifest: {
      id: "github-issues",
      name: "GitHub Issues",
      version: "1.0.0",
      minMeithealVersion: "0.0.2",
      type: "connector",
      description: "GitHub connector.",
      author: "Meitheal",
      license: "AGPL-3.0-only",
      entry: "plugin.js",
      permissions: ["http:outbound", "secrets:use"],
      hooks: [],
      allowedHosts: ["api.github.com"],
      dataSharing: {
        outbound: true,
        destinations: [{ host: "api.github.com", purpose: "Read issues." }],
        dataTypes: ["issue_title"],
        summary: "Calls GitHub API.",
      },
    },
    ...overrides,
  }
}

test("classifies loopback, metadata, IPv4-mapped IPv6, expanded IPv6, and private LAN IPs accurately", () => {
  assert.equal(classifyIpAddress("127.0.0.1"), "blocked_internal")
  assert.equal(classifyIpAddress("::1"), "blocked_internal")
  assert.equal(classifyIpAddress("0:0:0:0:0:0:0:1"), "blocked_internal")
  assert.equal(classifyIpAddress("0000:0000:0000:0000:0000:0000:0000:0000"), "blocked_internal")
  assert.equal(classifyIpAddress("::ffff:127.0.0.1"), "blocked_internal")
  assert.equal(classifyIpAddress("0:0:0:0:0:ffff:7f00:0001"), "blocked_internal")
  assert.equal(classifyIpAddress("0:0:0:0:0:ffff:a9fe:a9fe"), "blocked_internal")
  assert.equal(classifyIpAddress("169.254.169.254"), "blocked_internal")
  assert.equal(classifyIpAddress("fe80::1"), "blocked_internal")
  assert.equal(classifyIpAddress("100.64.0.1"), "blocked_internal")
  assert.equal(classifyIpAddress("10.0.0.12"), "private_lan")
  assert.equal(classifyIpAddress("192.168.1.50"), "private_lan")
  assert.equal(classifyIpAddress("172.16.5.4"), "private_lan")
  assert.equal(classifyIpAddress("fd12:3456:789a::1"), "private_lan")
  assert.equal(classifyIpAddress("140.82.121.6"), "public")
  assert.equal(classifyIpAddress("2606:4700:4700::1111"), "public")
})

test("blocks unlisted hosts, cloud metadata, and Home Assistant supervisor hosts", async () => {
  const plugin = makePlugin()
  for (const url of [
    "https://evil.example.com/steal",
    "http://169.254.169.254/latest/meta-data/",
    "http://supervisor/core/api/config",
    "http://hassio/info",
  ]) {
    const res = await executePluginHttpRequest(plugin, false, { method: "GET", url })
    assert.equal(res.ok, false)
    if (!res.ok) assert.equal(res.errorCode, "HOST_BLOCKED")
  }
})

test("blocks DNS rebinding to loopback or private IPs for external allowlisted hosts", async () => {
  const plugin = makePlugin()
  const loopbackRes = await executePluginHttpRequest(
    plugin,
    false,
    { method: "GET", url: "https://api.github.com/user" },
    { dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }] },
  )
  assert.equal(loopbackRes.ok, false)
  if (!loopbackRes.ok) assert.equal(loopbackRes.errorCode, "HOST_BLOCKED")

  const lanRes = await executePluginHttpRequest(
    plugin,
    false,
    { method: "GET", url: "https://api.github.com/user" },
    { dnsLookup: async () => [{ address: "192.168.1.25", family: 4 }] },
  )
  assert.equal(lanRes.ok, false)
  if (!lanRes.ok) assert.equal(lanRes.errorCode, "HOST_BLOCKED")
})

test("allows admin-approved $userServer on private LAN while still blocking loopback", async () => {
  const gitea = makePlugin({
    id: "gitea-issues",
    approvedUserServer: "https://git.home.arpa",
    manifest: {
      ...makePlugin().manifest,
      id: "gitea-issues",
      allowedHosts: ["$userServer"],
    },
  })

  const okRes = await executePluginHttpRequest(
    gitea,
    false,
    { method: "GET", url: "https://git.home.arpa/api/v1/user" },
    {
      dnsLookup: async () => [{ address: "192.168.1.40", family: 4 }],
      fetchImpl: async () => new Response(JSON.stringify({ login: "ryan" }), { status: 200 }),
    },
  )
  assert.equal(okRes.ok, true)

  const loopbackBlocked = await executePluginHttpRequest(
    gitea,
    false,
    { method: "GET", url: "https://git.home.arpa/api/v1/user" },
    { dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }] },
  )
  assert.equal(loopbackBlocked.ok, false)
  if (!loopbackBlocked.ok) assert.equal(loopbackBlocked.errorCode, "HOST_BLOCKED")
})

test("injects {{secret:key}} server-side in headers, forbids secrets in URL, and scrubs secret reflection", async () => {
  const plugin = makePlugin()
  const urlSecret = await executePluginHttpRequest(plugin, false, {
    method: "GET",
    url: "https://api.github.com/user?token={{secret:github_token}}",
  })
  assert.equal(urlSecret.ok, false)
  if (!urlSecret.ok) assert.equal(urlSecret.errorCode, "SECRET_IN_URL_FORBIDDEN")

  let capturedAuth = ""
  const res = await executePluginHttpRequest(
    plugin,
    false,
    {
      method: "GET",
      url: "https://api.github.com/user",
      headers: { Authorization: "Bearer {{secret:github_token}}" },
    },
    {
      dnsLookup: async () => [{ address: "140.82.121.6", family: 4 }],
      resolveSecret: async (_id, key) => (key === "github_token" ? "ghp_super_secret_token_999" : null),
      fetchImpl: async (_url, init) => {
        capturedAuth = new Headers(init?.headers).get("authorization") ?? ""
        return new Response(JSON.stringify({ echoed: "ghp_super_secret_token_999" }), { status: 200 })
      },
    },
  )
  assert.equal(res.ok, true)
  assert.equal(capturedAuth, "Bearer ghp_super_secret_token_999")
  if (res.ok) {
    assert.equal(res.data.text.includes("ghp_super_secret_token_999"), false)
    assert.equal(res.data.text.includes("[REDACTED]"), true)
  }
})

test("blocks 302 redirects and Safe Mode requests", async () => {
  const plugin = makePlugin()
  const safeRes = await executePluginHttpRequest(plugin, true, {
    method: "GET",
    url: "https://api.github.com/user",
  })
  assert.equal(safeRes.ok, false)
  if (!safeRes.ok) assert.equal(safeRes.errorCode, "SAFE_MODE_ACTIVE")

  const redirectRes = await executePluginHttpRequest(
    plugin,
    false,
    { method: "GET", url: "https://api.github.com/user" },
    {
      dnsLookup: async () => [{ address: "140.82.121.6", family: 4 }],
      fetchImpl: async () => new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/" } }),
    },
  )
  assert.equal(redirectRes.ok, false)
  if (!redirectRes.ok) assert.equal(redirectRes.errorCode, "REDIRECT_BLOCKED")
})
