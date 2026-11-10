import { fork, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"
import { readWithinLimit } from "../../apps/web/src/lib/bounded-body"
import { isPublicPreviewAddress, previewHostname } from "../../apps/web/src/lib/link-preview-target"

test("only public unicast addresses pass the preview boundary", () => {
  for (const address of [
    "0.1.2.3", "10.2.3.4", "100.127.255.255", "127.0.0.1", "169.254.169.254", "172.31.1.1",
    "192.0.0.8", "192.0.2.1", "192.168.0.1", "198.19.1.1", "198.51.100.1", "203.0.113.1",
    "224.1.2.3", "240.0.0.1", "255.255.255.255",
  ]) expect(isPublicPreviewAddress(address, 4), address).toBe(false)

  for (const address of [
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:5db8:d822", "64:ff9b::a00:1",
    "fc00::1", "fd00::1", "febf::1", "ff00::1", "2001:0::1", "2001:db8::1",
    "2002:7f00:1::", "3fff::1", "2606:4700::1%eth0",
  ]) expect(isPublicPreviewAddress(address, 6), address).toBe(false)

  expect(isPublicPreviewAddress("93.184.216.34", 4)).toBe(true)
  expect(isPublicPreviewAddress("2606:4700:4700::1111", 6)).toBe(true)
  expect(isPublicPreviewAddress("2606:4700:4700::1111", 4)).toBe(false)
  expect(isPublicPreviewAddress("invalid", 0)).toBe(false)

  for (const url of [
    "http://2130706433/", "http://017700000001/", "http://0x7f000001/", "http://[::ffff:7f00:1]/",
    "http://server/", "http://server.local./", "http://device.home.arpa/", "http://user:secret@example.com/",
  ]) expect(previewHostname(new URL(url)), url).toBeUndefined()
  expect(previewHostname(new URL("https://10.example.com:8443/path?q=kept"))).toBe("10.example.com")
  expect(previewHostname(new URL("https://[2606:4700:4700::1111]/"))).toBe("2606:4700:4700::1111")
})

test("the byte reader cancels oversized and expired input", async () => {
  let excessCancelled = false
  const excess = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8))
      controller.enqueue(new Uint8Array(1))
    },
    cancel() { excessCancelled = true },
  })
  expect(await readWithinLimit(excess, 8)).toBeNull()
  expect(excessCancelled).toBe(true)

  let deadlineCancelled = false
  const slow = new ReadableStream<Uint8Array>({ cancel() { deadlineCancelled = true } })
  const controller = new AbortController()
  const read = readWithinLimit(slow, 8, controller.signal)
  controller.abort(new Error("deadline"))
  await expect(read).rejects.toThrow("deadline")
  expect(deadlineCancelled).toBe(true)
})

test("preview endpoint pins DNS, keeps public metadata, bounds streams and rejects redirects", async ({ playwright }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and its disposable fixture")
  const work = await mkdtemp(join(tmpdir(), "meitheal-preview-"))
  const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
  const fixture = fileURLToPath(new URL("../scripts/link-preview-fixture.mjs", import.meta.url))
  const api = await playwright.request.newContext()
  let child: ChildProcess | undefined

  try {
    const server = fork(fixture, {
      cwd: web,
      env: { PATH: process.env.PATH, NODE_ENV: "production", MEITHEAL_DB_URL: `file:${join(work, "meitheal.db")}` },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    })
    child = server
    const events: Array<{ event: string; hostname?: string; path?: string; host?: string }> = []
    server.on("message", (message: unknown) => {
      if (message && typeof message === "object" && "event" in message) events.push(message as (typeof events)[number])
    })
    const [info] = await Promise.race([
      once(server, "message", { signal: AbortSignal.timeout(10_000) }),
      once(server, "exit").then(([code]) => { throw new Error(`Preview fixture exited with ${code}`) }),
    ])
    const origin = `http://127.0.0.1:${info.port}`
    const endpoint = origin + "/api/unfurl"
    const preview = (data: unknown) => api.post(endpoint, { headers: { origin }, data })

    const firstUrl = "http://10.preview.example:8080/article?q=kept"
    const first = await preview({ url: firstUrl })
    expect(first.status()).toBe(200)
    expect(await first.json()).toMatchObject({
      url: firstUrl,
      title: "Local &gt; public",
      description: "Readable preview",
      image: "https://assets.example/image.png",
    })
    expect(events.filter(event => event.event === "dns")).toEqual([{ event: "dns", hostname: "10.preview.example." }])
    expect(events.find(event => event.event === "upstream")).toEqual({
      event: "upstream", path: "/article?q=kept", host: "10.preview.example:8080",
    })

    const large = await preview({ url: "http://10.preview.example:8080/large" })
    expect(large.status()).toBe(200)
    expect(await large.json()).toMatchObject({ title: "Early metadata" })
    expect((await preview({ url: "http://10.preview.example:8080/non-html" })).status()).toBe(415)
    expect((await preview({ url: "http://10.preview.example:8080/redirect" })).status()).toBe(400)

    const requestsBeforeDenials = events.filter(event => event.event === "dial").length
    for (const url of [
      "http://100.64.0.1/", "http://[::ffff:7f00:1]/", "http://mixed.preview.example/",
      "http://user:secret@10.preview.example:8080/", "http://hass.local/", ["http://10.preview.example:8080/"],
    ]) {
      expect((await preview({ url })).status(), JSON.stringify(url)).toBe(400)
    }
    expect((await preview({ url: firstUrl, filler: "x".repeat(17_000) })).status()).toBe(413)
    const chunkedStatus = await new Promise((resolve, reject) => {
      const request = httpRequest(endpoint, { method: "POST", headers: { origin, "content-type": "application/json" } }, response => {
        response.resume()
        resolve(response.statusCode)
      })
      request.on("error", reject)
      request.write('{"url":"http://10.preview.example:8080/","filler":"')
      request.write("x".repeat(17_000))
      request.end('"}')
    })
    expect(chunkedStatus).toBe(413)
    expect(events.filter(event => event.event === "dial")).toHaveLength(requestsBeforeDenials)

    const [slowDns, slowFetch] = await Promise.all([
      preview({ url: "http://slow.preview.example:8080/" }),
      preview({ url: "http://10.preview.example:8080/slow" }),
    ])
    expect(slowDns.status()).toBe(504)
    expect(slowFetch.status()).toBe(504)
    await setTimeout(600)
    expect(events.filter(event => event.event === "dial")).toHaveLength(requestsBeforeDenials + 1)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit")
      child.kill()
      await exited
    }
    await api.dispose()
    await rm(work, { recursive: true, force: true })
  }
})
