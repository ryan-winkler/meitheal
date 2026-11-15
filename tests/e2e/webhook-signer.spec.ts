import dns from "node:dns"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import {
  canonicalizeNetworkHost,
  classifyNetworkHost,
  GrocyAdapter,
  isBlockedOutboundAddress,
  isIpv4TranslationIpv6Host,
  isPrivateHost,
  isPrivateOutboundAddress,
  isPrivateUrl,
  parseWebhookConfig,
  signPayload,
  validateGrocyBaseUrl,
  verifySignature,
} from "../../packages/integration-core/src/index"

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

test.describe("Webhook Signer", () => {
  test("sign and verify round-trip", () => {
    const secret = "test-secret-key-123"
    const payload = JSON.stringify({ eventType: "task.created", payload: { id: 1 } })
    const signature = signPayload(secret, payload)

    expect(signature).toBeTruthy()
    expect(typeof signature).toBe("string")
    expect(signature.length).toBe(64) // SHA-256 hex = 64 chars
    expect(verifySignature(secret, payload, signature)).toBe(true)
  })

  test("detects tampered payload", () => {
    const secret = "test-secret-key-123"
    const payload = JSON.stringify({ eventType: "task.created" })
    const signature = signPayload(secret, payload)
    const tampered = JSON.stringify({ eventType: "task.deleted" })

    expect(verifySignature(secret, tampered, signature)).toBe(false)
  })

  test("detects wrong secret", () => {
    const payload = JSON.stringify({ eventType: "task.created" })
    const signature = signPayload("secret-a", payload)

    expect(verifySignature("secret-b", payload, signature)).toBe(false)
  })

  test("handles empty payload and mismatched signature length", () => {
    const secret = "test-secret"
    const signature = signPayload(secret, "")

    expect(signature).toBeTruthy()
    expect(verifySignature(secret, "", signature)).toBe(true)
    expect(verifySignature(secret, "", "short-sig")).toBe(false)
  })
})

