import { createCipheriv, randomBytes, scryptSync } from "node:crypto"
import dns from "node:dns"
import { once } from "node:events"
import { readdirSync, statSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import {
  assertOutboundUrl,
  createGuardedLookup,
  fetchOutbound,
  guardedLookup,
  isBlockedOutboundAddress,
  isPrivateOutboundAddress,
  OutboundUrlError,
} from "../../packages/integration-core/src/outbound-fetch"
import {
  discoverCalendars,
  listCalDAVEvents,
  resolveCalDAVHref,
  testConnection,
} from "../../apps/web/src/domains/calendar/caldav-client"
import { n8nFetch, extractBaseUrl, jsonResponse } from "../../apps/web/src/lib/n8n-fetch"
import {
  ensureSchema,
  getLocalDataDirectory,
  getPersistenceClient,
  resetPersistenceForTests,
} from "../../apps/web/src/domains/tasks/persistence/store"
import {
  decryptCalDAVPassword,
  POST as saveCredentials,
} from "../../apps/web/src/pages/api/integrations/calendar/caldav-credentials"

type Handler = (request: IncomingMessage, response: ServerResponse) => void

async function listen(handler: Handler): Promise<{ server: Server; port: number }> {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return { server, port: (server.address() as AddressInfo).port }
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

/** Resolve the given names to fixed addresses for the duration of fn. */
async function withResolver<T>(names: Record<string, string | string[]>, fn: () => Promise<T>): Promise<T> {
  const original = dns.lookup
  dns.lookup = ((
    hostname: string,
    options: dns.LookupOptions | ((...args: unknown[]) => void),
    callback?: (...args: unknown[]) => void,
  ) => {
    const cb = typeof options === "function" ? options : callback!
    const opts = typeof options === "function" ? {} : options
    const configured = names[hostname]
    if (configured === undefined) {
      return cb(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }))
    }
    const list = Array.isArray(configured) ? configured : [configured]
    const entries = list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))
    if (opts.all) cb(null, entries)
    else if (entries[0]) cb(null, entries[0].address, entries[0].family)
    else cb(null, [])
  }) as typeof dns.lookup
  try {
    return await fn()
  } finally {
    dns.lookup = original
  }
}

function encryptLegacyFallback(plaintext: string): string {
  const key = scryptSync("meitheal-dev-" + "fallback-key", "meitheal-caldav-salt", 32)
  const iv = randomBytes(16)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")
}

