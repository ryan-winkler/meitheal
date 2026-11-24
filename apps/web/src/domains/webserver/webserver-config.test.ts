import test from "node:test"
import assert from "node:assert/strict"
import { parsePortSpec as sharedParsePortSpec } from "../../../scripts/port-spec.mjs"
import {
  buildHaAddonOptionsPayload,
  evaluateWebserverSecurity,
  formatPortSummary,
  hydrateWebserverConfig,
  MAX_RESOLVED_PORTS,
  parsePortSpec,
  readWebserverEnvDefaults,
  resolveMcpEndpoints,
  validateBindAddress,
  validateServerName,
  validateTlsMaterial,
  validateWebserverConfigInput,
  validateWebserverUrl,
} from "./webserver-config"

test("parsePortSpec shares single canonical implementation with serve.mjs", () => {
  assert.equal(parsePortSpec, sharedParsePortSpec)
})

test("parsePortSpec supports single port, list, JS array, JSON array string, range, and mixed specs", () => {
  const single = parsePortSpec("8095")
  assert.equal(single.ok, true)
  if (single.ok) {
    assert.deepEqual(single.ports, [8095])
    assert.equal(single.mode, "single")
    assert.equal(single.normalized, "8095")
    assert.equal(single.hasPrivilegedPorts, false)
  }

  const numeric = parsePortSpec(3000)
  assert.equal(numeric.ok, true)
  if (numeric.ok) assert.deepEqual(numeric.ports, [3000])

  const list = parsePortSpec("8095, 3000; 8095")
  assert.equal(list.ok, true)
  if (list.ok) {
    assert.deepEqual(list.ports, [3000, 8095])
    assert.equal(list.mode, "list")
    assert.equal(list.normalized, "3000, 8095")
  }

  const arrayInput = parsePortSpec([8095, 3000])
  assert.equal(arrayInput.ok, true)
  if (arrayInput.ok) {
    assert.deepEqual(arrayInput.ports, [3000, 8095])
    assert.equal(arrayInput.mode, "list")
  }

  const bracketedArray = parsePortSpec("[3000, 8095]")
  assert.equal(bracketedArray.ok, true)
  if (bracketedArray.ok) {
    assert.deepEqual(bracketedArray.ports, [3000, 8095])
  }

  const range = parsePortSpec("3000-3003")
  assert.equal(range.ok, true)
  if (range.ok) {
    assert.deepEqual(range.ports, [3000, 3001, 3002, 3003])
    assert.equal(range.mode, "range")
    assert.equal(range.normalized, "3000-3003")
  }

  const mixed = parsePortSpec("3000, 8095-8097")
  assert.equal(mixed.ok, true)
  if (mixed.ok) {
    assert.deepEqual(mixed.ports, [3000, 8095, 8096, 8097])
    assert.equal(mixed.mode, "mixed")
    assert.equal(mixed.normalized, "3000, 8095-8097")
  }

  // Exact upper boundary (32 ports) succeeds; 33 ports fails
  const maxOk = parsePortSpec(`3000-${3000 + MAX_RESOLVED_PORTS - 1}`)
  assert.equal(maxOk.ok, true)
  if (maxOk.ok) assert.equal(maxOk.ports.length, MAX_RESOLVED_PORTS)

  const overCap = parsePortSpec(`3000-${3000 + MAX_RESOLVED_PORTS}`)
  assert.equal(overCap.ok, false)

  // Valid boundary TCP ports 1 and 65535
  const edges = parsePortSpec("1, 65535")
  assert.equal(edges.ok, true)
  if (edges.ok) {
    assert.deepEqual(edges.ports, [1, 65535])
    assert.equal(edges.hasPrivilegedPorts, true)
  }
})