test.describe("Private URL Guard", () => {
  test("rejects localhost", () => {
    expect(isPrivateUrl("http://localhost:3000/webhook")).toBe(true)
    expect(isPrivateHost("localhost")).toBe(true)
    expect(isPrivateHost("localhost...")).toBe(true)
    expect(isPrivateHost("0:0:0:0:0:0:0:1")).toBe(true)
    expect(isPrivateHost("127.1")).toBe(true)
    expect(isPrivateHost("bad host name")).toBe(true)
    expect(isPrivateHost("")).toBe(true)
  })

  test("rejects 127.x.x.x", () => {
    expect(isPrivateUrl("http://127.0.0.1:8080/hook")).toBe(true)
  })

  test("rejects 10.x.x.x", () => {
    expect(isPrivateUrl("http://10.0.0.1/api")).toBe(true)
  })

  test("rejects 192.168.x.x", () => {
    expect(isPrivateUrl("http://192.168.1.1/callback")).toBe(true)
  })

  test("rejects 172.16-31.x.x", () => {
    expect(isPrivateUrl("http://172.16.0.1/hook")).toBe(true)
    expect(isPrivateUrl("http://172.31.255.255/hook")).toBe(true)
  })

  test("rejects IPv6 loopback, private ranges and IPv4-mapped addresses written as URLs", () => {
    for (const url of [
      "http://[::1]:8123/hook",
      "http://[::]/hook",
      "http://[::ffff:127.0.0.1]/hook",
      "http://[::ffff:c0a8:101]/hook",
      "http://[fd12:3456::1]/hook",
      "http://[fc00::1]/hook",
      "http://[fe80::1]/hook",
      "http://[FE90::1]/hook",
      "http://homeassistant.localhost/hook",
      "http://localhost./hook",
    ]) {
      expect(isPrivateUrl(url), url).toBe(true)
    }
  })

  test("allows public IPv6 and names that only resemble private ranges", () => {
    expect(isPrivateUrl("https://[2606:4700::1111]/hook")).toBe(false)
    expect(isPrivateUrl("https://fdroid.example/hook")).toBe(false)
  })

  test("allows public IPs", () => {
    expect(isPrivateUrl("https://example.com/webhook")).toBe(false)
    expect(isPrivateUrl("https://93.184.216.34/hook")).toBe(false)
  })

  test("rejects invalid URLs", () => {
    expect(isPrivateUrl("not-a-url")).toBe(true)
  })

  test("blocks private, mapped, NAT64, zone-ID, metadata and Supervisor hosts across webhook and Grocy URL guards", () => {
    expect(isPrivateHost("   ")).toBe(true)
    expect(isPrivateHost("...")).toBe(true)
    expect(isPrivateHost("::ffff:169.254.169.254%eth0")).toBe(true)
    expect(isPrivateHost("localhost@8.8.8.8")).toBe(true)
    expect(isPrivateHost("8.8.8.8/127.0.0.1")).toBe(true)
    expect(isPrivateHost("8.8.8.8?@127.0.0.1")).toBe(true)
    expect(isPrivateHost("8.8.8.8#@127.0.0.1")).toBe(true)
    expect(isPrivateHost("8.8.8.8:8080")).toBe(true)
    expect(isPrivateHost("[not-ipv6]")).toBe(true)
    expect(isPrivateHost("[::ffff:8.8.8.8]")).toBe(true)
    expect(isPrivateHost("[::ffff:0:8.8.8.8]")).toBe(true)
    expect(isPrivateHost("[64:ff9b::8.8.8.8]")).toBe(true)
    expect(isPrivateHost("[2002:0808:0808::1]")).toBe(true)
    expect(isPrivateHost("[2001:470:1:1:0:5efe:8.8.8.8]")).toBe(true)
    expect(canonicalizeNetworkHost("localhost@8.8.8.8")).toBeNull()
    expect(canonicalizeNetworkHost("%eth0")).toBeNull()
    expect(canonicalizeNetworkHost("...")).toBeNull()
    expect(isIpv4TranslationIpv6Host("not:valid:ipv6")).toBe(true)
    expect(isPrivateUrl("ftp://example.com/hook")).toBe(true)
    expect(classifyNetworkHost("0x7f.1")).toBe("unconditional")
    expect(classifyNetworkHost("127.1..")).toBe("unconditional")
    expect(classifyNetworkHost("0x7f.1..")).toBe("unconditional")
    expect(classifyNetworkHost("2852039166..")).toBe("unconditional")
    expect(classifyNetworkHost("[fd00::0:5efe:169.254.169.254]")).toBe("unconditional")
    const prevSupUrl = process.env.SUPERVISOR_URL
    try {
      process.env.SUPERVISOR_URL = "http://custom-sup.internal:8123"
      expect(classifyNetworkHost("custom-sup.internal")).toBe("unconditional")
      expect(validateGrocyBaseUrl("http://custom-sup.internal:8123").ok).toBe(false)
    } finally {
      if (prevSupUrl === undefined) delete process.env.SUPERVISOR_URL
      else process.env.SUPERVISOR_URL = prevSupUrl
    }
    expect(classifyNetworkHost("   ")).toBe("unconditional")
    expect(classifyNetworkHost("...")).toBe("unconditional")
    expect(classifyNetworkHost("%eth0")).toBe("unconditional")
    expect(classifyNetworkHost("localhost@8.8.8.8")).toBe("unconditional")
    expect(classifyNetworkHost("bad host name")).toBe("unconditional")
    expect(isBlockedOutboundAddress("[2001:470:1:1:0:5efe:8.8.8.8]")).toBe(true)
    expect(isBlockedOutboundAddress("[2001:470:1:1:200:5efe:127.0.0.1]")).toBe(true)
    expect(isBlockedOutboundAddress("[64:ff9b:2::1]")).toBe(true)
    expect(isBlockedOutboundAddress("100.64.0.1")).toBe(false)
    expect(isPrivateOutboundAddress("100.64.0.1")).toBe(true)
    expect(isPrivateOutboundAddress("[64:ff9b::100.64.0.1]")).toBe(true)
    expect(validateGrocyBaseUrl("https://grocy.example.com?foo=bar").ok).toBe(false)
    expect(validateGrocyBaseUrl("https://grocy.example.com#section").ok).toBe(false)
    for (const url of [
      "http://[::ffff:127.0.0.1]:8080/mapped",
      "http://[::ffff:0:169.254.169.254]/latest",
      "http://[::127.0.0.1]/hook",
      "http://[::8.8.8.8]/hook",
      "http://[::169.254.169.254]/latest",
      "http://[64:ff9b::169.254.169.254]/latest",
      "http://[64:ff9b:1::169.254.169.254]/latest",
      "http://[64:ff9b:1:a9fe:a9:fe00:808:808]/latest",
      "http://[64:ff9b:2::1]/latest",
      "http://[2002:a9fe:a9fe::1]/latest",
      "http://[2001:470:1:1:0:5efe:169.254.169.254]/latest",
      "http://[2001:470:1:1:200:5efe:127.0.0.1]/hook",
      "http://[2001::1]/hook",
      "http://[2001:2::1]/hook",
      "http://[2001:20::1]/hook",
      "http://[2001:db8::1]/hook",
      "http://[3fff::1]/hook",
      "http://[2620:4f:8000::1]/hook",
      "http://[ff02::1]/hook",
      "http://127.0.0.2/hook",
      "http://100.64.0.1/hook",
      "http://100.100.100.100/hook",
      "http://192.0.0.1/hook",
      "http://192.0.2.1/hook",
      "http://198.18.0.1/hook",
      "http://198.51.100.1/hook",
      "http://203.0.113.1/hook",
      "http://224.0.0.1/hook",
      "http://255.255.255.255/hook",
      "http://[fd00::1]/hook",
      "http://[fd00:ec2::254]/latest",
      "http://169.254.169.254/latest",
      "http://100.100.100.200/latest",
      "http://metadata/computeMetadata",
      "http://metadata.google.internal/computeMetadata",
      "http://sub.metadata.google.internal./computeMetadata",
      "http://instance-data.ec2.internal/latest",
      "http://sub.instance-data/latest",
      "http://sub.ec2.internal/latest",
      "http://supervisor/core/api",
      "http://supervisor/api/hassio_ingress/abc123",
      "http://supervisor.internal/core/api",
      "http://core.hass.io/api",
    ]) {
      expect(isPrivateUrl(url), `webhook-url:${url}`).toBe(true)
      expect(isPrivateHost(new URL(url).hostname), `webhook:${url}`).toBe(true)
      expect(validateGrocyBaseUrl(url).ok, `grocy:${url}`).toBe(false)
    }
    for (const url of ["http://a0d7b954-grocy/api", "https://grocy.home.internal/api", "https://example.com/hook"]) {
      expect(isPrivateHost(new URL(url).hostname), `webhook:${url}`).toBe(false)
      expect(validateGrocyBaseUrl(url).ok, `grocy:${url}`).toBe(true)
    }
  })

  test("GrocyAdapter and POST /api/grocy/test reject blocked URLs and report HTTP 3xx with retryable: false instead of following redirects", async () => {
    const hits: string[] = []
    let mode: "redirect" | "ok" = "redirect"
    const originalLookup = dns.lookup
    let server: Server | undefined
    try {
      server = createServer((req, res) => {
        hits.push(req.url ?? "")
        if (mode === "redirect" && req.url === "/api/system/info") {
          res.writeHead(302, { location: "/redirected" })
          res.end()
          return
        }
        if (req.url === "/api/system/info") {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ grocy_version_info: { Version: "4.0.0", ReleaseDate: "2026-01-01" } }))
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end("[]")
      })
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
      const port = (server.address() as AddressInfo).port
      const adapter = new GrocyAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: "test-key",
        redirect: "manual",
      })
      const result = await adapter.getSystemInfo()
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).toContain("HTTP 302")
        expect(result.retryable).toBe(false)
      }
      expect(hits).toEqual(["/api/system/info"])

      const { POST } = await import("../../apps/web/src/pages/api/grocy/test")
      for (const badBody of ["null", JSON.stringify({ url: 12345 }), JSON.stringify({ url: "https://grocy.example.com", api_key: 12345 })]) {
        const invalidRes = await POST({
          locals: { hassIsAdmin: true },
          request: new Request("http://localhost/api/grocy/test", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: badBody,
          }),
        } as unknown as Parameters<typeof POST>[0])
        expect(invalidRes.status, badBody).toBe(400)
      }
      for (const badUrl of ["http://metadata.google.internal/", "http://instance-data.ec2.internal/", "http://127.0.0.1/"]) {
        const badRes = await POST({
          locals: { hassIsAdmin: true },
          request: new Request("http://localhost/api/grocy/test", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: badUrl, api_key: "test-key" }),
          }),
        } as unknown as Parameters<typeof POST>[0])
        expect(badRes.status, badUrl).toBe(400)
      }

      dns.lookup = ((hostname: string, options: unknown, cb?: unknown) => {
        const done = (typeof options === "function" ? options : cb) as (
          err: NodeJS.ErrnoException | null,
          addr: string | dns.LookupAddress[],
          fam?: number,
        ) => void
        const all = typeof options === "object" && options !== null && "all" in options && Boolean((options as { all?: boolean }).all)
        if (hostname === "supervisor") {
          done(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }), "")
          return
        }
        if (hostname === "rebind-meta.grocy.internal") {
          if (all) done(null, [{ address: "169.254.169.254", family: 4 }])
          else done(null, "169.254.169.254", 4)
          return
        }
        if (hostname === "rebind-sup.grocy.internal") {
          if (all) done(null, [{ address: "172.30.32.2", family: 4 }])
          else done(null, "172.30.32.2", 4)
          return
        }
        if (hostname === "grocy.home.internal") {
          if (all) done(null, [{ address: "127.0.0.1", family: 4 }])
          else done(null, "127.0.0.1", 4)
          return
        }
        return (originalLookup as (...args: unknown[]) => unknown)(hostname, options, cb)
      }) as typeof dns.lookup

      // Connect-time DNS rebinding to metadata or Supervisor IP is blocked before socket connect
      for (const rebindHost of ["rebind-meta.grocy.internal", "rebind-sup.grocy.internal"]) {
        const rebindAdapter = new GrocyAdapter({
          baseUrl: `http://${rebindHost}:${port}`,
          apiKey: "test-key",
        })
        const rebindRes = await rebindAdapter.getSystemInfo()
        expect(rebindRes.ok, rebindHost).toBe(false)
        if (!rebindRes.ok) {
          expect(rebindRes.errorCode).toBe("invalid_request")
          expect(rebindRes.retryable).toBe(false)
        }
      }

      hits.length = 0
      const redirRes = await POST({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/grocy/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: `http://grocy.home.internal:${port}`, api_key: "test-key" }),
        }),
      } as unknown as Parameters<typeof POST>[0])
      expect(redirRes.status).toBe(200)
      const redirBody = (await redirRes.json()) as { ok: boolean; error: string; retryable: boolean }
      expect(redirBody.ok).toBe(false)
      expect(redirBody.retryable).toBe(false)
      expect(redirBody.error).toContain("HTTP 302")
      expect(hits).toEqual(["/api/system/info"])

      mode = "ok"
      const okRes = await POST({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/grocy/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: `http://grocy.home.internal:${port}`, api_key: "test-key" }),
        }),
      } as unknown as Parameters<typeof POST>[0])
      expect(okRes.status).toBe(200)
      const okBody = (await okRes.json()) as { ok: boolean; version?: string }
      expect(okBody.ok).toBe(true)
      expect(okBody.version).toBe("4.0.0")
    } finally {
      dns.lookup = originalLookup
      await closeServer(server)
    }
  })

  test("Supervisor Grocy auto-detection and legacy ingress URL migration resolve direct container URLs while blocking arbitrary Supervisor paths", async () => {
    const prevDb = process.env.MEITHEAL_DB_URL
    const prevSup = process.env.SUPERVISOR_TOKEN
    const originalFetch = globalThis.fetch
    const originalLookup = dns.lookup
    let dir: string | undefined
    let server: Server | undefined
    let db: ReturnType<typeof import("../../apps/web/src/domains/tasks")["getPersistenceClient"]> | undefined
    let resetPersistence: (() => void) | undefined

    try {
      dir = await mkdtemp(join(tmpdir(), "meitheal-grocy-supervisor-"))
      server = createServer((req, res) => {
        if (req.url === "/api/system/info") {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ grocy_version_info: { Version: "4.2.0", ReleaseDate: "2026-02-01" } }))
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end("[]")
      })
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
      const port = (server.address() as AddressInfo).port

      const { ensureSchema, getPersistenceClient, resetPersistenceForTests } = await import(
        "../../apps/web/src/domains/tasks"
      )
      resetPersistence = resetPersistenceForTests
      const {
        createGrocyClient,
        isLegacySupervisorIngressUrl,
        resolveSupervisorGrocyAddon,
        resolveSupervisorGrocySlugForUrl,
      } = await import("../../apps/web/src/lib/grocy-client")
      const { isBrowserReachableGrocyUrl, normalizeBrowserReachableGrocyUrl } = await import(
        "../../apps/web/src/lib/grocy-url-ui"
      )
      const { GET: getSettings, PUT: putSettings } = await import("../../apps/web/src/pages/api/grocy/settings")
      const { POST: postAutoKey } = await import("../../apps/web/src/pages/api/grocy/auto-key")
      const { POST: postTest } = await import("../../apps/web/src/pages/api/grocy/test")

      process.env.MEITHEAL_DB_URL = `file:${join(dir, "tasks.db")}`
      process.env.SUPERVISOR_TOKEN = "sup-token-test"
      resetPersistenceForTests()

      dns.lookup = ((hostname: string, options: unknown, cb?: unknown) => {
        const done = (typeof options === "function" ? options : cb) as (
          err: NodeJS.ErrnoException | null,
          addr: string | dns.LookupAddress[],
          fam?: number,
        ) => void
        const all = typeof options === "object" && options !== null && "all" in options && Boolean((options as { all?: boolean }).all)
        if (hostname === "supervisor") {
          done(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }), "")
          return
        }
        if (hostname === "a0d7b954-grocy" || hostname === "grocy.example.com") {
          if (all) done(null, [{ address: hostname === "grocy.example.com" ? "93.184.216.34" : "127.0.0.1", family: 4 }])
          else done(null, hostname === "grocy.example.com" ? "93.184.216.34" : "127.0.0.1", 4)
          return
        }
        return (originalLookup as (...args: unknown[]) => unknown)(hostname, options, cb)
      }) as typeof dns.lookup

      let infoPayload: Record<string, unknown> = { hostname: "a0d7b954-grocy", ingress_port: port }
      const supervisorProxyHits: string[] = []
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (target === "http://supervisor/addons") {
          return Response.json({
            data: {
              addons: [
                { slug: "other_grocy", state: "started", ingress_url: "/api/hassio_ingress/tok_other" },
                { slug: "a0d7b954_grocy", state: "started", ingress_url: "/api/hassio_ingress/tok_1" },
              ],
            },
          })
        }
        if (target === "http://supervisor/addons/other_grocy/info") {
          return Response.json({
            data: { hostname: "other-grocy", ingress_port: 8099, network: { "80/tcp": 9192 } },
          })
        }
        if (target === "http://supervisor/addons/a0d7b954_grocy/info") {
          return Response.json({ data: infoPayload })
        }
        if (target === "http://supervisor/addons/a0d7b954_grocy/proxy/api/objects/api_keys") {
          supervisorProxyHits.push(target)
          return Response.json({ created_object_id: "auto-grocy-key-1234" })
        }
        if (target === "https://grocy.example.com/api/objects/api_keys") {
          return Response.json({ created_object_id: "external-grocy-key-9999" })
        }
        if (target === "https://grocy.example.com/html/api/objects/api_keys") {
          return new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } })
        }
        if (target.startsWith("http://supervisor")) {
          throw new Error(`Unexpected direct Supervisor fetch: ${target}`)
        }
        return originalFetch(input, init)
      }) as typeof fetch

      for (const badAutoBody of ["null", "[]", JSON.stringify({ url: 12345 })]) {
        const badAuto = await postAutoKey({
          locals: { hassIsAdmin: true },
          request: new Request("http://localhost/api/grocy/auto-key", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: badAutoBody,
          }),
        } as unknown as Parameters<typeof postAutoKey>[0])
        expect(badAuto.status, badAutoBody).toBe(400)
      }
      expect(isLegacySupervisorIngressUrl("http://supervisor/api/hassio_ingress/tok_1")).toBe(true)
      expect(isLegacySupervisorIngressUrl("/api/hassio_ingress/tok_1")).toBe(true)
      expect(isLegacySupervisorIngressUrl("http://supervisor/core/api")).toBe(false)
      expect(isLegacySupervisorIngressUrl("not-a-url")).toBe(false)

      expect(isBrowserReachableGrocyUrl("http://grocyserver:8080")).toBe(true)
      expect(normalizeBrowserReachableGrocyUrl("http://grocyserver:8080")).toBe("http://grocyserver:8080/")
      expect(isBrowserReachableGrocyUrl("https://[2606:4700::1111]/")).toBe(true)
      expect(isBrowserReachableGrocyUrl("https://grocy.home.internal")).toBe(true)
      expect(isBrowserReachableGrocyUrl("javascript:alert(1)")).toBe(false)
      expect(normalizeBrowserReachableGrocyUrl("javascript:alert(1)")).toBeNull()
      expect(normalizeBrowserReachableGrocyUrl("   ")).toBeNull()
      expect(isBrowserReachableGrocyUrl("http://a0d7b954-grocy")).toBe(false)
      expect(isBrowserReachableGrocyUrl("http://local-grocy:8080")).toBe(false)
      expect(isBrowserReachableGrocyUrl("http://supervisor/api/hassio_ingress/tok_1")).toBe(false)
      expect(isBrowserReachableGrocyUrl("/api/hassio_ingress/tok_1")).toBe(false)
      expect(isBrowserReachableGrocyUrl("not-a-url")).toBe(false)

      // Default auto-detect (first started Grocy add-on prefers 80/tcp over ingress_port 8099)
      const firstDetected = await resolveSupervisorGrocyAddon()
      expect(firstDetected).toEqual({ slug: "other_grocy", url: "http://other-grocy" })

      // Matching ingress_url selects the exact saved Grocy add-on instance, never switching to other_grocy
      const matchedDetected = await resolveSupervisorGrocyAddon("http://supervisor/api/hassio_ingress/tok_1")
      expect(matchedDetected).toEqual({ slug: "a0d7b954_grocy", url: `http://a0d7b954-grocy:${port}` })
      expect(await resolveSupervisorGrocyAddon("http://supervisor/api/hassio_ingress/unknown_tok")).toBeNull()
      expect(await resolveSupervisorGrocySlugForUrl(`http://a0d7b954-grocy:${port}`)).toBe("a0d7b954_grocy")
      expect(await resolveSupervisorGrocySlugForUrl("http://a0d7b954-grocy:9999")).toBeNull()
      expect(await resolveSupervisorGrocySlugForUrl(`http://a0d7b954-grocy:${port}/subpath`)).toBeNull()
      expect(await resolveSupervisorGrocySlugForUrl("not-a-valid-url")).toBeNull()
      expect(await resolveSupervisorGrocySlugForUrl("https://grocy.example.com")).toBeNull()

      // Non-80 tcp port mapping, null host port (direct access disabled), and default port-80 fallback on add-on info
      infoPayload = { hostname: "a0d7b954-grocy", network: { "9192/tcp": 9192 } }
      expect(await resolveSupervisorGrocyAddon("/api/hassio_ingress/tok_1")).toEqual({
        slug: "a0d7b954_grocy",
        url: "http://a0d7b954-grocy:9192",
      })
      infoPayload = { hostname: "a0d7b954-grocy", ingress_port: 8099, network: { "80/tcp": null } }
      expect(await resolveSupervisorGrocyAddon("/api/hassio_ingress/tok_1")).toEqual({
        slug: "a0d7b954_grocy",
        url: "http://a0d7b954-grocy",
      })
      infoPayload = { hostname: "a0d7b954-grocy" }
      expect(await resolveSupervisorGrocyAddon("/api/hassio_ingress/tok_1")).toEqual({
        slug: "a0d7b954_grocy",
        url: "http://a0d7b954-grocy",
      })

      // Direct 80/tcp mapping takes precedence over ingress_port on the matched add-on too
      infoPayload = { hostname: "a0d7b954-grocy", ingress_port: 8099, network: { "80/tcp": 9192 } }
      expect(await resolveSupervisorGrocyAddon("/api/hassio_ingress/tok_1")).toEqual({
        slug: "a0d7b954_grocy",
        url: "http://a0d7b954-grocy",
      })
      infoPayload = { hostname: "a0d7b954-grocy", ingress_port: port }

      // Auto-key saves direct container URL (never http://supervisor/*)
      supervisorProxyHits.length = 0
      const autoRes = await postAutoKey({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/grocy/auto-key", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "/api/hassio_ingress/tok_1" }),
        }),
      } as unknown as Parameters<typeof postAutoKey>[0])
      const autoJson = (await autoRes.json()) as { ok: boolean; url?: string }
      expect(autoJson.ok).toBe(true)
      expect(autoJson.url).toBe(`http://a0d7b954-grocy:${port}`)
      expect(supervisorProxyHits).toEqual([
        "http://supervisor/addons/a0d7b954_grocy/proxy/api/objects/api_keys",
      ])

      // External URL on auto-key must NOT proxy to a0d7b954_grocy via Supervisor
      supervisorProxyHits.length = 0
      const extAutoRes = await postAutoKey({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/grocy/auto-key", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://grocy.example.com" }),
        }),
      } as unknown as Parameters<typeof postAutoKey>[0])
      const extAutoJson = (await extAutoRes.json()) as { ok: boolean; url?: string }
      expect(extAutoJson.ok).toBe(true)
      expect(extAutoJson.url).toBe("https://grocy.example.com")
      expect(supervisorProxyHits).toEqual([])

      // Non-JSON 200 body on auto-key returns self-service { ok: false } instead of HTTP 500
      const htmlAutoRes = await postAutoKey({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/grocy/auto-key", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://grocy.example.com/html" }),
        }),
      } as unknown as Parameters<typeof postAutoKey>[0])
      expect(htmlAutoRes.status).toBe(200)
      expect(((await htmlAutoRes.json()) as { ok: boolean }).ok).toBe(false)

      // Seed RAW unquoted pre-PR auto-key values ("http://supervisor/..." and numeric "1") to verify
      // SettingsRepository.getByKey, createGrocyClient, GET /api/grocy/settings, and POST /api/grocy/test upgrade safely
      await ensureSchema()
      db = getPersistenceClient()
      await db.execute({
        sql: "UPDATE settings SET value = ?, updated_at = ? WHERE key = 'grocy_url'",
        args: ["http://supervisor/api/hassio_ingress/tok_1", Date.now()],
      })
      await db.execute({
        sql: "UPDATE settings SET value = ?, updated_at = ? WHERE key = 'grocy_api_key'",
        args: ["1", Date.now()],
      })
      const client = await createGrocyClient()
      expect(client).not.toBeNull()
      const sys = await client!.getSystemInfo()
      expect(sys.ok).toBe(true)

      await db.execute({
        sql: "UPDATE settings SET value = ?, updated_at = ? WHERE key = 'grocy_url'",
        args: ["http://supervisor/api/hassio_ingress/tok_1", Date.now()],
      })
      const getRes = await getSettings({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/grocy/settings"),
      } as unknown as Parameters<typeof getSettings>[0])
      const getJson = (await getRes.json()) as {
        ok: boolean
        settings: { grocy_url?: string; grocy_api_key?: unknown; grocy_api_key_set?: boolean; grocy_api_key_masked?: string }
      }
      expect(getRes.status).toBe(200)
      expect(getJson.settings.grocy_url).toBe(`http://a0d7b954-grocy:${port}`)
      expect(getJson.settings.grocy_api_key).toBeUndefined()
      expect(getJson.settings.grocy_api_key_set).toBe(true)
      expect(getJson.settings.grocy_api_key_masked).toBe("••••")

      // Unmatched legacy ingress token does NOT overwrite with other_grocy and does NOT leak http://supervisor/*
      await db.execute({
        sql: "UPDATE settings SET value = ?, updated_at = ? WHERE key = 'grocy_url'",
        args: ["http://supervisor/api/hassio_ingress/unmatched_tok", Date.now()],
      })
      const getUnmatched = await getSettings({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/grocy/settings"),
      } as unknown as Parameters<typeof getSettings>[0])
      const getUnmatchedJson = (await getUnmatched.json()) as { ok: boolean; settings: { grocy_url?: string } }
      expect(getUnmatchedJson.settings.grocy_url).toBeUndefined()

      // PUT /api/grocy/settings is atomic on validation failure (never writes earlier keys when a later key fails)
      const putAtomicFail = await putSettings({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/grocy/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grocy_url: "https://atomic-should-not-save.example.com",
            grocy_sync_mode: "invalid-mode",
          }),
        }),
      } as unknown as Parameters<typeof putSettings>[0])
      expect(putAtomicFail.status).toBe(400)
      const urlRowAfterFail = await db.execute("SELECT value FROM settings WHERE key = 'grocy_url'")
      expect(String(urlRowAfterFail.rows[0]?.value)).not.toContain("atomic-should-not-save")

      const putNonStringKey = await putSettings({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/grocy/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grocy_api_key: 12345 }),
        }),
      } as unknown as Parameters<typeof putSettings>[0])
      expect(putNonStringKey.status).toBe(400)

      const putLegacy = await putSettings({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/grocy/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grocy_url: "http://supervisor/api/hassio_ingress/tok_1" }),
        }),
      } as unknown as Parameters<typeof putSettings>[0])
      expect(putLegacy.status).toBe(200)

      const putUnmatched = await putSettings({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/grocy/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grocy_url: "http://supervisor/api/hassio_ingress/unmatched_tok" }),
        }),
      } as unknown as Parameters<typeof putSettings>[0])
      expect(putUnmatched.status).toBe(400)

      // Arbitrary Supervisor API paths and non-string grocy_url remain strictly rejected
      const putBad = await putSettings({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/grocy/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grocy_url: "http://supervisor/core/api" }),
        }),
      } as unknown as Parameters<typeof putSettings>[0])
      expect(putBad.status).toBe(400)

      const putNonString = await putSettings({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/grocy/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grocy_url: 12345 }),
        }),
      } as unknown as Parameters<typeof putSettings>[0])
      expect(putNonString.status).toBe(400)

      // Additional validation branches on /api/grocy/settings, /api/grocy/test, and createGrocyClient
      for (const badSettingsBody of [
        "{bad",
        "[]",
        JSON.stringify({ grocy_url: "   " }),
        JSON.stringify({ grocy_sync_interval: -5 }),
        JSON.stringify({ grocy_sync_enabled: "yes" }),
      ]) {
        const res = await putSettings({
          locals: { hassIsAdmin: true },
          request: new Request("http://localhost/api/grocy/settings", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: badSettingsBody,
          }),
        } as unknown as Parameters<typeof putSettings>[0])
        expect(res.status, badSettingsBody).toBe(400)
      }

      // Clear grocy_url (""), then save with grocy_sync_enabled: true and no grocy_url -> auto-populates from Supervisor
      const clearUrlRes = await putSettings({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/grocy/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grocy_url: "", grocy_api_key: "secret-key-5678" }),
        }),
      } as unknown as Parameters<typeof putSettings>[0])
      expect(clearUrlRes.status).toBe(200)
      expect(await createGrocyClient()).toBeNull()

      const autoPopRes = await putSettings({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/grocy/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grocy_sync_mode: "bidirectional",
            grocy_sync_interval: 0,
            grocy_sync_enabled: true,
          }),
        }),
      } as unknown as Parameters<typeof putSettings>[0])
      expect(autoPopRes.status).toBe(200)
      const autoPopJson = (await autoPopRes.json()) as { ok: boolean; url?: string }
      expect(autoPopJson.url).toBe("http://other-grocy")

      // GET /api/grocy/settings masks keys > 4 chars with trailing 4 chars
      const maskedRes = await getSettings({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/grocy/settings"),
      } as unknown as Parameters<typeof getSettings>[0])
      const maskedJson = (await maskedRes.json()) as { settings: { grocy_api_key_masked?: string } }
      expect(maskedJson.settings.grocy_api_key_masked).toBe("••••5678")

      // JSON-encoded invalid grocy_url causes createGrocyClient to warn & return null
      await db.execute({
        sql: "UPDATE settings SET value = ?, updated_at = ? WHERE key = 'grocy_url'",
        args: [JSON.stringify("http://127.0.0.1:9283"), Date.now()],
      })
      expect(await createGrocyClient()).toBeNull()
      await db.execute({
        sql: "UPDATE settings SET value = ?, updated_at = ? WHERE key = 'grocy_url'",
        args: [JSON.stringify(`http://a0d7b954-grocy:${port}`), Date.now()],
      })
      expect(await createGrocyClient()).not.toBeNull()

      for (const badTestBody of [
        "{bad",
        "[]",
        JSON.stringify({ url: 123 }),
        JSON.stringify({ api_key: 123 }),
        JSON.stringify({ url: "http://supervisor/api/hassio_ingress/unmatched_tok", api_key: "k" }),
        JSON.stringify({ url: "http://127.0.0.1:9283", api_key: "k" }),
        JSON.stringify({}),
      ]) {
        const res = await postTest({
          locals: { hassIsAdmin: true },
          request: new Request("http://localhost/api/grocy/test", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: badTestBody,
          }),
        } as unknown as Parameters<typeof postTest>[0])
        expect(res.status, badTestBody).toBe(400)
      }

      const testAuto = await postTest({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/grocy/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "/api/hassio_ingress/tok_1", auto_detected: true }),
        }),
      } as unknown as Parameters<typeof postTest>[0])
      expect(testAuto.status).toBe(200)
      expect(((await testAuto.json()) as { ok: boolean }).ok).toBe(true)

      // Generic settings GET/PUT and settings import also enforce validateGrocyBaseUrl and migrate/skip legacy ingress URLs
      const { GET: getGenericSettings, PUT: putGenericSetting } = await import(
        "../../apps/web/src/pages/api/settings"
      )
      const { POST: postImportSettings } = await import("../../apps/web/src/pages/api/import/settings")

      await db.execute({
        sql: "UPDATE settings SET value = ?, updated_at = ? WHERE key = 'grocy_url'",
        args: ["http://supervisor/api/hassio_ingress/tok_1", Date.now()],
      })
      const genericGetKey = await getGenericSettings({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/settings?key=grocy_url"),
        url: new URL("http://localhost/api/settings?key=grocy_url"),
      } as unknown as Parameters<typeof getGenericSettings>[0])
      expect(((await genericGetKey.json()) as { value: string | null }).value).toBe(`http://a0d7b954-grocy:${port}`)

      await db.execute({
        sql: "UPDATE settings SET value = ?, updated_at = ? WHERE key = 'grocy_url'",
        args: ["http://supervisor/api/hassio_ingress/unmatched_tok", Date.now()],
      })
      const genericGetKeyUnmatched = await getGenericSettings({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/settings?key=grocy_url"),
        url: new URL("http://localhost/api/settings?key=grocy_url"),
      } as unknown as Parameters<typeof getGenericSettings>[0])
      expect(((await genericGetKeyUnmatched.json()) as { value: string | null }).value).toBeNull()

      const genericGetAllUnmatched = await getGenericSettings({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/settings"),
        url: new URL("http://localhost/api/settings"),
      } as unknown as Parameters<typeof getGenericSettings>[0])
      expect(((await genericGetAllUnmatched.json()) as { grocy_url?: string }).grocy_url).toBeUndefined()

      await db.execute({
        sql: "UPDATE settings SET value = ?, updated_at = ? WHERE key = 'grocy_url'",
        args: ["http://supervisor/api/hassio_ingress/tok_1", Date.now()],
      })
      const genericGetAll = await getGenericSettings({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/settings"),
        url: new URL("http://localhost/api/settings"),
      } as unknown as Parameters<typeof getGenericSettings>[0])
      const genericGetAllJson = (await genericGetAll.json()) as { grocy_url?: string }
      expect(genericGetAllJson.grocy_url).toBe(`http://a0d7b954-grocy:${port}`)

      const genericLegacyOk = await putGenericSetting({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: "grocy_url", value: "http://supervisor/api/hassio_ingress/tok_1" }),
        }),
      } as unknown as Parameters<typeof putGenericSetting>[0])
      expect(genericLegacyOk.status).toBe(200)

      for (const badGenericVal of [123, "http://supervisor/api/hassio_ingress/unmatched_tok", "http://169.254.169.254/latest"]) {
        const res = await putGenericSetting({
          locals: { hassIsAdmin: true },
          request: new Request("http://localhost/api/settings", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ key: "grocy_url", value: badGenericVal }),
          }),
        } as unknown as Parameters<typeof putGenericSetting>[0])
        expect(res.status).toBe(400)
      }

      const genericBlank = await putGenericSetting({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: "grocy_url", value: "   " }),
        }),
      } as unknown as Parameters<typeof putGenericSetting>[0])
      expect(genericBlank.status).toBe(200)

      const genericOk = await putGenericSetting({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: "grocy_url", value: "https://grocy.example.com/" }),
        }),
      } as unknown as Parameters<typeof putGenericSetting>[0])
      expect(genericOk.status).toBe(200)

      delete process.env.SUPERVISOR_TOKEN
      const autoNoSup = await postAutoKey({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/grocy/auto-key", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      } as unknown as Parameters<typeof postAutoKey>[0])
      expect(autoNoSup.status).toBe(400)

      const autoBadUrl = await postAutoKey({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/grocy/auto-key", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "http://127.0.0.1:9283" }),
        }),
      } as unknown as Parameters<typeof postAutoKey>[0])
      expect(autoBadUrl.status).toBe(400)

      const importValidUrl = await postImportSettings({
        locals: { hassIsAdmin: true, hassUserId: "admin-1" },
        request: new Request("http://localhost/api/import/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grocy_url: "https://grocy.example.com/" }),
        }),
      } as unknown as Parameters<typeof postImportSettings>[0])
      expect(importValidUrl.status).toBe(200)

      const importBlankUrl = await postImportSettings({
        locals: { hassIsAdmin: true, hassUserId: "admin-1" },
        request: new Request("http://localhost/api/import/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grocy_url: "   " }),
        }),
      } as unknown as Parameters<typeof postImportSettings>[0])
      expect(importBlankUrl.status).toBe(200)

      const importNonString = await postImportSettings({
        locals: { hassIsAdmin: true, hassUserId: "admin-1" },
        request: new Request("http://localhost/api/import/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grocy_url: 12345 }),
        }),
      } as unknown as Parameters<typeof postImportSettings>[0])
      expect(importNonString.status).toBe(400)
      const importBad = await postImportSettings({
        locals: { hassIsAdmin: true, hassUserId: "admin-1" },
        request: new Request("http://localhost/api/import/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grocy_url: "http://supervisor/core/api" }),
        }),
      } as unknown as Parameters<typeof postImportSettings>[0])
      expect(importBad.status).toBe(400)

      // Unresolvable legacy Supervisor ingress URL in a backup skips grocy_url with a warning instead of failing the backup restore
      const importLegacyBackup = await postImportSettings({
        locals: { hassIsAdmin: true, hassUserId: "admin-1" },
        request: new Request("http://localhost/api/import/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            locale: "en",
            grocy_url: "http://supervisor/api/hassio_ingress/tok_1",
          }),
        }),
      } as unknown as Parameters<typeof postImportSettings>[0])
      expect(importLegacyBackup.status).toBe(200)
      expect(((await importLegacyBackup.json()) as { success: boolean }).success).toBe(true)

      // When saving generated auto-key fails, auto-key returns HTTP 500 instead of 200 OK with a masked lost key
      db.close()
      db = undefined
      process.env.MEITHEAL_DB_URL = `file:${join(dir, "tasks.db", "not-a-directory", "fail.db")}`
      resetPersistenceForTests()
      const saveFailRes = await postAutoKey({
        locals: { hassIsAdmin: true },
        request: new Request("http://localhost/api/grocy/auto-key", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://grocy.example.com" }),
        }),
      } as unknown as Parameters<typeof postAutoKey>[0])
      expect(saveFailRes.status).toBe(500)
      expect(((await saveFailRes.json()) as { ok: boolean }).ok).toBe(false)
    } finally {
      db?.close()
      globalThis.fetch = originalFetch
      dns.lookup = originalLookup
      await closeServer(server)
      resetPersistence?.()
      if (prevDb === undefined) delete process.env.MEITHEAL_DB_URL
      else process.env.MEITHEAL_DB_URL = prevDb
      if (prevSup === undefined) delete process.env.SUPERVISOR_TOKEN
      else process.env.SUPERVISOR_TOKEN = prevSup
      if (dir) await rm(dir, { recursive: true, force: true })
    }
  })
})