test.describe("outbound policy", () => {
  test("blocks metadata, Supervisor IP, link-local, unspecified and multicast addresses in every spelling", () => {
    for (const address of [
      "169.254.169.254",
      "::ffff:169.254.169.254",
      "::ffff:169.254.169.254%eth0",
      "[::ffff:a9fe:a9fe]",
      "[::ffff:0.0.0.1]",
      "[::ffff:0:169.254.169.254]",
      "[::ffff:0:127.0.0.1]",
      "[::ffff:0:8.8.8.8]",
      "[::169.254.169.254]",
      "[64:ff9b::169.254.169.254]",
      "[64:ff9b::0.0.0.1]",
      "[64:ff9b::1]",
      "[64:ff9b:1::169.254.169.254]",
      "[2001::1]",
      "[2002:a9fe:a9fe::1]",
      "172.30.32.2",
      "::ffff:172.30.32.2",
      "::ffff:172.30.32.2%eth0",
      "[::ffff:ac1e:2002]",
      "[::172.30.32.2]",
      "[64:ff9b::172.30.32.2]",
      "0.0.0.0",
      "[64:ff9b::0.0.0.0]",
      "0.1.2.3",
      "224.0.0.1",
      "255.255.255.255",
      "100.100.100.200",
      "::",
      "fe80::1",
      "fe80::1%eth0",
      "ff02::1",
      "fd00:ec2::254",
    ]) {
      expect(isBlockedOutboundAddress(address), address).toBe(true)
    }
    expect(isBlockedOutboundAddress("not-an-ip")).toBe(false)
    expect(isBlockedOutboundAddress("invalid:colon:host")).toBe(false)
    expect(isBlockedOutboundAddress("0xa9fea9fe")).toBe(true)
    expect(isBlockedOutboundAddress("2852039166")).toBe(true)
    expect(isBlockedOutboundAddress("169.254.43518")).toBe(true)
    expect(isPrivateOutboundAddress("127.0.0.2")).toBe(true)
    expect(isPrivateOutboundAddress("127.1")).toBe(true)
    expect(isPrivateOutboundAddress("0177.0.0.1")).toBe(true)
    expect(isPrivateOutboundAddress("2130706433")).toBe(true)
    expect(isPrivateOutboundAddress("[::ffff:127.0.0.1]")).toBe(true)
    expect(isPrivateOutboundAddress("[64:ff9b::192.168.1.5]")).toBe(true)
    expect(isPrivateOutboundAddress("8.8.8.8")).toBe(false)
    expect(isPrivateOutboundAddress("[64:ff9b::8.8.8.8]")).toBe(false)
  })

  test("keeps the self-hosted targets integrations need", () => {
    for (const address of [
      "127.0.0.1",
      "::1",
      "10.0.0.5",
      "172.30.32.1",
      "192.168.1.20",
      "fd12:3456::1",
      "8.8.8.8",
      "2001:db8::1",
    ]) {
      expect(isBlockedOutboundAddress(address), address).toBe(false)
    }
    expect(assertOutboundUrl("http://192.168.1.20:5678/webhook/x").hostname).toBe("192.168.1.20")
    expect(assertOutboundUrl("https://n8n.internal/webhook").hostname).toBe("n8n.internal")
  })

  test("rejects blocked hosts, Supervisor aliases, custom SUPERVISOR_URL, and bad schemes", async () => {
    for (const url of [
      "ftp://example.com/",
      "file:///etc/passwd",
      "not a url",
      "http://169.254.169.254/latest/meta-data/",
      "http://2852039166/",
      "http://0xa9fea9fe/",
      "http://[::ffff:169.254.169.254]/",
      "http://172.30.32.2/addons",
      "http://[::ffff:172.30.32.2]/addons",
      "http://metadata.google.internal/",
      "http://METADATA.google.internal./",
      "http://sub.metadata.internal/",
      "http://sub.instance-data/",
      "http://supervisor/core/api",
      "http://hassio/core/api",
      "http://core.hass.io/api",
      "http://[fd00:ec2::254]/",
      ["http://user", "secret@example.com/hook"].join(":"),
      "http://user@example.com/hook",
      "https://example.com../hook",
      "http://[64:ff9b::0.0.0.1]/",
    ]) {
      expect(() => assertOutboundUrl(url), url).toThrow(OutboundUrlError)
    }

    const prevSupervisorUrl = process.env.SUPERVISOR_URL
    process.env.SUPERVISOR_URL = "http://custom-supervisor.local:8123"
    try {
      expect(() => assertOutboundUrl("http://custom-supervisor.local/addons")).toThrow(OutboundUrlError)
      await withResolver({ "custom-supervisor.local": [] }, async () => {
        await expect(fetchOutbound("http://127.0.0.1:9999/")).rejects.toThrow(/SUPERVISOR_URL/)
      })
      const aborted = new AbortController()
      aborted.abort(new Error("aborted-before-dns"))
      await expect(fetchOutbound("http://127.0.0.1:9999/", { signal: aborted.signal })).rejects.toThrow(
        "aborted-before-dns",
      )
      process.env.SUPERVISOR_URL = "http://10.99.9.9:8123"
      expect(() => assertOutboundUrl("http://10.99.9.9/addons")).toThrow(OutboundUrlError)
    } finally {
      if (prevSupervisorUrl === undefined) delete process.env.SUPERVISOR_URL
      else process.env.SUPERVISOR_URL = prevSupervisorUrl
    }
  })

  test("refuses DNS rebinding to metadata and DNS aliases resolving to the Supervisor IP", async () => {
    await withResolver(
      {
        "rebind.example": "169.254.169.254",
        supervisor: "10.99.0.2",
        "supervisor-alias.example": "10.99.0.2",
        "empty.example": [],
      },
      async () => {
        const rebindErr = await fetchOutbound("http://rebind.example/").catch((err: unknown) => err)
        expect(rebindErr).toBeInstanceOf(TypeError)
        expect((rebindErr as TypeError).cause).toBeInstanceOf(OutboundUrlError)

        const aliasErr = await fetchOutbound("http://supervisor-alias.example/core/api").catch((err: unknown) => err)
        expect(aliasErr).toBeInstanceOf(TypeError)
        expect((aliasErr as TypeError).cause).toBeInstanceOf(OutboundUrlError)

        // Direct IP literals skip undici connect.lookup, so fetchOutbound checks resolved Supervisor IPs up front.
        await expect(fetchOutbound("http://10.99.0.2/core/api")).rejects.toThrow(OutboundUrlError)
        await expect(fetchOutbound("http://[::ffff:10.99.0.2]/core/api")).rejects.toThrow(OutboundUrlError)
        await expect(fetchOutbound("http://[64:ff9b::10.99.0.2]/core/api")).rejects.toThrow(OutboundUrlError)

        // allowPrivate: false rejects DNS rebinding to loopback/RFC1918 addresses at connect time.
        expect(() => assertOutboundUrl("http://localhost:8080/hook", { allowPrivate: false })).toThrow(OutboundUrlError)
        expect(() => assertOutboundUrl("http://127.0.0.1:8080/hook", { allowPrivate: false })).toThrow(OutboundUrlError)
      },
    )

    await withResolver({ "rebind-loopback.example": "127.0.0.1" }, async () => {
      const loopbackErr = await fetchOutbound("http://rebind-loopback.example/hook", {
        allowPrivate: false,
      }).catch((err: unknown) => err)
      expect(loopbackErr).toBeInstanceOf(TypeError)
      expect((loopbackErr as TypeError).cause).toBeInstanceOf(OutboundUrlError)
    })

    await withResolver(
      {
        supervisor: "10.99.0.2",
        "empty.example": [],
      },
      async () => {

        await new Promise<void>((resolve) => {
          guardedLookup("supervisor", (err) => {
            expect(err).toBeInstanceOf(OutboundUrlError)
            resolve()
          })
        })

        await new Promise<void>((resolve) => {
          guardedLookup("empty.example", { all: true }, (err) => {
            expect((err as NodeJS.ErrnoException)?.code).toBe("ENOTFOUND")
            resolve()
          })
        })

        await new Promise<void>((resolve) => {
          createGuardedLookup({ allowPrivate: false })("localhost", 4, (err) => {
            expect(err).toBeInstanceOf(OutboundUrlError)
            resolve()
          })
        })
      },
    )
  })

  test("delivers to an allowed host, enforces n8nFetch policy/timeout, and never follows redirects implicitly", async () => {
    const { server, port } = await listen((request, response) => {
      if (request.url === "/redirect") response.writeHead(302, { location: "http://169.254.169.254/" }).end()
      else if (request.url === "/slow") {
        setTimeout(() => response.writeHead(200).end("late"), 250)
      } else response.writeHead(204).end()
    })
    try {
      await withResolver({ "hooks.example": "127.0.0.1" }, async () => {
        expect((await fetchOutbound(`http://hooks.example:${port}/ok`, { method: "POST", body: "{}" })).status).toBe(204)
        await expect(fetchOutbound(`http://hooks.example:${port}/redirect`)).rejects.toThrow()
        const manual = await fetchOutbound(`http://hooks.example:${port}/redirect`, { redirect: "manual" })
        expect(manual.status).toBe(302)

        // n8nFetch shares the outbound policy and aborts on timeout
        expect(extractBaseUrl("https://n8n.internal:5678/webhook/abc")).toBe("https://n8n.internal:5678")
        expect(jsonResponse({ ok: true }, 201).status).toBe(201)
        expect((await n8nFetch(`http://hooks.example:${port}/ok`, { timeoutMs: 2000 })).status).toBe(204)
        await expect(n8nFetch("http://supervisor/core/api")).rejects.toThrow(OutboundUrlError)
        await expect(n8nFetch(`http://hooks.example:${port}/slow`, { timeoutMs: 40 })).rejects.toThrow()
      })
    } finally {
      await close(server)
    }
  })
})

