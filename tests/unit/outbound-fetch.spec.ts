import dns from "node:dns"
import { once } from "node:events"
import { statSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { assertOutboundUrl, fetchOutbound, isBlockedOutboundAddress, OutboundUrlError } from "../../packages/integration-core/src/outbound-fetch"
import { discoverCalendars, listCalDAVEvents, resolveCalDAVHref } from "../../apps/web/src/domains/calendar/caldav-client"
import { resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"
import { decryptCalDAVPassword, POST as saveCredentials } from "../../apps/web/src/pages/api/integrations/calendar/caldav-credentials"

type Handler = (request: IncomingMessage, response: ServerResponse) => void

async function listen(handler: Handler): Promise<{ server: Server, port: number }> {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return { server, port: (server.address() as AddressInfo).port }
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}

/** Resolve the given names to fixed addresses for the duration of fn. */
async function withResolver<T>(names: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const original = dns.lookup
  dns.lookup = ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    const address = names[hostname]
    if (!address) return callback(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }))
    const family = address.includes(":") ? 6 : 4
    if (options.all) callback(null, [{ address, family }])
    else callback(null, address, family)
  }) as typeof dns.lookup
  try {
    return await fn()
  } finally {
    dns.lookup = original
  }
}

test.describe("outbound policy", () => {
  test("blocks metadata, link-local, unspecified and multicast addresses in every spelling", () => {
    for (const address of [
      "169.254.169.254", "::ffff:169.254.169.254", "[::ffff:a9fe:a9fe]", "0.0.0.0", "0.1.2.3",
      "224.0.0.1", "255.255.255.255", "100.100.100.200", "::", "fe80::1", "ff02::1", "fd00:ec2::254",
    ]) expect(isBlockedOutboundAddress(address), address).toBe(true)
  })

  test("keeps the self-hosted targets integrations need", () => {
    for (const address of ["127.0.0.1", "::1", "10.0.0.5", "172.30.32.1", "192.168.1.20", "fd12:3456::1", "8.8.8.8", "2001:db8::1"]) {
      expect(isBlockedOutboundAddress(address), address).toBe(false)
    }
    expect(assertOutboundUrl("http://192.168.1.20:5678/webhook/x").hostname).toBe("192.168.1.20")
    expect(assertOutboundUrl("https://n8n.internal/webhook").hostname).toBe("n8n.internal")
  })

  test("rejects blocked hosts and schemes on the URL itself", () => {
    for (const url of [
      "ftp://example.com/", "file:///etc/passwd", "not a url",
      "http://169.254.169.254/latest/meta-data/", "http://2852039166/", "http://0xa9fea9fe/",
      "http://[::ffff:169.254.169.254]/", "http://metadata.google.internal/", "http://METADATA.google.internal./",
      "http://supervisor/core/api", "http://[fd00:ec2::254]/",
    ]) expect(() => assertOutboundUrl(url), url).toThrow(OutboundUrlError)
  })

  test("refuses a name that resolves to a blocked address at connect time", async () => {
    await withResolver({ "rebind.example": "169.254.169.254" }, async () => {
      const error = await fetchOutbound("http://rebind.example/").catch((err: unknown) => err)
      expect(error).toBeInstanceOf(TypeError)
      expect((error as TypeError).cause).toBeInstanceOf(OutboundUrlError)
    })
  })

  test("delivers to an allowed host and never follows a redirect implicitly", async () => {
    const { server, port } = await listen((request, response) => {
      if (request.url === "/redirect") response.writeHead(302, { location: "http://169.254.169.254/" }).end()
      else response.writeHead(204).end()
    })
    try {
      await withResolver({ "hooks.example": "127.0.0.1" }, async () => {
        expect((await fetchOutbound(`http://hooks.example:${port}/ok`, { method: "POST", body: "{}" })).status).toBe(204)
        await expect(fetchOutbound(`http://hooks.example:${port}/redirect`)).rejects.toThrow()
        const manual = await fetchOutbound(`http://hooks.example:${port}/redirect`, { redirect: "manual" })
        expect(manual.status).toBe(302)
      })
    } finally {
      await close(server)
    }
  })
})