test("parsePortSpec rejects empty, non-integer, out-of-range, inverted, and control-char inputs", () => {
  assert.equal(parsePortSpec("").ok, false)
  assert.equal(parsePortSpec("[]").ok, false)
  assert.equal(parsePortSpec([]).ok, false)
  assert.equal(parsePortSpec(3000.5).ok, false)
  assert.equal(parsePortSpec("0").ok, false)
  assert.equal(parsePortSpec("65536").ok, false)
  assert.equal(parsePortSpec("3005-3000").ok, false)
  assert.equal(parsePortSpec("3000-3001-3002").ok, false)
  assert.equal(parsePortSpec("abc").ok, false)
  assert.equal(parsePortSpec("3000\u0000").ok, false)
  assert.equal(formatPortSummary([]), "3000")
})

test("validateWebserverUrl normalizes valid HTTP/HTTPS URLs and rejects unsafe schemes or credentials", () => {
  assert.deepEqual(
    validateWebserverUrl("https://meitheal.home.arpa:8095/", "Internal URL"),
    { ok: true, value: "https://meitheal.home.arpa:8095" },
  )
  assert.deepEqual(
    validateWebserverUrl("https://tasks.example.com/meitheal///", "External URL"),
    { ok: true, value: "https://tasks.example.com/meitheal" },
  )
  assert.deepEqual(validateWebserverUrl("   ", "External URL"), { ok: true, value: "" })

  assert.equal(validateWebserverUrl("javascript:alert(1)", "Internal URL").ok, false)
  assert.equal(validateWebserverUrl("data:text/html,<h1>x</h1>", "Internal URL").ok, false)
  assert.equal(validateWebserverUrl("file:///etc/passwd", "Internal URL").ok, false)
  assert.equal(validateWebserverUrl("https://user:pass@example.com", "External URL").ok, false)
  assert.equal(validateWebserverUrl("https://example.com?token=1", "External URL").ok, false)
  assert.equal(validateWebserverUrl("https://example.com#section", "External URL").ok, false)
  assert.equal(validateWebserverUrl("https://example.com\nEvil: 1", "External URL").ok, false)
  assert.equal(validateWebserverUrl(`https://example.com/${"a".repeat(2050)}`, "External URL").ok, false)
  assert.equal(validateWebserverUrl("not-a-url", "Internal URL").ok, false)
})

test("validateBindAddress accepts strict IPv4/IPv6 literals and rejects malformed or injected values", () => {
  assert.deepEqual(validateBindAddress(""), { ok: true, value: "0.0.0.0" })
  assert.deepEqual(validateBindAddress("0.0.0.0"), { ok: true, value: "0.0.0.0" })
  assert.deepEqual(validateBindAddress("127.0.0.1"), { ok: true, value: "127.0.0.1" })
  assert.deepEqual(validateBindAddress("192.168.1.25"), { ok: true, value: "192.168.1.25" })
  assert.deepEqual(validateBindAddress("::"), { ok: true, value: "::" })
  assert.deepEqual(validateBindAddress("::1"), { ok: true, value: "::1" })
  assert.deepEqual(validateBindAddress("2001:db8::1"), { ok: true, value: "2001:db8::1" })

  assert.equal(validateBindAddress("999.1.1.1").ok, false)
  assert.equal(validateBindAddress("01.2.3.4").ok, false)
  assert.equal(validateBindAddress("1:2:3::4::5").ok, false)
  assert.equal(validateBindAddress("evil.host;rm -rf").ok, false)
})

test("validateTlsMaterial validates absolute paths and PEM blocks safely without path traversal", () => {
  assert.deepEqual(validateTlsMaterial("/ssl/fullchain.pem", "certificate"), {
    ok: true,
    value: "/ssl/fullchain.pem",
    format: "path",
  })
  assert.equal(validateTlsMaterial("../etc/passwd", "certificate").ok, false)
  assert.equal(validateTlsMaterial("/ssl/../etc/shadow", "certificate").ok, false)
  assert.equal(validateTlsMaterial("relative/cert.pem", "certificate").ok, false)
  assert.equal(validateTlsMaterial("/ssl/cert.pem\0.txt", "certificate").ok, false)
  assert.equal(validateTlsMaterial("/ssl\\cert.pem", "certificate").ok, false)

  const pemCert = "-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQEF\n-----END CERTIFICATE-----"
  assert.equal(validateTlsMaterial(pemCert, "certificate").ok, true)
  assert.equal(validateTlsMaterial(pemCert, "private_key").ok, false)

  const pemKey = "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEI...\n-----END EC PRIVATE KEY-----"
  assert.equal(validateTlsMaterial(pemKey, "private_key").ok, true)
  assert.equal(validateTlsMaterial("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----", "private_key").ok, false)
  assert.equal(validateTlsMaterial("a".repeat(33_000), "private_key").ok, false)
})