test.describe("CalDAV origin pinning and protocol validation", () => {
  const multistatus = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/cal/</d:href><d:propstat><d:prop><d:displayname>cal</d:displayname><d:resourcetype><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>`

  test("rejects unsupported protocols in request helpers and cross-origin hrefs", async () => {
    const badProto = await testConnection({ url: "ftp://dav.example/", username: "u", password: "p" })
    expect(badProto.ok).toBe(false)
    expect(badProto.message).toContain("Only HTTP/HTTPS")

    await expect(discoverCalendars({ url: "ftp://dav.example/", username: "u", password: "p" })).rejects.toThrow(
      /Only HTTP\/HTTPS/,
    )

    expect(resolveCalDAVHref("https://dav.example/user/", "/cal/").href).toBe("https://dav.example/cal/")
    expect(() => resolveCalDAVHref("file:///tmp/a", "file:///tmp/b")).toThrow(/Only HTTP\/HTTPS/)
    expect(() => resolveCalDAVHref("https://dav.example/user/", "blob:https://dav.example/123")).toThrow(
      /Only HTTP\/HTTPS/,
    )
    expect(() =>
      resolveCalDAVHref("https://dav.example/user/", ["blob:https://user", "secret@dav.example/123"].join(":")),
    ).toThrow(/Only HTTP\/HTTPS/)
    expect(() => resolveCalDAVHref(["https://user", "pass@dav.example/user/"].join(":"), "/cal/")).toThrow(
      /embedded credentials/,
    )
    expect(() => resolveCalDAVHref("https://dav.example/user/", ["https://user", "pass@dav.example/cal/"].join(":"))).toThrow(
      /embedded credentials/,
    )
    expect(() => resolveCalDAVHref("https://dav.example/user/", "https://other.example/cal/")).toThrow(
      /another origin/,
    )
    expect(() => resolveCalDAVHref("https://dav.example/user/", "//other.example/cal/")).toThrow(/another origin/)
    await expect(
      listCalDAVEvents(
        { url: "https://dav.example/", username: "u", password: "p" },
        "https://other.example/cal/",
        new Date(),
        new Date(),
      ),
    ).rejects.toThrow(/another origin/)
  })

  test("same-origin redirects (301/303) are followed, cross-origin ones refused before credentials leave, and oversized responses aborted", async () => {
    const seenByOther: string[] = []
    const other = await listen((request, response) => {
      seenByOther.push(String(request.headers.authorization))
      response.writeHead(207).end(multistatus)
    })
    const seenMethods: string[] = []
    const dav = await listen((request, response) => {
      seenMethods.push(`${request.method}:${request.url}`)
      if (request.url === "/moved/") response.writeHead(301, { location: "/dav/" }).end()
      else if (request.url === "/see-other/") response.writeHead(303, { location: "/dav/" }).end()
      else if (request.url === "/away/") response.writeHead(307, { location: `http://other.example:${other.port}/dav/` }).end()
      else if (request.url === "/loop/") response.writeHead(302, { location: "/loop/" }).end()
      else if (request.url === "/huge/") {
        response.writeHead(207, { "content-type": "application/xml", "content-length": String(10 * 1024 * 1024) }).end()
      } else response.writeHead(207, { "content-type": "application/xml" }).end(multistatus)
    })
    try {
      await withResolver({ "dav.example": "127.0.0.1", "other.example": "127.0.0.1" }, async () => {
        const base = `http://dav.example:${dav.port}`
        const calendars = await discoverCalendars({ url: `${base}/moved/`, username: "u", password: "p" })
        expect(calendars.map((calendar) => calendar.href)).toEqual(["/cal/"])
        expect(seenMethods).toEqual(["PROPFIND:/moved/", "PROPFIND:/dav/"])

        seenMethods.length = 0
        const after303 = await discoverCalendars({ url: `${base}/see-other/`, username: "u", password: "p" })
        expect(after303.map((calendar) => calendar.href)).toEqual(["/cal/"])
        expect(seenMethods).toEqual(["PROPFIND:/see-other/", "GET:/dav/"])

        await expect(discoverCalendars({ url: `${base}/away/`, username: "u", password: "p" })).rejects.toThrow(
          /another origin/,
        )
        expect(seenByOther).toEqual([])

        await expect(discoverCalendars({ url: `${base}/loop/`, username: "u", password: "p" })).rejects.toThrow(
          /redirected more than 5 times/,
        )
        await expect(discoverCalendars({ url: `${base}/huge/`, username: "u", password: "p" })).rejects.toThrow(
          /response too large/,
        )
      })
    } finally {
      await close(dav.server)
      await close(other.server)
    }
  })
})