test.describe("CalDAV origin pinning", () => {
  const multistatus = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/cal/</d:href><d:propstat><d:prop><d:displayname>cal</d:displayname><d:resourcetype><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>`

  test("hrefs from the server must stay on the configured origin", async () => {
    expect(resolveCalDAVHref("https://dav.example/user/", "/cal/").href).toBe("https://dav.example/cal/")
    expect(() => resolveCalDAVHref("https://dav.example/user/", "https://other.example/cal/")).toThrow(/another origin/)
    expect(() => resolveCalDAVHref("https://dav.example/user/", "//other.example/cal/")).toThrow(/another origin/)
    await expect(listCalDAVEvents({ url: "https://dav.example/", username: "u", password: "p" }, "https://other.example/cal/", new Date(), new Date()))
      .rejects.toThrow(/another origin/)
  })

  test("same-origin redirects are followed and cross-origin ones refused before credentials leave", async () => {
    const seenByOther: string[] = []
    const other = await listen((request, response) => {
      seenByOther.push(String(request.headers.authorization))
      response.writeHead(207).end(multistatus)
    })
    const seenAuth: string[] = []
    const dav = await listen((request, response) => {
      seenAuth.push(String(request.headers.authorization))
      if (request.url === "/moved/") response.writeHead(301, { location: "/dav/" }).end()
      else if (request.url === "/away/") response.writeHead(307, { location: `http://other.example:${other.port}/dav/` }).end()
      else if (request.url === "/loop/") response.writeHead(302, { location: "/loop/" }).end()
      else response.writeHead(207, { "content-type": "application/xml" }).end(multistatus)
    })
    try {
      await withResolver({ "dav.example": "127.0.0.1", "other.example": "127.0.0.1" }, async () => {
        const base = `http://dav.example:${dav.port}`
        const calendars = await discoverCalendars({ url: `${base}/moved/`, username: "u", password: "p" })
        expect(calendars.map(calendar => calendar.href)).toEqual(["/cal/"])
        expect(seenAuth).toHaveLength(2)

        await expect(discoverCalendars({ url: `${base}/away/`, username: "u", password: "p" })).rejects.toThrow(/another origin/)
        expect(seenByOther).toEqual([])

        await expect(discoverCalendars({ url: `${base}/loop/`, username: "u", password: "p" })).rejects.toThrow(/redirected more than 5 times/)
      })
    } finally {
      await close(dav.server)
      await close(other.server)
    }
  })
})

test.describe("CalDAV credential key", () => {
  test("without a Home Assistant token, a private per-install key replaces the built-in fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meitheal-caldav-key-"))
    const previous = Object.fromEntries(["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_TOKEN"].map(key => [key, process.env[key]]))
    delete process.env.SUPERVISOR_TOKEN
    delete process.env.HA_TOKEN
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
    resetPersistenceForTests()
    try {
      const response = await saveCredentials({ locals: { hassIsAdmin: true }, request: new Request("http://localhost/api/integrations/calendar/caldav-credentials", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "save", url: "https://dav.example/", username: "u", password: "s3cret" }),
      }) } as unknown as Parameters<typeof saveCredentials>[0])
      expect(response.status).toBe(200)

      const keyFile = join(directory, "caldav-credentials.key")
      expect(statSync(keyFile).mode & 0o777).toBe(0o600)

      const { getPersistenceClient } = await import("../../apps/web/src/domains/tasks/persistence/store")
      const row = await getPersistenceClient().execute("SELECT value FROM settings WHERE key = 'caldav_password_enc'")
      const stored = String(row.rows[0]!.value).replace(/^"|"$/g, "")
      expect(decryptCalDAVPassword(stored)).toBe("s3cret")

      // A ciphertext from another key is reported plainly, not as a crypto error.
      process.env.HA_TOKEN = "a-different-install"
      expect(() => decryptCalDAVPassword(stored)).toThrow(/enter it again/)
      getPersistenceClient().close()
    } finally {
      resetPersistenceForTests()
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(directory, { recursive: true, force: true })
    }
  })
})