test("validateServerName enforces length and control-character limits", () => {
  assert.deepEqual(validateServerName(""), { ok: true, value: "Meitheal" })
  assert.deepEqual(validateServerName("  Home Hub  "), { ok: true, value: "Home Hub" })
  assert.equal(validateServerName("x".repeat(101)).ok, false)
  assert.equal(validateServerName("Hub\nHeader").ok, false)
})

test("resolveMcpEndpoints prioritizes External > Internal > Current Origin > Port fallback", () => {
  const ext = resolveMcpEndpoints({
    internalUrl: "http://192.168.1.50:3000",
    externalUrl: "https://meitheal.example.com",
    homeAssistantUrl: "https://ha.example.com",
    ports: [3000],
    haConnected: true,
  })
  assert.equal(ext.mcpServerUrl, "https://meitheal.example.com/api/mcp")
  assert.equal(ext.mcpManifestUrl, "https://meitheal.example.com/.well-known/mcp.json")
  assert.equal(ext.source, "external")
  assert.equal(ext.homeAssistantAiUrl, "https://ha.example.com/config/ai")
  assert.equal(ext.homeAssistantMcpIntegrationUrl, "https://ha.example.com/config/ai")
  assert.equal(ext.homeAssistantConnected, true)

  const internal = resolveMcpEndpoints({
    internalUrl: "http://meitheal.local:8095",
    detectedHomeAssistantUrl: "http://homeassistant.local:8123",
    ports: [8095],
    haConnected: true,
  })
  assert.equal(internal.mcpServerUrl, "http://meitheal.local:8095/api/mcp")
  assert.equal(internal.source, "internal")
  assert.equal(internal.homeAssistantAiUrl, "http://homeassistant.local:8123/config/ai")
  assert.equal(internal.homeAssistantMcpIntegrationUrl, "http://homeassistant.local:8123/config/ai")

  const origin = resolveMcpEndpoints({
    currentOrigin: "http://localhost:3000",
    ports: [3000],
  })
  assert.equal(origin.mcpServerUrl, "http://localhost:3000/api/mcp")
  assert.equal(origin.source, "current_origin")

  const fallback = resolveMcpEndpoints({
    ports: [8095],
    tlsEnabled: true,
  })
  assert.equal(fallback.mcpServerUrl, "https://localhost:8095/api/mcp")
  assert.equal(fallback.source, "port_fallback")
  assert.equal(fallback.homeAssistantAiUrl, null)
  assert.equal(fallback.homeAssistantMcpIntegrationUrl, null)
})

