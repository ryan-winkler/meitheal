import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import zlib from "node:zlib"
import {
  attachResponsePerformanceHooks,
  resolveStaticCacheControl,
  selectResponseEncoding,
  shouldCompressResponse,
} from "../../apps/web/scripts/http-performance.mjs"
import { minifyInlineCss } from "../../apps/web/src/lib/minify-inline-css"
import { clientTranslationJson } from "../../apps/web/src/i18n/translations"

test("selectResponseEncoding prefers br over gzip and respects q=0", () => {
  assert.equal(selectResponseEncoding("gzip, deflate, br"), "br")
  assert.equal(selectResponseEncoding("gzip, deflate"), "gzip")
  assert.equal(selectResponseEncoding("br;q=0, gzip;q=0.8"), "gzip")
  assert.equal(selectResponseEncoding("br;q=0, gzip;q=0"), null)
  assert.equal(selectResponseEncoding("gzip;q=1.0, br;q=0.5"), "gzip")
  assert.equal(selectResponseEncoding(""), null)
  assert.equal(selectResponseEncoding(undefined), null)
})

test("resolveStaticCacheControl caches immutable _astro assets but never dynamic or sw routes", () => {
  assert.equal(
    resolveStaticCacheControl("/_astro/Layout.abc123.css"),
    "public, max-age=31536000, immutable",
  )
  assert.equal(resolveStaticCacheControl("/icon-192.png"), "public, max-age=86400")
  assert.equal(resolveStaticCacheControl("/vendor/hugerte/hugerte.min.js"), "public, max-age=86400")
  assert.equal(resolveStaticCacheControl("/sw.js"), null)
  assert.equal(resolveStaticCacheControl("/version.json"), null)
  assert.equal(resolveStaticCacheControl("/manifest.webmanifest"), null)
  assert.equal(resolveStaticCacheControl("/"), null)
  assert.equal(resolveStaticCacheControl("/api/tasks"), null)
})

test("shouldCompressResponse skips SSE, database export, HEAD, 304, binary, and tiny payloads", () => {
  assert.equal(
    shouldCompressResponse({
      method: "GET",
      statusCode: 200,
      pathname: "/",
      contentType: "text/html; charset=utf-8",
      contentEncoding: undefined,
      contentLength: 50_000,
    }),
    true,
  )
  assert.equal(
    shouldCompressResponse({
      method: "GET",
      statusCode: 200,
      pathname: "/api/sse",
      contentType: "text/event-stream",
      contentEncoding: undefined,
      contentLength: undefined,
    }),
    false,
  )
  assert.equal(
    shouldCompressResponse({
      method: "POST",
      statusCode: 200,
      pathname: "/api/export/database.sqlite",
      contentType: "application/octet-stream",
      contentEncoding: undefined,
      contentLength: 100_000,
    }),
    false,
  )
  assert.equal(
    shouldCompressResponse({
      method: "HEAD",
      statusCode: 200,
      pathname: "/",
      contentType: "text/html",
      contentEncoding: undefined,
      contentLength: 50_000,
    }),
    false,
  )
  assert.equal(
    shouldCompressResponse({
      method: "GET",
      statusCode: 200,
      pathname: "/api/health",
      contentType: "application/json",
      contentEncoding: undefined,
      contentLength: 256,
    }),
    false,
  )
})

test("attachResponsePerformanceHooks streams valid brotli & preserves private cache-control", async () => {
  const payload = "<html><body>" + "meitheal household tasks ".repeat(200) + "</body></html>"
  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0]
    attachResponsePerformanceHooks(req, res, pathname)
    if (pathname === "/private") {
      res.setHeader("cache-control", "private, no-store")
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(payload)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  assert(address && typeof address === "object")
  try {
    const res = await new Promise<{ headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const req = http.get(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/_astro/test.css",
          headers: { "accept-encoding": "gzip, br" },
        },
        (incoming) => {
          const chunks: Buffer[] = []
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
          incoming.on("end", () => resolve({ headers: incoming.headers, body: Buffer.concat(chunks) }))
        },
      )
      req.on("error", reject)
    })
    assert.equal(res.headers["content-encoding"], "br")
    assert.equal(res.headers["cache-control"], "public, max-age=31536000, immutable")
    assert.match(String(res.headers.vary ?? ""), /Accept-Encoding/i)
    assert.equal(zlib.brotliDecompressSync(res.body).toString("utf8"), payload)
    assert.ok(res.body.length < Buffer.byteLength(payload) / 4)

    const priv = await new Promise<{ headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.get(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/private",
          headers: { "accept-encoding": "gzip" },
        },
        (incoming) => {
          incoming.resume()
          incoming.on("end", () => resolve({ headers: incoming.headers }))
        },
      )
      req.on("error", reject)
    })
    assert.equal(priv.headers["cache-control"], "private, no-store")
    assert.equal(priv.headers["content-encoding"], "gzip")
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("minifyInlineCss strips comments and whitespace while preserving CSS rules", () => {
  const input = `
    /* header comment */
    .sidebar-row > .btn {
      color: var(--text-primary);
      padding: 4px 8px;
    }
  `
  assert.equal(minifyInlineCss(input), ".sidebar-row>.btn{color:var(--text-primary);padding:4px 8px}")
})

test("clientTranslationJson omits duplicate legacy en/ga wrapper subtrees while preserving hoisted keys", () => {
  const parsedEn = JSON.parse(clientTranslationJson.en) as Record<string, unknown>
  const parsedGa = JSON.parse(clientTranslationJson.ga) as Record<string, unknown>
  assert.equal("en" in parsedEn, false)
  assert.equal("ga" in parsedEn, false)
  assert.equal("en" in parsedGa, false)
  assert.equal("ga" in parsedGa, false)
  assert.ok(clientTranslationJson.en.length < 100_000)
})