test.describe("Webhook Config Parser", () => {
  test("parses valid config", () => {
    const result = parseWebhookConfig({
      webhooks: [
        {
          id: "sub-1",
          url: "https://example.com/hook",
          secret: "my-secret",
          events: ["task.created"],
          enabled: true,
        },
      ],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.subscribers).toHaveLength(1)
      expect(result.subscribers[0]!.id).toBe("sub-1")
    }
  })

  test("rejects private URL subscriber", () => {
    const result = parseWebhookConfig({
      webhooks: [
        {
          id: "bad",
          url: "http://127.0.0.1:3000/hook",
          secret: "s",
          events: ["task.created"],
        },
      ],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e: string) => e.includes("private"))).toBe(true)
    }
  })

  test("rejects missing required fields", () => {
    const result = parseWebhookConfig({ webhooks: [{}] })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(3)
    }
  })

  test("rejects non-array webhooks", () => {
    expect(parseWebhookConfig({ webhooks: "not-array" }).ok).toBe(false)
    expect(parseWebhookConfig(null).ok).toBe(false)
  })

  test("preserves enabled flag defaults and explicit false", () => {
    const result = parseWebhookConfig({
      webhooks: [
        {
          id: "sub-default",
          url: "https://example.com/hook1",
          secret: "s1",
          events: ["task.created"],
        },
        {
          id: "sub-disabled",
          url: "https://example.com/hook2",
          secret: "s2",
          events: ["task.completed"],
          enabled: false,
        },
      ],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.subscribers[0]?.enabled).toBe(true)
      expect(result.subscribers[1]?.enabled).toBe(false)
    }
  })
})