test("validateWebserverConfigInput enforces TLS pairing, redaction placeholder handling, and HA options hygiene", () => {
  const missingTls = validateWebserverConfigInput({
    portsSpec: "3000",
    tlsEnabled: true,
    sslCertificate: "/ssl/fullchain.pem",
  }, false)
  assert.equal(missingTls.ok, false)

  // When an existing key is stored, omitting or passing the redacted placeholder keeps it configured
  const keptKey = validateWebserverConfigInput({
    portsSpec: "8095",
    tlsEnabled: true,
    sslCertificate: "/ssl/fullchain.pem",
    sslPrivateKey: "••••••••",
  }, true)
  assert.equal(keptKey.ok, true)
  if (keptKey.ok) {
    assert.equal(keptKey.config.sslPrivateKeyConfigured, true)
    assert.equal(keptKey.newPrivateKey, undefined)
  }

  const valid = validateWebserverConfigInput({
    serverName: "Meitheal Hub",
    internalUrl: "http://meitheal.local:8095",
    externalUrl: "http://insecure.example.com",
    homeAssistantUrl: "https://ha.example.com",
    portsSpec: "443, 8095-8096",
    bindAddress: "0.0.0.0",
    tlsEnabled: false,
  }, false)

  assert.equal(valid.ok, true)
  if (valid.ok) {
    assert.deepEqual(valid.config.ports, [443, 8095, 8096])
    const notices = evaluateWebserverSecurity(valid.config, true)
    assert.equal(notices.some((n) => n.code === "unencrypted_http"), true)
    assert.equal(notices.some((n) => n.code === "external_http"), true)
    assert.equal(notices.some((n) => n.code === "privileged_port"), true)

    // Ensure HA options payload never leaks private key fields
    const payload = buildHaAddonOptionsPayload(valid.config, "https://tasks.example.com/api/mcp")
    assert.deepEqual(payload.ports, [443, 8095, 8096])
    assert.equal("ssl_private_key" in payload, false)
    assert.equal("sslPrivateKey" in payload, false)
  }

  const hydrated = hydrateWebserverConfig({
    webserver_server_name: "Home Server",
    webserver_ports: "3000-3002",
    webserver_tls_enabled: false,
    webserver_ssl_private_key: "redacted-marker",
  })
  assert.deepEqual(hydrated.ports, [3000, 3001, 3002])
  assert.equal(hydrated.serverName, "Home Server")
  assert.equal(hydrated.sslPrivateKeyConfigured, true)
})

test("readWebserverEnvDefaults and hydrateWebserverConfig unify .env, VM, and Connected Services ha_url", () => {
  const envSnapshot = readWebserverEnvDefaults({
    MEITHEAL_PORTS: "3000, 8095",
    MEITHEAL_HOST: "127.0.0.1",
    MEITHEAL_INTERNAL_URL: "http://meitheal.local:3000",
    SITE_URL: "https://tasks.0ii.top",
    HA_BASE_URL: "https://ha.0ii.top",
    MEITHEAL_SERVER_NAME: "Meitheal VM",
    TZ: "Europe/Dublin",
  })
  assert.equal(envSnapshot.ports, "3000, 8095")
  assert.equal(envSnapshot.bindAddress, "127.0.0.1")
  assert.equal(envSnapshot.externalUrl, "https://tasks.0ii.top")
  assert.equal(envSnapshot.sources.ports, "MEITHEAL_PORTS")
  assert.equal(envSnapshot.sources.externalUrl, "SITE_URL")
  assert.equal(envSnapshot.sources.homeAssistantUrl, "HA_BASE_URL")

  // Empty DB inherits unified .env defaults
  const fromEnv = hydrateWebserverConfig({}, {
    env: {
      MEITHEAL_PORTS: "8095-8096",
      HOST: "0.0.0.0",
      MEITHEAL_INTERNAL_URL: "http://meitheal.local:8095",
      SITE_URL: "https://tasks.0ii.top",
      HA_BASE_URL: "https://ha.0ii.top",
    },
  })
  assert.deepEqual(fromEnv.ports, [8095, 8096])
  assert.equal(fromEnv.internalUrl, "http://meitheal.local:8095")
  assert.equal(fromEnv.externalUrl, "https://tasks.0ii.top")
  assert.equal(fromEnv.homeAssistantUrl, "https://ha.0ii.top")

  // Connected Services ha_url overrides env when webserver_home_assistant_url is unset
  const fromHaSetting = hydrateWebserverConfig(
    { ha_url: "https://ha.home.arpa:8123" },
    { env: { HA_BASE_URL: "https://ha.0ii.top" } },
  )
  assert.equal(fromHaSetting.homeAssistantUrl, "https://ha.home.arpa:8123")
})