test.describe("CalDAV credential key initialization and legacy migration", () => {
  test("atomically initializes a 0600 per-install key under concurrency without overwriting or leaving temp files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meitheal-caldav-key-"))
    const previous = Object.fromEntries(
      ["MEITHEAL_DATA_DIR", "MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_TOKEN"].map((key) => [key, process.env[key]]),
    )
    delete process.env.MEITHEAL_DATA_DIR
    delete process.env.SUPERVISOR_TOKEN
    delete process.env.HA_TOKEN
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
    resetPersistenceForTests()
    try {
      expect(getLocalDataDirectory()).toBe(directory)

      // Concurrent saves race on first key initialization and must converge on one 0600 key file
      const responses = await Promise.all(
        Array.from({ length: 5 }, (_, idx) =>
          saveCredentials({
            locals: { hassIsAdmin: true },
            request: new Request("http://localhost/api/integrations/calendar/caldav-credentials", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                action: "save",
                url: "https://dav.example/",
                username: "u",
                password: `s3cret-${idx}`,
              }),
            }),
          } as unknown as Parameters<typeof saveCredentials>[0]),
        ),
      )
      for (const response of responses) {
        expect(response.status).toBe(200)
      }

      const keyFile = join(directory, "caldav-credentials.key")
      expect(statSync(keyFile).mode & 0o777).toBe(0o600)
      const leftoverTmp = readdirSync(directory).filter((name) => name.includes(".tmp"))
      expect(leftoverTmp).toEqual([])

      const row = await getPersistenceClient().execute("SELECT value FROM settings WHERE key = 'caldav_password_enc'")
      const stored = String(row.rows[0]!.value)
      expect(stored.startsWith('"')).toBe(false)
      expect(decryptCalDAVPassword(stored)).toMatch(/^s3cret-\d$/)
      expect(() => decryptCalDAVPassword("c2hvcnQ=")).toThrow(/enter it again/)

      // A ciphertext from another key is reported plainly, not as a crypto error.
      process.env.HA_TOKEN = "a-different-install"
      expect(() => decryptCalDAVPassword(stored)).toThrow(/enter it again/)

      // Corrupt key file is rejected explicitly; in-memory DB has no local data directory.
      delete process.env.HA_TOKEN
      writeFileSync(keyFile, "not-valid-hex", { mode: 0o600 })
      expect(() => decryptCalDAVPassword(stored)).toThrow(/32-byte hex key/)

      process.env.MEITHEAL_DB_URL = "file::memory:"
      expect(getLocalDataDirectory()).toBeNull()
      process.env.MEITHEAL_DB_URL = "file:memdb?mode=memory&cache=shared"
      expect(getLocalDataDirectory()).toBeNull()
      process.env.MEITHEAL_DB_URL = "file://otherhost/tmp/tasks.db"
      expect(getLocalDataDirectory()).toBeNull()
      process.env.MEITHEAL_DB_URL = `FILE://localhost${encodeURI(join(directory, "my dir", "tasks.db"))}?mode=rwc#frag`
      expect(getLocalDataDirectory()).toBe(join(directory, "my dir"))
      process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}?mode=rwc`
      expect(getLocalDataDirectory()).toBe(directory)
      process.env.MEITHEAL_DB_URL = "file::memory:"
      expect(() => decryptCalDAVPassword(stored)).toThrow(/local database directory/)

      const remoteKeyDir = join(directory, "remote-key-dir")
      process.env.MEITHEAL_DATA_DIR = remoteKeyDir
      expect(() => decryptCalDAVPassword(stored)).toThrow(/enter it again/)
      expect(statSync(join(remoteKeyDir, "caldav-credentials.key")).mode & 0o777).toBe(0o600)
      delete process.env.MEITHEAL_DATA_DIR

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

  test("migrates pre-0.0.2 legacy fallback credentials in-place to the per-install key on first read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meitheal-caldav-legacy-"))
    const previous = Object.fromEntries(
      ["MEITHEAL_DATA_DIR", "MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_TOKEN"].map((key) => [key, process.env[key]]),
    )
    delete process.env.MEITHEAL_DATA_DIR
    delete process.env.SUPERVISOR_TOKEN
    delete process.env.HA_TOKEN
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
    resetPersistenceForTests()
    try {
      await ensureSchema()
      const db = getPersistenceClient()
      await db.execute(
        "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
      )
      const legacyCiphertext = encryptLegacyFallback("upgraded-caldav-pass")
      await db.execute({
        sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
        args: ["caldav_password_enc", legacyCiphertext, Date.now()],
      })

      // First read decrypts the legacy ciphertext, creates caldav-credentials.key, and re-encrypts raw base64 in SQLite.
      expect(decryptCalDAVPassword(legacyCiphertext)).toBe("upgraded-caldav-pass")

      await expect
        .poll(async () => {
          const row = await db.execute("SELECT value FROM settings WHERE key = 'caldav_password_enc'")
          return String(row.rows[0]!.value)
        })
        .not.toBe(legacyCiphertext)

      const migratedRow = await db.execute("SELECT value FROM settings WHERE key = 'caldav_password_enc'")
      const migratedCiphertext = String(migratedRow.rows[0]!.value)
      expect(migratedCiphertext.startsWith('"')).toBe(false)
      expect(decryptCalDAVPassword(migratedCiphertext)).toBe("upgraded-caldav-pass")

      db.close()
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
