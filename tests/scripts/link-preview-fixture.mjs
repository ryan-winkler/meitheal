import assert from "node:assert/strict"
import dns from "node:dns/promises"
import http from "node:http"
import net from "node:net"
import { once } from "node:events"
import { setTimeout } from "node:timers/promises"
import { gzipSync } from "node:zlib"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"

const publicName = "10.preview.example"
const publicAddress = { address: "93.184.216.34", family: 4 }

const upstream = http.createServer((request, response) => {
  process.send({ event: "upstream", path: request.url, host: request.headers.host })
  switch (request.url) {
    case "/article?q=kept":
      response.writeHead(200, { "content-type": "Text/HTML; charset=utf-8" })
      response.end(`<title>Fallback</title><meta content="Local &gt; public" property="og:title">
        <meta name="description" content="Readable preview">
        <meta property="og:image" content="https://assets.example/image.png">`)
      break
    case "/large":
      response.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" })
      response.end(gzipSync("<title>Early metadata</title>" + "<meta ".repeat(60_000) +
        '<meta property="og:title" content="Beyond the cap">'))
      break
    case "/redirect":
      response.writeHead(302, { "location": "http://127.0.0.1/unexpected" })
      response.end()
      break
    case "/non-html":
      response.writeHead(200, { "content-type": "application/json; variant=text/html" })
      response.end('{"title":"Not HTML"}')
      break
    case "/slow":
      response.writeHead(200, { "content-type": "text/html" })
      response.write("<title>Incomplete")
      break
    default:
      response.writeHead(404)
      response.end()
  }
})
upstream.listen(0, "127.0.0.1")
await once(upstream, "listening")
const upstreamPort = upstream.address().port

dns.lookup = async (hostname, options) => {
  assert.equal(options.all, true)
  process.send({ event: "dns", hostname })
  switch (hostname) {
    case publicName + ".":
      return [publicAddress]
    case "mixed.preview.example.":
      return [publicAddress, { address: "::ffff:7f00:1", family: 6 }]
    case "slow.preview.example.":
      await setTimeout(5_500)
      return [publicAddress]
    default:
      throw new Error("Unexpected DNS lookup in link preview fixture")
  }
}

const connect = net.connect
net.connect = options => {
  process.send({ event: "dial", hostname: options.host })
  assert.equal(options.host, publicName)
  assert.equal(Number(options.port), 8080)
  const resolve = (flags, expected) => options.lookup(publicName, flags, (error, address, family) => {
    assert.ifError(error)
    assert.deepEqual(address, expected)
    if (!flags.all) assert.equal(family, 4)
  })
  resolve({ all: true }, [publicAddress])
  resolve({ all: false, family: 4 }, publicAddress.address)
  options.lookup("other.preview.example", { all: true }, error => assert.ok(error))
  // This is the only permitted socket sink in the fixture.
  return connect({ ...options, host: "127.0.0.1", port: upstreamPort, lookup: undefined })
}

process.env.ASTRO_NODE_AUTOSTART = "disabled"
const { handler } = await import("../../apps/web/dist/server/entry.mjs")
const app = http.createServer((request, response) => {
  runWithIngressTransport({ peer: "127.0.0.1", fromSupervisor: false }, () => handler(request, response))
})
app.listen(0, "127.0.0.1", () => {
  process.send({ port: app.address().port })
})
